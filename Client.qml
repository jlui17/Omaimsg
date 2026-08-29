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
  property string socketPath: ""
  property bool autostartDaemon: true

  readonly property string defaultSocketPath: {
    var runtime = Quickshell.env("XDG_RUNTIME_DIR")
    return (runtime && runtime.length > 0 ? runtime : "/tmp") + "/omaimsg.sock"
  }
  readonly property string effectiveSocketPath: socketPath && socketPath.length > 0 ? socketPath : defaultSocketPath

  // Live state mirrored from the daemon's `state` frames.
  property string connection: "unknown"
  property string lastError: ""
  property int unread: 0
  property var chats: []
  property int chatsEpoch: 0
  property string lastSocketError: ""

  // Whether the daemon is actually reachable.
  //
  // `Socket.connected` cannot answer this: it reads back `true` while a connect
  // is still pending, so a socket that never reaches the daemon still looks
  // connected. Only the connectionStateChanged signal and inbound frames are
  // trustworthy, so liveness is tracked here instead.
  property bool linkUp: false
  property double lastFrameMs: 0
  property int retryCount: 0

  readonly property bool ready: linkUp && connection === "connected"

  signal messagesLoaded(string chatGuid, var messages)
  signal messageArrived(string chatGuid, var message, var chat)
  signal sendAcknowledged(string chatGuid, string tempId, string guid, bool ok, string message)
  signal commandFailed(string command, string message)

  function request(payload) {
    var socket = socketLoader.item
    if (!socket || !root.linkUp) return false
    socket.write(JSON.stringify(payload) + "\n")
    socket.flush()
    return true
  }

  function refresh() { return request({ t: "hello" }) }
  function requestChats(limit) { return request({ t: "chats", limit: limit || 40 }) }
  function loadMessages(chatGuid, limit) { return request({ t: "messages", chatGuid: chatGuid, limit: limit || 60 }) }

  // The daemon owns unread counts but sends no frame in reply to `read`, so the
  // badge would stay stale until the next push. Clear the local mirror too.
  function markRead(chatGuid) {
    if (!request({ t: "read", chatGuid: chatGuid })) return false
    var list = (root.chats || []).slice()
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || list[i].guid !== chatGuid) continue
      var cleared = Object.assign({}, list[i], { unread: 0 })
      root.unread = Math.max(0, root.unread - (list[i].unread || 0))
      list[i] = cleared
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

  // Returns the tempId the daemon echoes back in its `ack`, or "" when the
  // frame could not be written. The caller keys its optimistic row on it.
  function sendMessage(chatGuid, text) {
    if (!chatGuid || !text || !text.length) return ""
    var tempId = "omaimsg-" + Date.now() + "-" + Math.floor(Math.random() * 1000000)
    if (!request({ t: "send", chatGuid: chatGuid, text: text, tempId: tempId })) return ""
    return tempId
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

  function startDaemon() {
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
      root.lastFrameMs = Date.now()
      retryTimer.stop()
      root.refresh()
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
        root.setChats(frame.chats || [])
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        break

      case "messages":
        root.messagesLoaded(frame.chatGuid || "", frame.messages || [])
        break

      case "message":
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        if (frame.chat) root.upsertChatPreview(frame.chat)
        root.messageArrived(frame.chatGuid || "", frame.message || null, frame.chat || null)
        break

      case "ack":
        if (frame.for === "send")
          root.sendAcknowledged(frame.chatGuid || "", frame.tempId || "", frame.guid || "",
                                frame.ok === true, frame.message || "")
        break

      case "error":
        root.commandFailed(frame.for || "", frame.message || "Unknown daemon error")
        break
    }
  }

  Component {
    id: socketComponent

    Socket {
      path: root.effectiveSocketPath
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
      if (root.autostartDaemon && root.retryCount === 3) root.startDaemon()
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
    command: ["systemctl", "--user", "start", "omaimsg-daemon.service"]
    onExited: function (exitCode) {
      // No unit installed (or it failed): fall back to launching the daemon
      // shipped next to the plugin.
      if (exitCode !== 0) fallbackStarter.running = true
    }
  }

  Process {
    id: fallbackStarter
    command: ["setsid", "node", root.pluginDir + "/daemon/dist/omaimsg-daemon.cjs"]
  }

  // Always arm the loop: it stops itself as soon as the link is confirmed up.
  Component.onCompleted: retryTimer.start()
}
