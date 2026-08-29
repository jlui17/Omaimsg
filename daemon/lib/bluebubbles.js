// Thin REST client for the BlueBubbles server API, plus normalization from
// its shapes into the daemon-protocol Chat/Message objects.
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
//   dateCreated} where dateCreated is already unix milliseconds.
// - POST /api/v1/message/text body: {chatGuid, tempGuid, message, method};
//   the server defaults `method` to "apple-script" when omitted
//   (api/interfaces/messageInterface.ts), which is also the safer default
//   (no Private API / SIP setup required), so that's this daemon's default.
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

import { EMPTY_CONTACT_INDEX } from './contacts.js'

const CHAT_PAGE_SIZE = Number(process.env.OMAIMSG_CHAT_PAGE_SIZE) || 200
const CHAT_FETCH_CAP = 2000

export class BlueBubblesClient {
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
      query: { limit, sort: 'DESC' }
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

export function normalizeChat(bbChat, contactIndex = EMPTY_CONTACT_INDEX) {
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

export function normalizeMessage(bbMessage, contactIndex = EMPTY_CONTACT_INDEX) {
  const rawSender = bbMessage.handle?.address || ''
  return {
    guid: bbMessage.guid,
    text: messageText(bbMessage),
    ts: bbMessage.dateCreated ?? bbMessage.dateDelivered ?? Date.now(),
    fromMe: !!bbMessage.isFromMe,
    sender: bbMessage.isFromMe ? '' : (contactIndex.resolve(rawSender) || rawSender),
    // Only the socket echo of a just-sent message carries tempGuid; a plain
    // REST fetch never does, so tempId is omitted rather than "".
    ...(bbMessage.tempGuid ? { tempId: bbMessage.tempGuid } : {})
  }
}

// The chat a `new-message` socket push belongs to is embedded on the message
// itself (see NOTES in the report on includeChats/handleNewMessage).
export function chatGuidOf(bbMessage) {
  return bbMessage.chats?.[0]?.guid
}

export function embeddedChat(bbMessage) {
  return bbMessage.chats?.[0]
}
