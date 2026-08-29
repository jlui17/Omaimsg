import { PinStore } from './pins.js'

// A cached page is exactly what the panel renders (its `messageLimit`, 60 by
// default), so a shorter cap would make every thread open re-fetch to fill the
// view. 30 chats is past what one sitting opens; raise it only if a session
// routinely cycles through more than that, since every entry pins a full page
// in memory for the daemon's lifetime.
const MAX_CACHED_MESSAGES = 60
const MAX_CACHED_THREADS = 30

// Daemon-owned chat cache and unread counts. Unread is in-memory only, per
// the protocol doc: +1 per inbound message to a chat not marked read since,
// cleared by `read`. It resets on daemon restart; pins do not.
export class Store {
  constructor() {
    this.chats = new Map()
    this.threads = new Map()
    this.pins = new PinStore()
  }

  // Least-recently-read eviction: reading a thread moves it to the end of the
  // Map, so the oldest key is always the coldest.
  cachedThread(chatGuid) {
    const thread = this.threads.get(chatGuid)
    if (!thread) return null
    this.threads.delete(chatGuid)
    this.threads.set(chatGuid, thread)
    return thread
  }

  // True when the page is new information, which is what tells the caller
  // whether a client already served from cache still needs a fresh frame.
  cacheThread(chatGuid, messages) {
    const page = messages.slice(-MAX_CACHED_MESSAGES)
    const previous = this.threads.get(chatGuid)
    const changed = !previous || JSON.stringify(previous) !== JSON.stringify(page)
    this.threads.delete(chatGuid)
    this.threads.set(chatGuid, page)
    for (const guid of this.threads.keys()) {
      if (this.threads.size <= MAX_CACHED_THREADS) break
      this.threads.delete(guid)
    }
    return changed
  }

  // Only threads already cached are kept warm. Caching a chat the panel has
  // never opened would fill the LRU with pages nobody is going to read and
  // evict the ones somebody is.
  appendToThread(chatGuid, message) {
    const thread = this.threads.get(chatGuid)
    if (!thread) return
    if (message.guid && thread.some((m) => m.guid === message.guid)) return
    this.threads.set(chatGuid, [...thread, message].slice(-MAX_CACHED_MESSAGES))
  }

  setPinned(chatGuid, pinned) {
    this.pins.set(chatGuid, pinned)
    const chat = this.chats.get(chatGuid)
    if (chat) chat.pinned = pinned
  }

  replaceChats(normalizedChats) {
    for (const chat of normalizedChats) {
      const existing = this.chats.get(chat.guid)
      this.chats.set(chat.guid, { ...chat, unread: existing?.unread || 0, pinned: this.pins.pinned.has(chat.guid) })
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

  // The chat pushed alongside a message may be one we have never fetched via
  // `chats`, so it is merged in rather than looked up.
  upsertFromMessage(pushedChat, message) {
    const existing = this.chats.get(pushedChat.guid)
    const chat = existing || { ...pushedChat, pinned: this.pins.pinned.has(pushedChat.guid) }
    chat.name = pushedChat.name || chat.name
    chat.isGroup = pushedChat.isGroup
    chat.lastMessage = { text: message.text, ts: message.ts, fromMe: message.fromMe }
    if (!message.fromMe) chat.unread = (chat.unread || 0) + 1
    this.chats.set(pushedChat.guid, chat)
    return chat
  }

  markRead(chatGuid) {
    const chat = this.chats.get(chatGuid)
    if (!chat) return
    chat.unread = 0
  }
}
