import { normalizeChat } from './bluebubbles.js'
import { EMPTY_CONTACT_INDEX } from './contacts.js'

// Daemon-owned chat cache and unread counts. Unread is in-memory only, per
// the protocol doc: +1 per inbound message to a chat not marked read since,
// cleared by `read`. It resets on daemon restart.
export class Store {
  constructor() {
    this.chats = new Map()
    this.pinnedGuids = new Set()
  }

  // Seeds pinned state from PinStore at startup; pins toggled after that go
  // through setPinned, which keeps this set and every cached chat in sync.
  setPinnedGuids(guids) {
    this.pinnedGuids = new Set(guids)
  }

  setPinned(chatGuid, pinned) {
    if (pinned) this.pinnedGuids.add(chatGuid)
    else this.pinnedGuids.delete(chatGuid)
    const chat = this.chats.get(chatGuid)
    if (chat) chat.pinned = pinned
  }

  replaceChats(normalizedChats) {
    for (const chat of normalizedChats) {
      const existing = this.chats.get(chat.guid)
      this.chats.set(chat.guid, { ...chat, unread: existing?.unread || 0, pinned: this.pinnedGuids.has(chat.guid) })
    }
    return this.chatList()
  }

  // A Map's iteration order is insertion order and does NOT change when an
  // existing key is re-set, so returning `this.chats.values()` directly
  // would freeze the list in whatever order chats were first seen in,
  // regardless of new messages arriving. Sort fresh every time instead of
  // trusting the server's `sort` or the map's order.
  chatList() {
    return [...this.chats.values()].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const at = a.lastMessage?.ts
      const bt = b.lastMessage?.ts
      if (at == null && bt == null) return 0
      if (at == null) return 1
      if (bt == null) return -1
      return bt - at
    })
  }

  totalUnread() {
    let total = 0
    for (const chat of this.chats.values()) total += chat.unread
    return total
  }

  // Applies a BlueBubbles chat embedded on a message push (name/last message
  // may be new to us if the chat was never fetched via `chats`).
  upsertFromMessage(bbChat, message, contactIndex = EMPTY_CONTACT_INDEX) {
    const existing = this.chats.get(bbChat.guid)
    const chat = existing || { ...normalizeChat(bbChat, contactIndex), pinned: this.pinnedGuids.has(bbChat.guid) }
    chat.name = bbChat.displayName || chat.name
    chat.isGroup = (bbChat.participants?.length || 0) > 1
    chat.lastMessage = { text: message.text, ts: message.ts, fromMe: message.fromMe }
    if (!message.fromMe) chat.unread = (chat.unread || 0) + 1
    this.chats.set(bbChat.guid, chat)
    return chat
  }

  markRead(chatGuid) {
    const chat = this.chats.get(chatGuid)
    if (!chat) return
    chat.unread = 0
  }
}
