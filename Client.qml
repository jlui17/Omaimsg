import QtQuick
import Quickshell
import Quickshell.Io

// NDJSON client for the omaimsg daemon over a unix socket, per
// docs/daemon-protocol.md.
//
// One instance lives in each BarWidget (so one per monitor). The daemon accepts
// several clients and fans every push frame out to all of them, which keeps the
// bar panels on separate screens in sync without any cross-window plumbing.
Item {
  id: root

  // Absolute path to the plugin directory, injected by BarWidget so the client
  // can start the daemon without guessing where it was installed.
  property string pluginDir: ""
  // The plugin's manifest id, injected by BarWidget. Everything instance-shaped
  // is derived from it by the daemon; the socket is the one path both sides
  // must name, so it is the id with ".sock" on the end and nothing more.
  property string pluginId: ""
  property bool autostartDaemon: true
  // How many chats a request asks for. Owned here because the link-up prefetch
  // needs it before any panel is involved: prefetching a smaller page than the
  // panel wants leaves the list short for as long as the age gate holds off the
  // next request.
  property int chatLimit: 40

  readonly property string socketPath: {
    var runtime = Quickshell.env("XDG_RUNTIME_DIR")
    return (runtime && runtime.length > 0 ? runtime : "/tmp") + "/" + root.pluginId + ".sock"
  }

  // Live state mirrored from the daemon's `state` frames.
  property string connection: "unknown"
  property string lastError: ""
  property int unread: 0
  property var chats: []
  property int chatsEpoch: 0
  property double lastChatsMs: 0
  // A request already on the wire counts as fresh for gating purposes: the link
  // coming up asks for the list, and a panel opened before that reply lands
  // would otherwise ask again for the same window.
  property bool chatsPending: false
  // Distinct from "the list is empty": until a chats frame has landed, the
  // panel has no grounds to claim anything about the account. An error does not
  // set this -- a failed fetch is not evidence of no conversations.
  property bool chatsLoaded: false
  property string lastSocketError: ""

  property string activeChatGuid: ""
  property var activeMessages: []
  // The thread an older-page request is in flight for, "" when none. Held as a
  // guid rather than a bool so a reply for a thread the reader has since left
  // cannot open the gate on the one they are in now. Exhaustion is per guid for
  // the same reason: leaving a thread and coming back reads the same answer.
  property string olderPendingGuid: ""
  property var exhaustedThreads: ({})

  // Chat guid -> the thread as last known, so re-entering a chat visited this
  // session renders instantly instead of waiting on the daemon. Replaced
  // wholesale on every write so bindings that index into it re-evaluate.
  property var threadCache: ({})
  readonly property bool activeThreadLoaded: root.activeChatGuid.length > 0
    && root.threadCache[root.activeChatGuid] !== undefined
  // Guids the daemon answered with an empty page. Kept per guid rather than as
  // one flag so leaving a thread and coming back reads the same answer.
  property var unavailableThreads: ({})
  readonly property bool activeThreadUnavailable: root.activeChatGuid.length > 0
    && root.unavailableThreads[root.activeChatGuid] === true

  // Attachment guid -> file:// URL of the daemon-downloaded file, plus the
  // in-flight set. Both are replaced wholesale on every change so delegate
  // bindings that index into them re-evaluate.
  property var attachmentPaths: ({})
  property var attachmentPending: ({})

  // Whether the daemon is actually reachable.
  //
  // `Socket.connected` cannot answer this: it reads back `true` while a connect
  // is still pending, so a socket that never reaches the daemon still looks
  // connected. Only the connectionStateChanged signal and inbound frames are
  // trustworthy, so liveness is tracked here instead.
  property bool linkUp: false
  // The retry the daemon launch was attempted on, -1 before any attempt.
  property int daemonStartRetry: -1
  // A launch that has not yet had time to land. Cleared by the link coming up,
  // and given up on a few retries after the attempt so a daemon that is never
  // going to start stops claiming it is on its way.
  readonly property bool daemonStarting: root.autostartDaemon
    && (root.daemonStartRetry < 0 || root.retryCount <= root.daemonStartRetry + 3)
  property double lastFrameMs: 0
  property int retryCount: 0

  readonly property bool ready: linkUp && connection === "connected"

  // Emitted whenever rows land at the end of activeMessages: a freshly loaded
  // page, an inbound message, an optimistic send.
  signal messageArrived(string chatGuid, var message, var chat)
  signal sendFailed(string message)
  signal commandFailed(string command, string message)

  function request(payload) {
    var socket = socketLoader.item
    if (!socket || !root.linkUp) return false
    socket.write(JSON.stringify(payload) + "\n")
    socket.flush()
    return true
  }

  function refresh() { return request({ t: "hello" }) }

  // Fetch the chat list on connect rather than waiting for the panel to open:
  // the daemon pages the whole account to answer, and paying for it up front is
  // what makes the first open of a freshly started shell render populated.
  function onLinkEstablished() {
    if (!root.linkUp) return
    // A request that was on the wire when the socket dropped will never be
    // answered, and its gate would otherwise hold that thread's paging shut.
    root.olderPendingGuid = ""
    root.refresh()
    root.requestChats()
  }
  // `limit === 0` asks for the whole list and has to survive the default, so
  // this tests for undefined rather than falling back on falsiness.
  function requestChats(limit) {
    if (!request({ t: "chats", limit: limit === undefined ? root.chatLimit : limit })) return false
    root.chatsPending = true
    return true
  }
  // No limit: the daemon sizes the page from its own config and the panel pages
  // backwards from there (docs/daemon-protocol.md).
  function loadMessages(chatGuid) { return request({ t: "messages", chatGuid: chatGuid }) }

  // Callers fire this from a scroll position, so it has to absorb being asked
  // repeatedly.
  function loadOlderMessages() {
    var guid = root.activeChatGuid
    if (!guid.length || root.olderPendingGuid === guid || root.exhaustedThreads[guid] === true) return false
    if (!root.activeMessages.length) return false
    var oldest = root.activeMessages[0]
    if (!oldest || !oldest.ts) return false
    if (!request({ t: "olderMessages", chatGuid: guid, beforeTs: oldest.ts })) return false
    root.olderPendingGuid = guid
    return true
  }

  // The `read` frame is answered with a `state` frame, which carries the new
  // total, so nothing here recomputes it. The chat's own count is what no frame
  // covers until the next list arrives, so only that row is cleared locally.
  function markRead(chatGuid) {
    if (!request({ t: "read", chatGuid: chatGuid })) return false
    var list = (root.chats || []).slice()
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || list[i].guid !== chatGuid) continue
      list[i] = Object.assign({}, list[i], { unread: 0 })
      root.setChats(list)
      break
    }
    return true
  }

  // Pins are daemon-owned: it persists them and answers with a fresh `chats`
  // frame, so nothing is mirrored locally here.
  function setPinned(chatGuid, pinned) {
    return request({ t: "pin", chatGuid: chatGuid, pinned: pinned === true })
  }

  // Idempotent per guid: delegates call this on creation, so a re-rendered
  // thread re-requests freely and the cached path or pending flag absorbs it.
  function requestAttachment(guid) {
    if (!guid || !guid.length) return false
    if (root.attachmentPaths[guid] || root.attachmentPending[guid]) return true
    if (!request({ t: "attachment", guid: guid })) return false
    root.markAttachmentPending(guid)
    return true
  }

  function markAttachmentPending(guid) {
    var pending = Object.assign({}, root.attachmentPending)
    pending[guid] = true
    root.attachmentPending = pending
  }

  function settleAttachment(guid, path) {
    if (!guid.length) return
    var pending = Object.assign({}, root.attachmentPending)
    delete pending[guid]
    root.attachmentPending = pending
    if (!path.length) return
    var paths = Object.assign({}, root.attachmentPaths)
    paths[guid] = "file://" + path
    root.attachmentPaths = paths
  }

  // No pending-dedupe like requestAttachment: each click means "open the
  // viewer again", and the daemon serves warm requests from its caches.
  function requestPreview(guid) {
    if (!guid || !guid.length) return false
    return request({ t: "preview", guid: guid })
  }

  function openChat(chatGuid) {
    if (!chatGuid || !chatGuid.length) return false
    root.activeChatGuid = chatGuid
    // A chat seen this session renders from cache while the daemon's page is in
    // flight; an unvisited one shows nothing rather than the last chat's rows.
    root.activeMessages = root.threadCache[chatGuid] || []
    return root.loadMessages(chatGuid)
  }

  // activeMessages survives the close: the per-guid cache is what the next
  // entry reads, and emptying here is what used to blank the thread on re-entry.
  function closeChat() {
    root.activeChatGuid = ""
  }

  // Re-requests the open thread without emptying it, so a reopened panel keeps
  // showing the thread it had until the fresh page lands.
  function reloadActiveMessages() {
    if (!root.activeChatGuid.length) return false
    return root.loadMessages(root.activeChatGuid)
  }

  function nextTempId() {
    return "omaimsg-" + Date.now() + "-" + Math.floor(Math.random() * 1000000)
  }

  // False when the frame could not be written; the optimistic row is appended
  // only once the send is on the wire.
  function sendMessage(text) {
    if (!root.activeChatGuid.length || !text || !text.length) return false
    var tempId = root.nextTempId()
    if (!request({ t: "send", chatGuid: root.activeChatGuid, text: text, tempId: tempId }))
      return false
    root.appendActiveMessage({
      guid: tempId,
      tempId: tempId,
      optimistic: true,
      text: text,
      ts: Date.now(),
      fromMe: true,
      sender: "",
      pending: true,
      failed: false
    })
    return true
  }

  // One image per send, so picking several files is several of these and one
  // failing leaves the rest alone. The daemon copies the file into its cache
  // under `tempId` and answers with an `attachment` frame for that key, which
  // is what the optimistic row renders from -- images always come from the
  // daemon's cache, never from the path the picker handed us. That key is
  // marked pending here so the delegate's own request for it is absorbed, and
  // it stays pending if the send fails: nothing is ever cached under a tempId
  // BlueBubbles refused, so re-requesting it would only 404 on every redraw.
  function sendImage(filePath) {
    if (!root.activeChatGuid.length || !filePath || !filePath.length) return false
    var tempId = root.nextTempId()
    if (!request({ t: "sendImage", chatGuid: root.activeChatGuid, path: filePath, tempId: tempId }))
      return false
    root.markAttachmentPending(tempId)
    root.appendActiveMessage({
      guid: tempId,
      tempId: tempId,
      optimistic: true,
      text: "",
      ts: Date.now(),
      fromMe: true,
      sender: "",
      // A local row, so `mime` is not BlueBubbles' original the way a fetched
      // message's is; it only has to pass the panel's is-this-an-image test.
      attachments: [{ guid: tempId, mime: "image/*", name: filePath.slice(filePath.lastIndexOf("/") + 1) }],
      pending: true,
      failed: false
    })
    return true
  }

  // A page fetched from BlueBubbles knows nothing about tempId, so a row this
  // client sent comes back identified only by guid. Carrying the tempId across
  // keeps that row's identity stable for the thread model, which keys on
  // tempId first: without this, the newest bubble is removed and re-inserted on
  // the next reload rather than patched in place.
  function withKnownTempIds(list) {
    var byGuid = {}
    for (var i = 0; i < root.activeMessages.length; i++) {
      var known = root.activeMessages[i]
      if (known && known.tempId && known.guid) byGuid[known.guid] = known.tempId
    }
    var out = []
    for (var n = 0; n < list.length; n++) {
      var row = list[n]
      var tempId = row && !row.tempId ? byGuid[row.guid] : ""
      out.push(tempId ? Object.assign({}, row, { tempId: tempId }) : row)
    }
    return out
  }

  // Swaps the thread for a server page. Distinct from setActiveMessages, which
  // also serves incremental writes: a replacement is the only mutation that can
  // drop a row, so the rule that a send still on the wire outlives one lives
  // here rather than at the call site. Without it an optimistic row vanishes
  // from under the reader, and the `ack` behind it finds nothing to mark failed,
  // so a failure disappears with no trace. An in-flight send is always the
  // newest thing in the thread, so it goes last.
  function replaceActiveMessages(list) {
    var out = list.slice()
    for (var i = 0; i < root.activeMessages.length; i++) {
      var row = root.activeMessages[i]
      if (row && row.optimistic === true && row.pending === true) out.push(row)
    }
    root.setActiveMessages(out)
  }

  function setExhausted(chatGuid, exhausted) {
    if (!chatGuid.length) return
    var next = Object.assign({}, root.exhaustedThreads)
    if (exhausted) next[chatGuid] = true
    else delete next[chatGuid]
    root.exhaustedThreads = next
  }

  // Additive, unlike a `messages` frame: the older page goes in front of what is
  // already on screen. Deduped by guid because the server's cut is inclusive, so
  // the cursor message and anything sharing its millisecond come back with the
  // page. Returns whether anything new landed.
  function prependOlderMessages(older) {
    if (!older.length) return false
    var known = {}
    for (var i = 0; i < root.activeMessages.length; i++) known[root.activeMessages[i].guid] = true
    var out = []
    for (var n = 0; n < older.length; n++) {
      if (!known[older[n].guid]) out.push(older[n])
    }
    if (!out.length) return false
    root.setActiveMessages(out.concat(root.activeMessages))
    return true
  }

  // The cache is written on every mutation, not only on load, so an optimistic
  // row and its ack survive leaving the thread and coming back.
  function setActiveMessages(list) {
    root.activeMessages = list || []
    if (!root.activeChatGuid.length) return
    var next = Object.assign({}, root.threadCache)
    next[root.activeChatGuid] = root.activeMessages
    root.threadCache = next
  }

  function appendActiveMessage(message) {
    if (!message) return
    var list = root.activeMessages.slice()
    list.push(message)
    root.setActiveMessages(list)
  }

  function patchActiveMessage(guid, fields) {
    var list = root.activeMessages.slice()
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].guid !== guid) continue
      list[i] = Object.assign({}, list[i], fields)
      root.setActiveMessages(list)
      return
    }
  }

  // The ack names its chat, so a send answered while the reader is in a
  // different thread still resolves the row it left behind. Patching only the
  // active list left that row pending forever, and a replacement now carries a
  // pending row rather than wiping it, so the bubble would never come right.
  function patchMessage(chatGuid, guid, fields) {
    if (!chatGuid.length || chatGuid === root.activeChatGuid) {
      root.patchActiveMessage(guid, fields)
      return
    }
    var thread = root.threadCache[chatGuid]
    if (!thread) return
    var list = thread.slice()
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].guid !== guid) continue
      list[i] = Object.assign({}, list[i], fields)
      var next = Object.assign({}, root.threadCache)
      next[chatGuid] = list
      root.threadCache = next
      return
    }
  }

  // The daemon always echoes our own sends back; promote the optimistic row to
  // the real message instead of showing the text twice. `tempId` is exact and
  // present whenever the daemon knows it; the guid the `ack` stamped on the row
  // and finally the text cover an echo that arrives without one.
  function absorbEcho(message) {
    if (!message || !message.fromMe) return false
    var list = root.activeMessages.slice()
    for (var i = list.length - 1; i >= 0; i--) {
      var row = list[i]
      if (!row.optimistic) continue
      var matches = message.tempId
        ? row.tempId === message.tempId
        : ((message.guid && row.guid === message.guid) || row.text === message.text)
      if (!matches) continue
      list[i] = message
      root.setActiveMessages(list)
      return true
    }
    return false
  }

  // Infinity for a list that has never landed, so a caller gating on age always
  // fetches the first one.
  function chatsAgeMs() {
    return root.lastChatsMs > 0 ? Date.now() - root.lastChatsMs : Infinity
  }

  function setChats(list) {
    root.chats = list || []
    root.chatsEpoch = root.chatsEpoch + 1
  }

  function chatTs(chat) {
    return chat && chat.lastMessage ? (chat.lastMessage.ts || 0) : 0
  }

  function upsertChatPreview(chat) {
    if (!chat || !chat.guid) return
    var list = (root.chats || []).slice()
    var i = -1
    for (var n = 0; n < list.length; n++) {
      if (list[n] && list[n].guid === chat.guid) {
        i = n
        break
      }
    }
    if (i >= 0) list[i] = chat
    else list.push(chat)
    // The daemon is the ordering authority; this mirrors its documented order
    // (pinned first, newest first within each block) so a pushed preview sits
    // where the next `chats` frame will put it anyway.
    list.sort(function (a, b) {
      var aPinned = !!(a && a.pinned)
      var bPinned = !!(b && b.pinned)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      return root.chatTs(b) - root.chatTs(a)
    })
    root.setChats(list)
  }

  // The attempt is recorded before the bail-out, not after: with no plugin dir
  // there is nothing to launch, and leaving it unset would hold daemonStarting
  // true forever, so the strip would promise a start nothing had begun.
  function startDaemon() {
    root.daemonStartRetry = root.retryCount
    if (!pluginDir || pluginDir.length === 0) return
    daemonStarter.running = true
  }

  // Rebuild the socket from scratch.
  //
  // Toggling `Socket.connected` false→true does not work: the disconnect is
  // applied asynchronously, so the reconnect request is swallowed and the socket
  // stays down forever. Destroying and recreating the object through the Loader
  // gives a fresh QLocalSocket on every attempt.
  function reconnectSocket() {
    socketLoader.active = false
    socketLoader.active = true
  }

  function reset() {
    root.linkUp = false
    root.reconnectSocket()
    retryTimer.start()
  }

  function handleConnectionState(connectedNow) {
    if (!socketLoader.active) return
    if (connectedNow) {
      root.lastSocketError = ""
      root.linkUp = true
      root.retryCount = 0
      root.daemonStartRetry = -1
      root.lastFrameMs = Date.now()
      retryTimer.stop()
      // Requests in flight across a reconnect got no reply and never will;
      // dropping the flags lets a re-rendered thread ask again. The chat list
      // is aged out for the same reason: pushes that landed while the link was
      // down were never seen, so it cannot be trusted as fresh.
      root.attachmentPending = {}
      root.lastChatsMs = 0
      root.chatsPending = false
      // Deferred by one turn: this runs from the socket's own signal, and the
      // Loader has not published `item` yet at that point, so anything written
      // here goes nowhere. The state frame still arrives because the daemon
      // volunteers one on connect, which is what kept the dropped `hello`
      // invisible.
      Qt.callLater(root.onLinkEstablished)
    } else {
      root.linkUp = false
      // A brief socket blip is not a dead daemon. Retry quietly.
      retryTimer.start()
    }
  }

  function handleSocketError(error) {
    if (!socketLoader.active) return
    root.linkUp = false
    root.lastSocketError = String(error)
    retryTimer.start()
  }

  function handleLine(line) {
    if (!line || !line.length) return
    root.lastFrameMs = Date.now()
    root.linkUp = true
    try {
      root.handleFrame(JSON.parse(line))
    } catch (e) {
      console.warn("omaimsg: unparseable frame from daemon:", e)
    }
  }

  function handleFrame(frame) {
    switch (frame.t) {
      case "state":
        root.connection = frame.connection || "unknown"
        root.unread = frame.unread || 0
        root.lastError = frame.lastError || ""
        break

      case "chats":
        root.chatsPending = false
        root.chatsLoaded = true
        root.lastChatsMs = Date.now()
        root.setChats(frame.chats || [])
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        break

      case "messages":
        var unavailable = Object.assign({}, root.unavailableThreads)
        unavailable[frame.chatGuid || ""] = frame.unavailable === true
        root.unavailableThreads = unavailable
        // This frame replaces the thread, so the older pages paged in behind it
        // are gone and the thread can be paged back through again.
        root.setExhausted(frame.chatGuid || "", false)
        if ((frame.chatGuid || "") === root.activeChatGuid)
          root.replaceActiveMessages(root.withKnownTempIds(frame.messages || []))
        break

      case "olderMessages":
        if ((frame.chatGuid || "") === root.olderPendingGuid) root.olderPendingGuid = ""
        if ((frame.chatGuid || "") !== root.activeChatGuid) break
        // Prepend before reading `exhausted`, never short-circuit past it: an
        // exhausted page still carries the cursor message and anything sharing
        // its millisecond, which is the whole point of the inclusive cut.
        var added = root.prependOlderMessages(frame.messages || [])
        // A page that adds nothing is the end of the road even when the daemon
        // says otherwise: the next request would carry the same cursor and so
        // fetch the same page, and nothing would move the view off the top.
        if (frame.exhausted === true || !added) root.setExhausted(frame.chatGuid || "", true)
        break

      case "message":
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        if (frame.chat) root.upsertChatPreview(frame.chat)
        if (frame.message && (frame.chatGuid || "") === root.activeChatGuid
            && !root.absorbEcho(frame.message))
          root.appendActiveMessage(frame.message)
        root.messageArrived(frame.chatGuid || "", frame.message || null, frame.chat || null)
        break

      case "ack":
        if (frame.for === "send") {
          var fields = { pending: false, failed: frame.ok !== true }
          // Re-key the row to the real message so a later echo that carries no
          // tempId still matches on guid rather than falling through to text.
          if (frame.ok === true && frame.guid) fields.guid = frame.guid
          root.patchMessage(frame.chatGuid || "", frame.tempId || "", fields)
          if (frame.ok !== true) root.sendFailed(frame.message || "")
        }
        break

      case "attachment":
        root.settleAttachment(frame.guid || "", frame.path || "")
        break

      case "preview":
        if (frame.guid && frame.path) Quickshell.execDetached(["xdg-open", frame.path])
        break

      case "error":
        // Scoped by guid like the attachment errors below: an error for a
        // thread the reader has left must not open the gate on the one they
        // are in now.
        if (frame.for === "olderMessages" && (frame.chatGuid || "") === root.olderPendingGuid)
          root.olderPendingGuid = ""
        // A failed download must clear its pending flag, or the image can
        // never be re-requested for the rest of the session.
        if (frame.for === "attachment") root.settleAttachment(frame.guid || "", "")
        // Same for the chat list: a failure that left this set would make every
        // later open think a fetch was still coming.
        if (frame.for === "chats") root.chatsPending = false
        root.commandFailed(frame.for || "", frame.message || "Unknown daemon error")
        break
    }
  }

  Component {
    id: socketComponent

    Socket {
      path: root.socketPath
      connected: true

      parser: SplitParser {
        splitMarker: "\n"
        onRead: function (line) { root.handleLine(line) }
      }

      onConnectionStateChanged: root.handleConnectionState(connected)
      onError: function (error) { root.handleSocketError(error) }
    }
  }

  Loader {
    id: socketLoader
    active: true
    sourceComponent: socketComponent
  }

  // Reconnect loop. Also the daemon autostart hook: a few consecutive failures
  // are treated as "not running" and trigger one launch attempt.
  Timer {
    id: retryTimer
    // Capped at 8s: the daemon is a local service, so a long backoff only makes
    // the bar look broken for longer after a restart.
    interval: Math.min(8000, 1200 + root.retryCount * 1000)
    repeat: true
    running: false
    onTriggered: {
      if (root.linkUp) {
        retryTimer.stop()
        return
      }
      root.retryCount += 1
      // On the first retry, not the third: at this backoff that was about six
      // and a half seconds of doing nothing before node was even launched,
      // which on a fresh boot is the whole first impression of the bar.
      if (root.autostartDaemon && root.retryCount === 1) root.startDaemon()
      root.reconnectSocket()
    }
  }

  // A daemon that is wedged rather than gone keeps the socket open while sending
  // nothing. Ping periodically and rebuild the link if the silence gets long.
  Timer {
    id: livenessTimer
    interval: 20000
    repeat: true
    running: true
    onTriggered: {
      if (!root.linkUp) return
      if (root.lastFrameMs > 0 && Date.now() - root.lastFrameMs > 65000) {
        root.reset()
        return
      }
      root.request({ t: "ping" })
    }
  }

  Process {
    id: daemonStarter
    command: ["systemctl", "--user", "start", "omaimsg-daemon@" + root.pluginId + ".service"]
    onExited: function (exitCode) {
      // No unit installed (or it failed): fall back to launching the daemon
      // shipped next to the plugin.
      if (exitCode !== 0) fallbackStarter.running = true
    }
  }

  Process {
    id: fallbackStarter
    command: ["setsid", "node", root.pluginDir + "/daemon/index.js"]
    environment: ({ OMAIMSG_PLUGIN_ID: root.pluginId })
  }

  // Always arm the loop: it stops itself as soon as the link is confirmed up.
  Component.onCompleted: retryTimer.start()
}
