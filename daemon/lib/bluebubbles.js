// The daemon's whole BlueBubbles seam: the REST client, the Socket.IO
// session, contact resolution, and normalization from BlueBubbles' shapes
// into the daemon-protocol Chat/Message objects.
//
// Verified against the BlueBubbles Postman collection
// (documenter.gw.postman.com/api/collections/765844/UV5RnfwM) and the
// bluebubbles-server source (github.com/BlueBubblesApp/bluebubbles-server):
// - Response envelope is {status, message, data}.
// - Auth is a `password` (or `guid`/`token`) query param, checked in
//   packages/server/src/server/api/http/api/v1/middleware/authMiddleware.ts.
// - POST /api/v1/chat/query body: {limit, offset, with, sort}; chats come
//   back with `participants` (address, service) by default and a
//   `lastMessage` object when `with` includes "lastMessage"
//   (chatInterface.ts).
// - GET /api/v1/chat/:guid/message returns messages with `chats` embedded by
//   default (DEFAULT_MESSAGE_CONFIG.includeChats = true in
//   api/serializers/constants.ts), each message shaped like
//   {guid, text, handle: {address}, chats: [...], attachments: [], isFromMe,
//   dateCreated} where dateCreated is already unix milliseconds. Attachments
//   are only populated when the query carries `with=attachment`
//   (chatRouter.ts getMessages: withAttachments); verified against the real
//   server that omitting it yields no attachments on any message.
// - POST /api/v1/message/text body: {chatGuid, tempGuid, message, method};
//   the server defaults `method` to "apple-script" when omitted
//   (api/interfaces/messageInterface.ts), which is also the safer default
//   (no Private API / SIP setup required), so that's this daemon's default.
// - GET /api/v1/attachment/:guid/download streams the file's raw bytes (no
//   JSON envelope). Unless `original=true`, convertImage always runs first
//   (attachmentRouter.ts download), so HEIC comes back as a decodable format
//   even with no other params; `width`/`height`/`quality` additionally
//   resize, and any resized output is re-encoded as PNG ("all resized images
//   are PNGs"). So: thumbnail = width param, full size = no params, and
//   never `original=true`. An unknown guid is a 404 with the standard JSON
//   error envelope.
// - GET /api/v1/contact returns contacts already normalized to
//   {phoneNumbers:[{address,id}], emails:[{address,id}], displayName, ...}
//   (api/interfaces/contactInterface.ts, ContactInterface.mapContacts); see
//   lib/contacts.js for the address-matching algorithm this mirrors.
//
// chat/query's own `sort`/paging is not trustworthy: verified read-only
// against the real server that a merged SMS/iMessage chat (guid style
// `any;-;+1...`) with the account's newest lastMessage is entirely absent
// from a limit-200 page (under both sort=lastmessage and no sort), while it
// appears at limit 1000. The daemon therefore fetches every chat via
// pagination and does its own ranking (Store.chatList) rather than trusting
// any server-side top-N cut.

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { io } from 'socket.io-client'

import { ContactIndex, EMPTY_CONTACT_INDEX } from './contacts.js'
import { logger } from './logger.js'

const CHAT_PAGE_SIZE = Number(process.env.OMAIMSG_CHAT_PAGE_SIZE) || 200
const CHAT_FETCH_CAP = 2000
// Thumbnail width for image downloads: enough for a crisp panel bubble on a
// hidpi screen, while keeping multi-MB camera originals off disk. Wrong if
// the panel ever grows a full-size image viewer, which should fetch the
// original instead.
const ATTACHMENT_IMAGE_WIDTH = 1024

// Both transports plus the contact index behind one interface: callers get
// protocol-shaped Chat/Message objects and a connection state, never a
// BlueBubbles payload.
export class BlueBubblesSession {
  constructor(config) {
    this.config = config
    this.client = new BlueBubblesClient(config)
    this.contacts = EMPTY_CONTACT_INDEX
    this.socket = null
    this.onConnection = () => {}
    this.onMessage = () => {}
  }

