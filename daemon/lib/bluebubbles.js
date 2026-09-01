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
//   dateCreated} where dateCreated is already unix milliseconds. Its `before`
//   query param (and `/api/v1/message/query`'s body field of the same name) is
//   unix milliseconds too, and both compile to `message.date <= :before` --
//   INCLUSIVE (MessageRepository.applyMessageDateQuery in
//   databases/imessage/index.ts). There is no exclusive form, and decrementing
//   the cursor to fake one would make a message sharing that millisecond
//   unreachable forever, so the boundary is left to the caller to dedupe.
//   `limit` is applied after that filter, so a DESC page is the newest N at or
//   before the cutoff. Attachments
//   are only populated when the query carries `with=attachment`
//   (chatRouter.ts getMessages: withAttachments); verified against the real
//   server that omitting it yields no attachments on any message.
// - POST /api/v1/message/attachment is multipart rather than JSON: an
//   `attachment` file part plus `chatGuid`, `tempGuid`, `name` and `method`
//   fields, and exactly one attachment per request, so several files are
//   several sends. The echo it produces is stamped with tempGuid the same way
//   a text send's is.
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
// Guids remembered for the duplicate-echo drop. Large enough that the two
// copies of one send can never be separated by that many other messages;
// small enough that a long-lived daemon's set stays trivial.
const SEEN_MESSAGE_GUIDS = 500
// How far back a seed scan reads to find the end of a chat's unread run. Past
// this the run is reported as the scan length: a chat nobody has touched in a
// hundred messages is already saying "lots".
export const UNREAD_SCAN_LIMIT = 100
// Content type for an outgoing attachment's multipart part, by extension.
// BlueBubbles echoes a mimeType back and the panel decides what to render from
// it, so a part sent with no type returns as octet-stream and the image the
// user just sent renders as "[attachment]" instead of as a picture. Keyed to
// the extensions the panel's picker offers.
const ATTACHMENT_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

function attachmentMime(name) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return ATTACHMENT_MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || 'application/octet-stream'
}

// Both transports plus the contact index behind one interface: callers get
// protocol-shaped Chat/Message objects and a connection state, never a
// BlueBubbles payload.
export class BlueBubblesSession {
  constructor(config) {
    this.config = config
    this.client = new BlueBubblesClient(config)
    this.contacts = EMPTY_CONTACT_INDEX
    this.socket = null
    this.soloParticipants = new Map()
    this.onConnection = () => {}
    this.onMessage = () => {}
    this.onChatRead = () => {}
    this.seenMessageGuids = new Set()
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
    // chat.db's own read boundary, polled by the server's ChatUpdatePoller and
    // emitted whenever it moves -- which is what reading a chat on the phone
    // does. Receiving it needs no Private API; only writing read state back to
    // the Mac would.
    this.socket.on('chat-read-status-changed', (payload) => {
      const guid = payload?.guid || embeddedChat(payload)?.guid
      if (!guid) {
        logger.warn('bluebubbles: chat-read-status-changed with no chat guid, dropping')
        return
      }
      this.onChatRead(guid)
    })

    this.socket.on('new-message', (payload) => {
      const bbChat = embeddedChat(payload)
      if (!bbChat?.guid) {
        logger.warn('bluebubbles: new-message with no embedded chat, dropping')
        return
      }
      if (this._alreadySeen(payload.guid)) {
        logger.debug('bluebubbles: duplicate new-message dropped', { guid: payload.guid })
        return
      }
      this.onMessage({
        chatGuid: bbChat.guid,
        chat: normalizeChat(bbChat, this.contacts),
        message: normalizeMessage(payload, this.contacts)
      })
    })
  }

  // An outbound send arrives as two "new-message" events with one guid: the
  // first stamped with tempGuid, the second bare (verified against a real
  // server). Forwarding both shows the text twice in the panel and would
  // double-count unread, so the first copy wins and later ones are dropped.
  _alreadySeen(guid) {
    if (!guid) return false
    if (this.seenMessageGuids.has(guid)) return true
    this.seenMessageGuids.add(guid)
    while (this.seenMessageGuids.size > SEEN_MESSAGE_GUIDS)
      this.seenMessageGuids.delete(this.seenMessageGuids.values().next().value)
    return false
  }

  close() {
    this.socket?.close()
  }

