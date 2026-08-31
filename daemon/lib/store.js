import { PinStore } from './pins.js'

// Daemon-owned chat cache and unread counts. Unread is not persisted: the Mac
// is the source of truth, so a fresh daemon seeds from it (see
// bluebubbles.js's unreadCounts) and then tracks live -- +1 per inbound
// message, cleared by `read` or by the server reporting the chat read.
export class Store {
  // `pageSize` is the served page and the cached tail at once -- see
  // docs/daemon-protocol.md for why they are one number. 30 threads is past
  // what one sitting opens; raise it only if a session routinely cycles through
  // more, since every entry pins a full page in memory for the daemon's
  // lifetime.
  constructor({ threads = 30, pageSize = 60 } = {}) {
    this.maxThreads = threads
    this.pageSize = pageSize
    this.chats = new Map()
    this.threads = new Map()
    this.pins = new PinStore()
    this.sweptChats = false
    this.unreadSeed = null
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
    const page = messages.slice(-this.pageSize)
    const previous = this.threads.get(chatGuid)
    const changed = !previous || JSON.stringify(previous) !== JSON.stringify(page)
    this.threads.delete(chatGuid)
    this.threads.set(chatGuid, page)
    for (const guid of this.threads.keys()) {
      if (this.threads.size <= this.maxThreads) break
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
    this.threads.set(chatGuid, [...thread, message].slice(-this.pageSize))
  }

  setPinned(chatGuid, pinned) {
    this.pins.set(chatGuid, pinned)
    const chat = this.chats.get(chatGuid)
    if (chat) chat.pinned = pinned
  }

  // Whether a full account sweep has landed, which is not the same as holding
  // a chat: one inbound message for an unknown chat puts a single entry in the
  // map. Serving that as the list would have a client render one conversation
  // and believe it had them all.
  hasFullChatList() {
    return this.sweptChats
  }

  // `/api/v1/chat/query` returns some chats with no `lastMessage` even when it
  // is asked for, so a sweep would otherwise erase a preview a push had just
  // written and drop the chat to the end of the recency sort. A push is newer
  // information than a query that omits the field.
  replaceChats(normalizedChats) {
    this.sweptChats = true
    for (const chat of normalizedChats) {
      const existing = this.chats.get(chat.guid)
      this.chats.set(chat.guid, {
        ...chat,
        lastMessage: chat.lastMessage || existing?.lastMessage || null,
        unread: existing?.unread || 0,
        pinned: this.pins.pinned.has(chat.guid)
      })
    }
    if (this.unreadSeed) this._applyUnreadSeed()
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

  // The scan and the first chat list race, so the seed is held until there are
  // chats to attach it to and applied exactly once. It never overwrites a count
  // this daemon has observed itself: a push that landed while the scan was in
  // flight is the newer fact.
  seedUnread(counts) {
    this.unreadSeed = counts
    if (this.chats.size) this._applyUnreadSeed()
  }

  _applyUnreadSeed() {
    for (const [guid, unread] of Object.entries(this.unreadSeed)) {
      const chat = this.chats.get(guid)
      if (chat && !chat.unread) chat.unread = unread
    }
    this.unreadSeed = null
  }

  markRead(chatGuid) {
    const chat = this.chats.get(chatGuid)
    if (!chat) return
    chat.unread = 0
  }
}