  start() {
    this.socket = io(this.config.serverUrl, {
      query: { password: this.config.password },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000
    })

    this.socket.on('connect', () => {
      logger.info('bluebubbles: connected')
      this.onConnection('connected', '')
      this._refreshContacts()
    })

    this.socket.on('disconnect', (reason) => {
      logger.warn('bluebubbles: disconnected', { reason })
      if (reason === 'io server disconnect') {
        // The server only disconnects a socket itself on auth failure
        // (authMiddleware-equivalent check in httpService/index.ts); it will
        // not retry on its own.
        this.onConnection('error', 'BlueBubbles rejected the password')
      } else {
        this.onConnection('connecting', reason)
      }
    })

    this.socket.on('connect_error', (err) => {
      logger.warn('bluebubbles: connect_error', { err: err.message })
      this.onConnection('connecting', err.message)
    })

    // BlueBubbles emits "new-message" for both inbound iMessages and the echo
    // of a message this daemon just sent (chats embedded on the payload).
    this.socket.on('new-message', (payload) => {
      const bbChat = embeddedChat(payload)
      if (!bbChat?.guid) {
        logger.warn('bluebubbles: new-message with no embedded chat, dropping')
        return
      }
      this.onMessage({
        chatGuid: bbChat.guid,
        chat: normalizeChat(bbChat, this.contacts),
        message: normalizeMessage(payload, this.contacts)
      })
    })
  }

  close() {
    this.socket?.close()
  }

  async chats() {
    return this.client.queryAllChats(this.contacts)
  }

  async messages(chatGuid, limit) {
    return this.client.getChatMessages(chatGuid, limit, this.contacts)
  }

  async sendText({ chatGuid, text, tempGuid }) {
    return this.client.sendText({ chatGuid, text, tempGuid })
  }

  async downloadAttachment(guid, filePath, opts) {
    return this.client.downloadAttachment(guid, filePath, opts)
  }

  async _refreshContacts() {
    try {
      const contacts = await this.client.getContacts()
      this.contacts = ContactIndex.fromContacts(contacts)
      logger.info('bluebubbles: contacts loaded', { contacts: contacts.length })
    } catch (err) {
      logger.warn('bluebubbles: contacts fetch failed', { err: err.message })
    }
  }
}

class BlueBubblesClient {
  constructor({ serverUrl, password, method }) {
    this.serverUrl = serverUrl
    this.password = password
    this.method = method
  }

  async _request(path, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(this.serverUrl + path)
    url.searchParams.set('password', this.password)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })

    if (res.status === 401) throw new Error('BlueBubbles rejected the password (401)')

    const envelope = await res.json()
    if (!res.ok || envelope.status >= 300) {
      throw new Error(envelope.message || envelope.error?.error || `request failed (${res.status})`)
    }
    return envelope.data
  }

  // Pages through every chat rather than asking BlueBubbles for a top-N
  // slice (see header note on why that slice can silently drop chats). The
  // client-requested display limit is applied later, after Store re-sorts
  // the full set.
  async queryAllChats(contactIndex = EMPTY_CONTACT_INDEX) {
    const all = []
    let offset = 0
    while (true) {
      const page = await this._request('/api/v1/chat/query', {
        method: 'POST',
        body: { limit: CHAT_PAGE_SIZE, offset, with: ['lastMessage'], sort: 'lastmessage' }
      })
      all.push(...page)
      if (page.length < CHAT_PAGE_SIZE || all.length >= CHAT_FETCH_CAP) break
      offset += CHAT_PAGE_SIZE
    }
    return all.slice(0, CHAT_FETCH_CAP).map((chat) => normalizeChat(chat, contactIndex))
  }

  async getChatMessages(chatGuid, limit, contactIndex = EMPTY_CONTACT_INDEX) {
    // Newest-first from the server; the protocol wants oldest-first.
    const data = await this._request(`/api/v1/chat/${encodeURIComponent(chatGuid)}/message`, {
      query: { limit, sort: 'DESC', with: 'attachment' }
    })
    return data.map((message) => normalizeMessage(message, contactIndex)).reverse()
  }

  async sendText({ chatGuid, text, tempGuid }) {
    const data = await this._request('/api/v1/message/text', {
      method: 'POST',
      body: { chatGuid, tempGuid, message: text, method: this.method }
    })
    // Own send: always fromMe, so sender is '' regardless of contact index.
    return normalizeMessage(data)
  }

  async getContacts() {
    return this._request('/api/v1/contact')
  }

  // Downloads straight to disk via a .part rename, so a crash mid-write can
  // never leave a truncated file that the guid-keyed cache then trusts forever.
  async downloadAttachment(guid, filePath, { thumbnail = true } = {}) {
    const url = new URL(`${this.serverUrl}/api/v1/attachment/${encodeURIComponent(guid)}/download`)
    url.searchParams.set('password', this.password)
    if (thumbnail) url.searchParams.set('width', String(ATTACHMENT_IMAGE_WIDTH))

    const res = await fetch(url)
    if (res.status === 401) throw new Error('BlueBubbles rejected the password (401)')
    if (!res.ok) {
      let message = `attachment download failed (${res.status})`
      try {
        const envelope = await res.json()
        message = envelope.error?.error || envelope.message || message
      } catch {
        // Error body wasn't the JSON envelope; keep the status-code message.
      }
      throw new Error(message)
    }

    const bytes = Buffer.from(await res.arrayBuffer())
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(`${filePath}.part`, bytes)
    await rename(`${filePath}.part`, filePath)
  }
}