  async chats() {
    const raw = await this.client.queryAllChatsRaw()
    this.soloParticipants.clear()
    for (const chat of raw) {
      const participants = chat.participants || []
      if (participants.length === 1) this.soloParticipants.set(chat.guid, participants[0].address)
    }
    return raw.map((chat) => normalizeChat(chat, this.contacts))
  }

  async unreadRuns() {
    return this.client.unreadRuns()
  }

  // chat.db can hold messages with no chat link at all, and every chat-scoped
  // route on the server inner-joins chats ("Inner-join because all messages
  // will have a chat", MessageRepository.getMessages), so those threads read as
  // empty. Measured on a real account: 11 of 40 such chats have their messages
  // recoverable by asking for the participant's handle instead. Only 1:1 chats
  // can be recovered this way -- a handle cannot stand in for a group's chat.
  // `beforeTs` pages backwards: omitted asks for the newest page, set asks for
  // the page ending at that unix-ms point, which includes the point itself.
  async messages(chatGuid, limit, beforeTs) {
    const messages = await this.client.getChatMessages(chatGuid, limit, this.contacts, beforeTs)
    if (messages.length) return messages
    const address = this.soloParticipants.get(chatGuid)
    if (!address) return messages
    return this.client.getMessagesByHandle(address, limit, this.contacts, beforeTs)
  }

  async sendText({ chatGuid, text, tempGuid }) {
    return this.client.sendText({ chatGuid, text, tempGuid })
  }

