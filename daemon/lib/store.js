import { UNREAD_SCAN_LIMIT } from './bluebubbles.js'
import { ChatCache } from './cache.js'
import { logger } from './logger.js'
import { PinStore } from './pins.js'
import { ReadStateStore } from './readstate.js'

// Daemon-owned chat cache and unread. Unread is derived, never counted: each
// chat holds the timestamps of the messages the server reports unread (see
// bluebubbles.js's unreadRuns) plus whatever has been pushed since, and a chat
// is unread only in what is newer than the read boundary this install has
// persisted. Opening a chat here, or the Mac reporting it read, moves that
// boundary -- so a restart re-derives the same answer instead of resurrecting
// what was already dismissed.
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
    this.readState = new ReadStateStore()
    this.cache = new ChatCache()
    this.sweptChats = false
    this.unreadSeed = null
    this._restore()
  }

  // A restored list is a swept one: it came from a full sweep when it was
  // written, which is what lets a boot serve `chats` before BlueBubbles
  // answers. Neither pins nor the unread run come back from the file: pins.json
  // owns the one and the startup scan re-derives the other, and a cached run
  // would beat that scan rather than be corrected by it.
  _restore() {
    const loaded = this.cache.load()
    if (!loaded) return
    for (const chat of loaded.chats || []) {
      this.chats.set(chat.guid, { ...chat, unreadTs: [], pinned: this.pins.pinned.has(chat.guid) })
    }
    for (const [guid, messages] of Object.entries(loaded.threads || {})) {
      this.threads.set(guid, messages.slice(-this.pageSize))
    }
    this.sweptChats = this.chats.size > 0
    logger.info('cache: restored', { chats: this.chats.size, threads: this.threads.size })
  }

  // Object.entries preserves the Map's insertion order, so the thread LRU
  // survives the round trip and a restored daemon evicts the same page a
  // running one would.
  _persist() {
    this.cache.schedule(() => ({
      chats: [...this.chats.values()].map(({ unreadTs: _unreadTs, ...chat }) => chat),
      threads: Object.fromEntries(this.threads)
    }))
  }

  flush() {
    this.cache.flush()
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
    this._persist()
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
    this._persist()
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
        unreadTs: existing?.unreadTs || [],
        pinned: this.pins.pinned.has(chat.guid)
      })
    }
    if (this.unreadSeed) this._applyUnreadSeed()
    this._persist()
    return this.chatList()
  }

  // A Map's iteration order is insertion order and does NOT change when an
  // existing key is re-set, so returning `this.chats.values()` directly
  // would freeze the list in whatever order chats were first seen in,
  // regardless of new messages arriving. Sort fresh every time instead of
  // trusting the server's `sort` or the map's order.
  chatList() {
    return [...this.chats.values()].map((chat) => this._withUnread(chat)).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const at = a.lastMessage?.ts
      const bt = b.lastMessage?.ts
      if (at == null && bt == null) return 0
      if (at == null) return 1
      if (bt == null) return -1
      return bt - at
    })
  }

  // The chat count, not the message count: the bar badge says how many
  // conversations want you, while a chat's own badge says how many messages.
  unreadChats() {
    let total = 0
    for (const chat of this.chats.values()) if (this._unreadCount(chat) > 0) total += 1
    return total
  }

  _unreadCount(chat) {
    const boundary = this.readState.openedTs(chat.guid)
    let count = 0
    for (const ts of chat.unreadTs) if (ts > boundary) count += 1
    return count
  }

  _withUnread(chat) {
    const { unreadTs: _unreadTs, ...rest } = chat
    return { ...rest, unread: this._unreadCount(chat) }
  }

  // The chat pushed alongside a message may be one we have never fetched via
  // `chats`, so it is merged in rather than looked up.
  upsertFromMessage(pushedChat, message) {
    const existing = this.chats.get(pushedChat.guid)
    const chat = existing || { ...pushedChat, unreadTs: [], pinned: this.pins.pinned.has(pushedChat.guid) }
    chat.name = pushedChat.name || chat.name
    chat.isGroup = pushedChat.isGroup
    chat.lastMessage = { text: message.text, ts: message.ts, fromMe: message.fromMe }
    // Capped at what the startup scan reads back through, so a chat nobody
    // opens counts the same live as it does after a restart rather than
    // drifting above anything the scan could confirm.
    if (!message.fromMe) chat.unreadTs = [...chat.unreadTs, message.ts].slice(-UNREAD_SCAN_LIMIT)
    this.chats.set(pushedChat.guid, chat)
    this._persist()
    return this._withUnread(chat)
  }

  // The scan and the first chat list race, so the seed is held until there are
  // chats to attach it to and applied exactly once. It never overwrites a run
  // this daemon has observed itself: a push that landed while the scan was in
  // flight is the newer fact.
  seedUnread(runs) {
    this.unreadSeed = runs
    if (this.chats.size) this._applyUnreadSeed()
  }

  _applyUnreadSeed() {
    for (const [guid, run] of Object.entries(this.unreadSeed)) {
      const chat = this.chats.get(guid)
      if (chat && !chat.unreadTs.length) chat.unreadTs = run
    }
    this.unreadSeed = null
    this._persist()
  }

  // Read through the newest message known for the chat, not through now: the
  // list can lag the server, and a wall-clock boundary would swallow a message
  // that arrived before this frame but has not reached us yet.
  markRead(chatGuid) {
    const chat = this.chats.get(chatGuid)
    if (!chat) return false
    const through = Math.max(chat.lastMessage?.ts || 0, ...chat.unreadTs)
    if (!this.readState.markOpened(chatGuid, through)) return false
    // Everything held is at or before the boundary now, so the count is already
    // zero; dropping it keeps a long-lived daemon's chat from accumulating a
    // timestamp per message it has ever received.
    chat.unreadTs = []
    this._persist()
    return true
  }
}