// An unnamed group renders like Messages.app: participant first names joined
// ("Maya, Sam & Alex", "+2" past three), never a single member's name.
function chatName(bbChat, contactIndex) {
  if (bbChat.displayName) return bbChat.displayName
  const participants = bbChat.participants || []
  const names = participants.map((p) => {
    const resolved = contactIndex.resolve(p.address)
    return resolved ? resolved.split(' ')[0] : p.address
  })
  if (names.length === 0) return ''
  if (names.length === 1) return contactIndex.resolve(participants[0].address) || names[0]
  const shown = names.slice(0, 3)
  const extra = names.length - shown.length
  const joined = shown.length === 2
    ? shown.join(' & ')
    : shown.slice(0, -1).join(', ') + ' & ' + shown[shown.length - 1]
  return extra > 0 ? joined + ' +' + extra : joined
}

function normalizeChat(bbChat, contactIndex = EMPTY_CONTACT_INDEX) {
  return {
    guid: bbChat.guid,
    name: chatName(bbChat, contactIndex),
    isGroup: (bbChat.participants?.length || 0) > 1,
    lastMessage: bbChat.lastMessage ? normalizeLastMessage(bbChat.lastMessage) : null,
    unread: 0
  }
}

function normalizeLastMessage(bbMessage) {
  const { text, ts, fromMe } = normalizeMessage(bbMessage)
  return { text, ts, fromMe }
}

function messageText(bbMessage) {
  const text = (bbMessage.text || '').trim()
  if (text) return text
  if (bbMessage.attachments?.length) return '[attachment]'
  return ''
}

function normalizeMessage(bbMessage, contactIndex = EMPTY_CONTACT_INDEX) {
  const rawSender = bbMessage.handle?.address || ''
  const attachments = (bbMessage.attachments || []).map((a) => ({
    guid: a.guid,
    mime: a.mimeType || '',
    name: a.transferName || ''
  }))
  return {
    guid: bbMessage.guid,
    text: messageText(bbMessage),
    ts: bbMessage.dateCreated ?? bbMessage.dateDelivered ?? Date.now(),
    fromMe: !!bbMessage.isFromMe,
    sender: bbMessage.isFromMe ? '' : (contactIndex.resolve(rawSender) || rawSender),
    ...(attachments.length ? { attachments } : {}),
    // Only the socket echo of a just-sent message carries tempGuid; a plain
    // REST fetch never does, so tempId is omitted rather than "".
    ...(bbMessage.tempGuid ? { tempId: bbMessage.tempGuid } : {})
  }
}

// The chat a `new-message` socket push belongs to is embedded on the message
// itself, because BlueBubbles serializes messages with includeChats on.
function embeddedChat(bbMessage) {
  return bbMessage.chats?.[0]
}