  async sendAttachment({ chatGuid, bytes, name, tempGuid }) {
    return this.client.sendAttachment({ chatGuid, bytes, name, tempGuid })
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

  async _request(path, { method = 'GET', query = {}, body, form } = {}) {
    const url = new URL(this.serverUrl + path)
    url.searchParams.set('password', this.password)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const res = await fetch(url, {
      method,
      // A FormData body sets its own multipart content-type, boundary and all,
      // so naming one here would break the part the server reads.
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: form || (body ? JSON.stringify(body) : undefined)
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
  async queryAllChatsRaw() {
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
    return all.slice(0, CHAT_FETCH_CAP)
  }

  // Two signals, both unreliable, and neither trusted alone. Measured against
  // a real account on 2026-09-01:
  //
  // - A message's `dateRead` under-reports. Reading a chat on an iPhone does
  //   not stamp it on the Mac's copy of an inbound message, so a chat read on
  //   a phone reads as unread forever. It is also trustworthy only per chat: a
  //   chat that has never recorded a read on any inbound message never tracked
  //   read state at all, so a missing dateRead there says nothing (27 of 38
  //   candidate chats, mostly one-message threads years old).
  // - `properties[0].lastSeenMessageGuid` over-reports. It is the last message
  //   the MAC has been shown, and it syncs from a phone only sometimes: taking
  //   it as the boundary turned 2 unread chats into 19, with two group chats
  //   claiming 51 and 62. Only about a quarter of chats carry it at all.
  //
  // So dateRead decides which chats are unread and the boundary may only ever
  // shorten the answer, never create one. That is what fixes the case both the
  // report and the fixtures are built on -- a chat the Mac has seen through its
  // newest message, whose tail it never stamped -- without inventing a badge
  // full of conversations nobody has failed to read.
  //
  // The boundary guid is resolved against the messages actually fetched rather
  // than compared with `lastMessage.guid`: chat/query's lastMessage is not
  // reliably the newest one (measured: it returned the third-newest for a chat
  // whose newest three landed in the same second), and this file already
  // refuses to trust that route's ranking.
  //
  // Returns the timestamps of each chat's trailing unread messages, not a
  // count, so the caller can re-derive a count against a read boundary of its
  // own without asking the server again.
  async unreadRuns() {
    const runs = {}
    for (const chat of await this.queryAllChatsRaw()) {
      const last = chat.lastMessage
      if (!last || last.isFromMe || last.dateRead) continue
      const messages = await this._request(`/api/v1/chat/${encodeURIComponent(chat.guid)}/message`, {
        query: { limit: UNREAD_SCAN_LIMIT, sort: 'DESC' }
      })
      let run = runBeforeFirstRead(messages)
      const boundaryGuid = chat.properties?.[0]?.lastSeenMessageGuid
      // Both runs start at the newest message, so the shorter prefix is the
      // one the two signals agree on.
      if (boundaryGuid) run = run.slice(0, countAfterBoundary(messages, boundaryGuid))
      if (run.length) runs[chat.guid] = run
    }
    return runs
  }

  async getChatMessages(chatGuid, limit, contactIndex = EMPTY_CONTACT_INDEX, beforeTs) {
    // Newest-first from the server; the protocol wants oldest-first.
    const data = await this._request(`/api/v1/chat/${encodeURIComponent(chatGuid)}/message`, {
      query: { limit, sort: 'DESC', with: 'attachment', before: beforeTs }
    })
    return data.map((message) => normalizeMessage(message, contactIndex)).reverse()
  }

  // No chat relation requested, deliberately: asking for it makes the server
  // inner-join chats, which is exactly what hides an unlinked message. The
  // handle table's address column is `id` in chat.db, not `address`.
  async getMessagesByHandle(address, limit, contactIndex = EMPTY_CONTACT_INDEX, beforeTs) {
    const data = await this._request('/api/v1/message/query', {
      method: 'POST',
      body: {
        limit,
        sort: 'DESC',
        before: beforeTs,
        where: [{ statement: 'handle.id = :address', args: { address } }]
      }
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

  async sendAttachment({ chatGuid, bytes, name, tempGuid }) {
    const form = new FormData()
    form.append('attachment', new Blob([bytes], { type: attachmentMime(name) }), name)
    form.append('chatGuid', chatGuid)
    form.append('tempGuid', tempGuid)
    form.append('name', name)
    form.append('method', this.method)
    return normalizeMessage(await this._request('/api/v1/message/attachment', { method: 'POST', form }))
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

// Stands in for a message whose only content is attachments, so a preview or a
// non-image attachment renders something. lib/notify.js recognises it to say
// something readable in a toast instead.
export const ATTACHMENT_PLACEHOLDER = '[attachment]'

function messageText(bbMessage) {
  const text = (bbMessage.text || '').trim()
  if (text) return text
  if (bbMessage.attachments?.length) return ATTACHMENT_PLACEHOLDER
  return ''
}

function normalizeMessage(bbMessage, contactIndex = EMPTY_CONTACT_INDEX) {
  const rawSender = bbMessage.handle?.address || ''
  const attachments = (bbMessage.attachments || []).map((a) => ({
    guid: a.guid,
    mime: a.mimeType || '',
    name: a.transferName || '',
    // Only when both are usable: the UI reserves a box from the ratio, and a
    // zero or a missing side would have it reserve nothing. Verified present on
    // a real server's attachment objects alongside uti/mimeType/transferName.
    ...(a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : {})
  }))
  return {
    guid: bbMessage.guid,
    text: messageText(bbMessage),
    ts: messageTs(bbMessage),
    fromMe: !!bbMessage.isFromMe,
    sender: bbMessage.isFromMe ? '' : (contactIndex.resolve(rawSender) || rawSender),
    ...(attachments.length ? { attachments } : {}),
    // Only the socket echo of a just-sent message carries tempGuid; a plain
    // REST fetch never does, so tempId is omitted rather than "".
    ...(bbMessage.tempGuid ? { tempId: bbMessage.tempGuid } : {})
  }
}

// One rule for a message's timestamp, because an unread run and a normalized
// message are compared against each other: a run holding a raw `dateCreated`
// could carry undefined, and the read boundary derived from it is then NaN --
// a chat that can never be marked read.
function messageTs(bbMessage) {
  return bbMessage.dateCreated ?? bbMessage.dateDelivered ?? Date.now()
}

// The chat a `new-message` socket push belongs to is embedded on the message
// itself, because BlueBubbles serializes messages with includeChats on.
function embeddedChat(bbMessage) {
  return bbMessage.chats?.[0]
}

// `messages` is newest-first. A message at or before the boundary has been
// seen, so the count is everything newer than it that the account did not send.
// A boundary the scan window does not reach counts the whole window, which
// vetoes nothing -- the right answer when the boundary is that far behind is to
// leave the other signal alone.
function countAfterBoundary(messages, boundaryGuid) {
  let count = 0
  for (const message of messages) {
    if (message.guid === boundaryGuid) break
    if (!message.isFromMe) count += 1
  }
  return count
}

// A chat that has recorded a read on some inbound message is one where a
// missing dateRead means unread rather than untracked; where it has not, this
// says nothing and returns nothing.
function runBeforeFirstRead(messages) {
  if (!messages.some((m) => !m.isFromMe && m.dateRead)) return []
  const run = []
  for (const message of messages) {
    if (message.isFromMe || message.dateRead) break
    run.push(messageTs(message))
  }
  return run
}
