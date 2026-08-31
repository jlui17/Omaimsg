import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

// The iMessage surface: chat list and thread view with an inline composer.
// Loaded by BarWidget.qml, which injects `bar`, `anchorItem`, `hostWidget`,
// `settings`, and the shared `client`.
Panel {
  id: root
  moduleName: "io.omaimsg"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var client: null

  // "chats" | "thread"
  property string view: "chats"
  property var activeChat: null
  property int cursorIndex: 0
  // -1 when the thread body has no message selected
  property int messageIndex: -1
  property string cursorFollowGuid: ""
  property string statusLine: ""
  property bool searching: false
  // "search" | "chats" | "messages" | "composer"
  property string focusSection: "chats"
  property string filterText: ""
  property bool unreadOnly: false

  readonly property var chats: client ? client.chats : []
  readonly property string activeGuid: client ? client.activeChatGuid : ""
  readonly property var messages: client ? client.activeMessages : []
  // The daemon sends a thread oldest-first; the list renders it bottom-to-top
  // from the newest, so index 0 here is the most recent message. messageIndex
  // and every delegate index count in this order.
  readonly property var threadRows: {
    var list = root.messages || []
    var out = []
    for (var i = list.length - 1; i >= 0; i--) out.push(root.threadRow(list[i]))
    return out
  }
  readonly property bool threadLoaded: client ? client.activeThreadLoaded === true : false
  readonly property bool threadUnavailable: client ? client.activeThreadUnavailable === true : false
  readonly property int chatLimit: root.client ? root.client.chatLimit : 40
  // Relative timestamps are computed client-side, so a list this old is stale
  // only in the sense that a message could have arrived with the daemon's
  // socket down; the reconnect path zeroes the age for exactly that case.
  readonly property int chatsMaxAgeMs: 30000

  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
  // Popup content must use the theme foreground. barForeground can switch to a
  // wallpaper-contrast color when the bar is transparent, which may be dark
  // even though the popup surface remains dark.
  readonly property color foreground: root.bar ? root.bar.foreground : Color.foreground
  readonly property color secondaryForeground: Qt.darker(root.foreground, 1.5)
  readonly property color accent: root.bar ? root.bar.urgent : Color.accent

  readonly property bool linkUp: client ? client.linkUp === true : false
  readonly property bool connected: client ? client.ready === true : false

  // Filtering runs before the cap so a match outside the first `chatLimit`
  // chats is still reachable; the cap then bounds what gets rendered.
  readonly property var visibleChats: {
    var epoch = root.client ? root.client.chatsEpoch : 0
    if (epoch < 0) return []
    var list = root.chats || []
    if (root.unreadOnly) {
      var unreads = []
      for (var u = 0; u < list.length; u++) {
        if (list[u] && (list[u].unread || 0) > 0) unreads.push(list[u])
      }
      list = unreads
    }
    var needle = root.filterText.toLowerCase()
    if (needle.length > 0) {
      var matches = []
      for (var i = 0; i < list.length; i++) {
        var name = String((list[i] && list[i].name) || "")
        if (name.toLowerCase().indexOf(needle) !== -1) matches.push(list[i])
      }
      list = matches
    }
    return list.slice(0, Math.max(1, root.chatLimit))
  }

  // Three states, not two: a fetch in flight is not an empty account, and a
  // failed one is not either. Only a landed frame licenses "No conversations
  // yet."; an error leaves both off and lets the connection strip do the
  // talking.
  readonly property bool chatsLoading: root.client
    ? root.client.chatsPending === true && root.client.chatsLoaded !== true
    : false
  readonly property bool chatsSettledEmpty: root.client
    ? root.client.chatsLoaded === true && root.visibleChats.length === 0
    : false

  readonly property bool threadIsGroup: root.activeChat ? root.activeChat.isGroup === true : false

  readonly property string connectionStrip: {
    if (!root.linkUp) {
      // A socket error while the launch is still in flight is the expected
      // noise of a daemon that is not up yet, so it is not worth reporting.
      if (root.client && root.client.daemonStarting) return "Starting daemon…"
      // No socket detail: lastSocketError is a QLocalSocket error enum, so it
      // renders as a bare number that means nothing to whoever reads the strip.
      return "Daemon offline"
    }
    if (root.client && root.client.connection === "connected") return ""
    var label = root.client && root.client.connection === "error"
      ? "BlueBubbles unreachable"
      : "Connecting to BlueBubbles…"
    return label + root.detail(root.client ? root.client.lastError : "")
  }

  function detail(text) {
    return text && text.length > 0 ? " · " + text : ""
  }

  function open() { root.controller.show() }
  function close() { root.controller.hide() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function oneLine(text) {
    return String(text === undefined || text === null ? "" : text).replace(/\s*\n+\s*/g, " · ").trim()
  }

  function chatPreview(chat) {
    if (!chat || !chat.lastMessage) return "No messages yet"
    var text = root.oneLine(chat.lastMessage.text)
    if (!text.length) return "No messages yet"
    return chat.lastMessage.fromMe ? "You: " + text : text
  }

  function relativeTime(ms) {
    if (!ms) return ""
    var diff = Math.max(0, Date.now() - ms)
    if (diff < 60000) return "now"
    if (diff < 3600000) return Math.floor(diff / 60000) + "m"
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h"
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + "d"
    return Qt.formatDateTime(new Date(ms), "d MMM")
  }

  function clockTime(ms) {
    return ms ? Qt.formatTime(new Date(ms), "HH:mm") : ""
  }

  // The bubble body is styled text so links can be tags, which means the
  // message has to be escaped rather than handed over as-is; a message
  // containing "<3" would otherwise lose the "<3".
  function escapeMarkup(text) {
    return text.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>")
  }

  function linkify(text) {
    var pattern = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
    var out = ""
    var last = 0
    var match
    while ((match = pattern.exec(text)) !== null) {
      // Sentence punctuation that trails a URL is the sentence's, not the
      // URL's. Closing brackets are left alone: they are as often part of the
      // link (wiki titles) as around it.
      var url = match[0].replace(/[.,;:!?'"]+$/, "")
      var start = match.index
      out += root.escapeMarkup(text.slice(last, start))
      // The href is not escaped: Qt resolves entities in the body but not in
      // an attribute, so an escaped "&" would open a URL with a literal
      // "&amp;" in it. The pattern bars the quote and angle brackets, which
      // are the only raw characters that could end the attribute early.
      out += '<a href="' + (url.indexOf("www.") === 0 ? "https://" + url : url) + '">'
        + root.escapeMarkup(url) + '</a>'
      last = start + url.length
      pattern.lastIndex = last
    }
    return out + root.escapeMarkup(text.slice(last))
  }

  function badgeText(count) {
    var n = Math.max(0, count | 0)
    return n > 99 ? "99+" : String(n)
  }

  // A guid that has left the list keeps the index rather than the chat, so the
  // cursor lands on whichever row slid up into the slot.
  function cursorToGuid(guid) {
    for (var i = 0; i < root.visibleChats.length; i++) {
      if (root.visibleChats[i].guid !== guid) continue
      root.cursorIndex = i
      chatList.positionViewAtIndex(i, ListView.Contain)
      return
    }
    var count = root.visibleChats.length
    if (count === 0) {
      root.cursorIndex = 0
      return
    }
    root.cursorIndex = Math.min(root.cursorIndex, count - 1)
    chatList.positionViewAtIndex(root.cursorIndex, ListView.Contain)
  }

  function imageAttachmentsOf(message) {
    return ((message && message.attachments) || []).filter(function (a) {
      return a && a.mime && a.mime.indexOf("image/") === 0
    })
  }

  function chatAt(index) {
    var list = root.visibleChats
    if (index < 0 || index >= list.length) return null
    return list[index]
  }

  // Flat roles only: everything the row renders is resolved here, so a delegate
  // never reaches back into the chat object and `lastMessage` never has to
  // survive as a nested model value.
  function chatRow(chat) {
    return {
      guid: chat.guid || "",
      label: chat.name || chat.guid || "",
      preview: root.chatPreview(chat),
      ts: chat.lastMessage ? (chat.lastMessage.ts || 0) : 0,
      unread: chat.unread || 0,
      pinned: chat.pinned === true
    }
  }

  // Reconcile rather than reassigning the model. Assigning a fresh list makes
  // ListView destroy and rebuild every delegate, which is what made the whole
  // list blink on each refresh even when nothing had changed; patching in place
  // also leaves a reordered row as the same item, so it can be animated.
  //
  // Returns whether a row landed at index 0, which callers use to decide
  // whether the view needs re-pinning to that end.
  function syncListModel(model, rows, keyRole) {
    var wanted = {}
    for (var i = 0; i < rows.length; i++) wanted[rows[i][keyRole]] = true
    for (var stale = model.count - 1; stale >= 0; stale--) {
      if (!wanted[model.get(stale)[keyRole]]) model.remove(stale)
    }
    var addedFirst = false
    for (var target = 0; target < rows.length; target++) {
      var row = rows[target]
      var found = -1
      for (var scan = target; scan < model.count; scan++) {
        if (model.get(scan)[keyRole] !== row[keyRole]) continue
        found = scan
        break
      }
      if (found === -1) {
        model.insert(target, row)
        if (target === 0) addedFirst = true
        continue
      }
      if (found !== target) model.move(found, target, 1)
      model.set(target, row)
    }
    return addedFirst
  }

  function syncChatModel() {
    var rows = []
    for (var i = 0; i < root.visibleChats.length; i++) rows.push(root.chatRow(root.visibleChats[i]))
    root.syncListModel(chatModel, rows, "guid")
  }

  // Flat roles only, the same contract chatRow keeps: the delegate resolves
  // nothing itself, so no message object and no attachment array has to survive
  // as a nested model value.
  //
  // The key is tempId before guid because a send rewrites the guid: the ack
  // stamps the real one over the temp. Keying on guid would re-identify the row
  // mid-send, which is the flicker this model exists to remove, so the tempId a
  // send carries end to end wins wherever it is present.
  function threadRow(message) {
    var images = root.imageAttachmentsOf(message)
    var text = message.text || ""
    return {
      key: message.tempId || message.guid || "",
      fromMe: message.fromMe === true,
      sender: message.sender || "",
      // The daemon substitutes "[attachment]" for attachment-only messages
      // (docs/daemon-protocol.md); when the image itself is rendered here, that
      // placeholder is noise.
      body: text === "[attachment]" && images.length > 0 ? "" : text,
      images: JSON.stringify(images),
      ts: message.ts || 0,
      pending: message.pending === true,
      failed: message.failed === true
    }
  }

  // A send writes the thread three times (optimistic row, ack patch, echo), so
  // on a JS-array model that was three full resets, each one a visible jump
  // until the re-pin caught up a frame later.
  function syncThreadModel() {
    return root.syncListModel(threadModel, root.threadRows, "key")
  }

  function moveCursor(delta) {
    var count = root.visibleChats.length
    if (count === 0) return
    var next = Math.max(0, Math.min(count - 1, root.cursorIndex + delta))
    root.cursorIndex = next
    chatList.positionViewAtIndex(next, ListView.Contain)
  }

  // `k` from no selection starts at the latest message; `j` past the latest
  // drops back to no selection, so the newest end is where the cursor enters
  // and leaves.
  //
  // The index runs newest-first, so moving up the screen (`k`, delta -1) means
  // counting up: the subtraction is what keeps the keys pointing where they
  // look, not an inverted control.
  function moveMessageCursor(delta) {
    var count = root.threadRows.length
    if (count === 0) return
    if (root.messageIndex < 0) {
      if (delta > 0) return
      root.messageIndex = 0
    } else {
      var next = root.messageIndex - delta
      if (next < 0) {
        root.messageIndex = -1
        return
      }
      root.messageIndex = Math.min(count - 1, next)
    }
    messageList.positionViewAtIndex(root.messageIndex, ListView.Contain)
  }

  function previewSelectedMessage() {
    if (root.messageIndex < 0 || !root.client) return
    var row = root.threadRows[root.messageIndex]
    if (!row) return
    var images = JSON.parse(row.images)
    if (!images.length) return
    root.client.requestPreview(images[0].guid)
  }

  function openThread(chat) {
    if (!chat || !chat.guid) return
    root.activeChat = chat
    root.messageIndex = -1
    root.statusLine = ""
    root.view = "thread"
    root.focusSection = "messages"
    if (root.client) {
      root.client.openChat(chat.guid)
      root.client.markRead(chat.guid)
    }
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  function activateCursor() {
    root.openThread(root.chatAt(root.cursorIndex))
  }

  // A filter searches the account, not the rendered page, so it asks for the
  // whole list; the page stands for as long as either filter is up.
  function syncChatPage() {
    if (!root.client) return
    root.client.requestChats(root.searching || root.unreadOnly ? 0 : root.chatLimit)
  }

  function beginSearch() {
    root.focusSection = "search"
    Qt.callLater(function () { searchField.forceActiveFocus() })
    if (root.searching) return
    root.searching = true
    root.cursorIndex = 0
    root.syncChatPage()
  }

  function toggleUnreadOnly() {
    root.unreadOnly = !root.unreadOnly
    root.cursorIndex = 0
    root.syncChatPage()
  }

  // Drops the filter and the deep page without touching focus: callers decide
  // where the cursor goes next.
  function clearSearch() {
    root.searching = false
    searchField.text = ""
    root.filterText = ""
    root.cursorIndex = 0
    root.syncChatPage()
  }

  function exitSearch() {
    root.clearSearch()
    root.focusSection = "chats"
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  // With no match there is nowhere to send the cursor, so an empty result set
  // keeps the user in the field.
  function commitSearch() {
    if (!root.chatAt(0)) return
    root.focusSection = "chats"
    root.cursorIndex = 0
    chatList.positionViewAtIndex(0, ListView.Contain)
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  // A pin reorders the list under the cursor, so follow the chat rather than
  // the row index — otherwise the next Enter opens whichever chat slid into
  // that slot.
  function togglePin(chat) {
    if (!chat || !chat.guid || !root.client) return
    if (!root.client.setPinned(chat.guid, chat.pinned !== true)) return
    root.cursorFollowGuid = chat.guid
  }

  onThreadRowsChanged: {
    if (root.syncThreadModel()) messageList.pinToNewest()
    Qt.callLater(root.loadOlderIfAtStart)
  }

  // The thread is laid out newest-at-the-bottom, so `atYBeginning` is its
  // oldest end: reaching it is what asks the daemon for the page before it.
  // Also run after the rows change, because a thread too short to scroll sits
  // at that end from the start and never crosses into it.
  function loadOlderIfAtStart() {
    if (root.view !== "thread" || !root.client) return
    if (!messageList.atYBeginning) return
    root.client.loadOlderMessages()
  }

  onVisibleChatsChanged: {
    root.syncChatModel()
    if (!root.cursorFollowGuid.length) return
    root.cursorToGuid(root.cursorFollowGuid)
    root.cursorFollowGuid = ""
  }

  function focusComposer() {
    root.focusSection = "composer"
    composer.forceActiveFocus()
  }

  // The list reorders while a thread is open (reading it clears the unread,
  // sending bumps it), so return to the chat itself rather than its old row.
  function backToChats() {
    var guid = root.activeChat ? root.activeChat.guid : ""
    root.view = "chats"
    root.focusSection = "chats"
    root.activeChat = null
    root.statusLine = ""
    composer.text = ""
    if (root.client) root.client.closeChat()
    if (guid.length) root.cursorToGuid(guid)
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  function send() {
    var text = composer.text
    if (!text || !text.trim().length || !root.client) return
    if (!root.client.sendMessage(text)) {
      root.statusLine = "Not connected"
      return
    }
    composer.text = ""
    root.statusLine = ""
  }

  onOpenedChanged: {
    if (!root.opened || !root.client) return
    root.statusLine = ""
    root.client.refresh()
    // A re-request costs the daemon a paginated sweep of the whole account, and
    // it already pushes a fresh `chats` frame on every inbound message, so the
    // open pays for one only once the pushed list has gone quiet -- and never
    // while the link-up fetch is still in flight.
    if (!root.client.chatsPending && root.client.chatsAgeMs() > root.chatsMaxAgeMs)
      root.client.requestChats(root.chatLimit)
    if (root.view !== "thread" || !root.activeGuid) return
    root.client.reloadActiveMessages()
    root.client.markRead(root.activeGuid)
    root.messageIndex = -1
    root.focusSection = "messages"
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  Connections {
    target: root.client
    enabled: root.client !== null

    function onMessageArrived(chatGuid, message, chat) {
      if (chatGuid !== root.activeGuid || !message) return
      if (chat) root.activeChat = chat
      // The thread is on screen, so an inbound message is read the moment it
      // lands rather than sitting as an unread the user has already seen.
      if (root.opened && root.client) root.client.markRead(chatGuid)
    }

    function onSendFailed(message) {
      root.statusLine = message || "Send failed"
    }

    function onCommandFailed(command, message) {
      root.statusLine = message || (command + " failed")
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    Behavior on contentHeight {
      NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
    }

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // A focused field owns every key, so typing lands in it instead of
      // driving the chat cursor.
      blocked: composer.activeFocus || searchField.activeFocus

      // Escape and `h` walk back out one layer at a time: the thread, then the
      // search, then the panel itself.
      onCloseRequested: {
        if (root.view === "thread") root.backToChats()
        else if (root.searching) root.exitSearch()
        else if (root.unreadOnly) root.toggleUnreadOnly()
        else root.close()
      }
      // `l` and `h` are the depth axis: deeper into a thread, back out of it.
      onMoveRequested: function (dx, dy) {
        if (root.view === "thread") {
          if (dx < 0) root.backToChats()
          else if (dx > 0) root.previewSelectedMessage()
          else root.moveMessageCursor(dy)
          return
        }
        if (dx > 0) {
          root.activateCursor()
          return
        }
        if (dx < 0) {
          if (root.searching) root.exitSearch()
          else if (root.unreadOnly) root.toggleUnreadOnly()
          return
        }
        root.moveCursor(dy)
      }
      onActivateRequested: {
        if (root.view === "chats") root.activateCursor()
        else root.previewSelectedMessage()
      }
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (text) {
        if (root.view === "thread") {
          if (text === "i") root.focusComposer()
          return
        }
        if (text === "p") root.togglePin(root.chatAt(root.cursorIndex))
        else if (text === "u") root.toggleUnreadOnly()
        else if (text === "/") root.beginSearch()
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        // ── Header ───────────────────────────────────────────────────────
        Row {
          id: header
          width: parent.width
          spacing: Style.space(6)

          Text {
            id: backArrow
            visible: root.view === "thread"
            // nf-md-arrow_left
            text: "󰁍"
            color: backArea.containsMouse ? root.foreground : root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle

            MouseArea {
              id: backArea
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.backToChats()
            }
          }

          Column {
            id: headerText
            width: header.width - (backArrow.visible ? backArrow.width + header.spacing : 0)
            spacing: Style.space(1)

            Text {
              width: parent.width
              text: root.view === "thread"
                ? ((root.activeChat && root.activeChat.name) || "Conversation")
                : "Omaimsg"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              text: {
                if (root.statusLine.length > 0) return root.statusLine
                if (root.view === "thread") return ""
                var unread = root.client ? root.client.unread : 0
                var label = unread > 0 ? unread + " unread" : ""
                if (!root.unreadOnly) return label
                return label.length > 0 ? label + " · unread only" : "unread only"
              }
              visible: text.length > 0
              color: root.statusLine.length > 0 ? root.accent : root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }
        }

        // ── Search ───────────────────────────────────────────────────────
        TextField {
          id: searchField
          width: parent.width
          visible: root.searching
          foreground: root.foreground
          accent: root.accent
          placeholderText: "Search conversations…"
          onTextChanged: {
            root.filterText = text
            root.cursorIndex = 0
          }
          onAccepted: root.commitSearch()
          Keys.onDownPressed: function (event) {
            root.commitSearch()
            event.accepted = true
          }
          Keys.onEscapePressed: function (event) {
            root.exitSearch()
            event.accepted = true
          }
        }

        // ── Connection strip ─────────────────────────────────────────────
        Rectangle {
          width: parent.width
          visible: root.connectionStrip.length > 0
          implicitHeight: stripLabel.implicitHeight + Style.space(6)
          height: implicitHeight
          radius: Style.cornerRadius
          color: Style.normalFillFor(root.foreground, root.accent)

          Text {
            id: stripLabel
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(8)
            text: root.connectionStrip
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        PanelSeparator { foreground: root.foreground }

        // ── Chat list ────────────────────────────────────────────────────
        Column {
          width: parent.width
          spacing: Style.space(4)
          visible: root.view === "chats"
          opacity: visible ? 1 : 0

          Behavior on opacity {
            NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
          }

          Text {
            width: parent.width
            visible: root.chatsSettledEmpty
            text: {
              if (root.filterText.length > 0) return "No matches."
              if (root.unreadOnly) return "No unread conversations."
              return "No conversations yet."
            }
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          // Placeholder rows rather than a spinner: they hold the list at the
          // height the real one will occupy, so the popup does not grow when
          // the chats land. One animation drives all of them.
          Column {
            id: chatSkeleton
            width: parent.width
            visible: root.chatsLoading
            spacing: Style.space(1)

            SequentialAnimation on opacity {
              running: chatSkeleton.visible
              loops: Animation.Infinite
              NumberAnimation { to: 0.35; duration: 640; easing.type: Easing.InOutSine }
              NumberAnimation { to: 0.75; duration: 640; easing.type: Easing.InOutSine }
            }

            Repeater {
              model: 6

              delegate: Item {
                id: skeletonRow
                required property int index

                width: chatSkeleton.width
                height: Style.space(10) + nameBar.height + previewBar.height + Style.space(3)

                // Ragged on purpose: equal-length bars read as a table, not as
                // conversations waiting to arrive.
                readonly property real nameFraction: [0.42, 0.3, 0.5, 0.36, 0.46, 0.33][skeletonRow.index]
                readonly property real previewFraction: [0.78, 0.6, 0.85, 0.68, 0.55, 0.72][skeletonRow.index]

                Rectangle {
                  id: nameBar
                  x: Style.space(8)
                  y: Style.space(5)
                  width: Math.max(Style.space(40), skeletonRow.width * skeletonRow.nameFraction)
                  height: Style.font.body
                  radius: height / 2
                  color: Style.normalFillFor(root.foreground, root.accent)
                }

                Rectangle {
                  id: previewBar
                  x: Style.space(8)
                  y: nameBar.y + nameBar.height + Style.space(3)
                  width: Math.max(Style.space(60), skeletonRow.width * skeletonRow.previewFraction)
                  height: Style.font.caption
                  radius: height / 2
                  color: Style.normalFillFor(root.foreground, root.accent)
                }
              }
            }
          }

          ListView {
            id: chatList
            width: parent.width
            visible: root.visibleChats.length > 0
            height: Math.min(contentHeight, Style.space(320))
            model: chatModel
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height
            currentIndex: root.cursorIndex
            spacing: Style.space(1)
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            add: Transition {
              NumberAnimation { property: "opacity"; from: 0; to: 1; duration: 140; easing.type: Easing.OutCubic }
            }
            move: Transition {
              NumberAnimation { properties: "y"; duration: 140; easing.type: Easing.OutCubic }
            }
            displaced: Transition {
              NumberAnimation { properties: "y"; duration: 140; easing.type: Easing.OutCubic }
            }

            ListModel {
              id: chatModel
              Component.onCompleted: root.syncChatModel()
            }

            delegate: CursorSurface {
              id: chatRow
              required property int index
              required property string label
              required property string preview
              required property double ts
              required property int unread
              required property bool pinned

              width: ListView.view.width
              implicitHeight: rowText.implicitHeight + Style.space(10)
              height: implicitHeight
              foreground: root.foreground
              accent: root.accent
              hasCursor: root.focusSection === "chats" && root.cursorIndex === chatRow.index

              Column {
                id: rowText
                anchors.left: parent.left
                anchors.right: pinMark.left
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(6)
                spacing: Style.space(1)

                Text {
                  width: parent.width
                  text: chatRow.label
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: chatRow.unread > 0
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  text: chatRow.preview
                  color: root.secondaryForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              Text {
                id: pinMark
                // nf-md-pin
                text: "󰐃"
                visible: chatRow.pinned
                width: visible ? implicitWidth : 0
                anchors.right: rowMeta.left
                anchors.rightMargin: visible ? Style.space(6) : 0
                anchors.verticalCenter: parent.verticalCenter
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Column {
                id: rowMeta
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.rightMargin: Style.space(8)
                spacing: Style.space(2)
                width: Math.max(badge.implicitWidth, stamp.implicitWidth)

                Text {
                  id: stamp
                  anchors.right: parent.right
                  text: root.relativeTime(chatRow.ts)
                  color: root.secondaryForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Rectangle {
                  id: badge
                  anchors.right: parent.right
                  visible: chatRow.unread > 0
                  implicitWidth: badgeLabel.implicitWidth + Style.space(8)
                  implicitHeight: badgeLabel.implicitHeight + Style.space(2)
                  width: implicitWidth
                  height: implicitHeight
                  radius: height / 2
                  color: root.accent

                  Text {
                    id: badgeLabel
                    anchors.centerIn: parent
                    text: root.badgeText(chatRow.unread)
                    color: Color.background
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }
                }
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.cursorIndex = chatRow.index
                onClicked: root.openThread(root.chatAt(chatRow.index))
              }
            }
          }
        }

        // ── Thread ───────────────────────────────────────────────────────
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: root.view === "thread"
          opacity: visible ? 1 : 0
          onVisibleChanged: if (visible) Qt.callLater(messageList.pinToNewest)

          Behavior on opacity {
            NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
          }

          ListView {
            id: messageList
            width: parent.width
            height: Style.space(320)
            model: threadModel
            clip: true
            spacing: Style.space(4)
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            add: Transition {
              NumberAnimation { property: "opacity"; from: 0; to: 1; duration: 140; easing.type: Easing.OutCubic }
            }

            displaced: Transition {
              NumberAnimation { properties: "y"; duration: 140; easing.type: Easing.OutCubic }
            }

            // The newest message is index 0, laid out against the bottom edge.
            //
            // Scrolling to the bottom of an oldest-first list cannot be done
            // reliably: a ListView builds only the delegates near the viewport
            // and extrapolates contentHeight from their average height, so with
            // images out of view that figure is a guess, and "go to
            // contentHeight - height" goes to the wrong place. Laid out this way
            // the newest message is at a fixed position that owes nothing to the
            // content's height, so nothing an image does later can move it.
            verticalLayoutDirection: ListView.BottomToTop

            // An older page is appended at the far (oldest) end, which extends
            // the content upward without moving contentY, so the reader stays
            // on the message they were looking at.
            onAtYBeginningChanged: root.loadOlderIfAtStart()

            function pinToNewest() {
              if (root.messageIndex >= 0) return
              messageList.positionViewAtBeginning()
            }

            ListModel {
              id: threadModel
              Component.onCompleted: root.syncThreadModel()
            }

            delegate: Item {
              id: bubbleRow
              required property int index
              required property bool fromMe
              required property string sender
              required property string body
              required property string images
              required property double ts
              required property bool pending
              required property bool failed

              width: ListView.view.width
              implicitHeight: bubble.height
              height: implicitHeight

              readonly property real pad: Style.space(8)
              // Each label's width comes from its own natural (unwrapped)
              // implicitWidth, and the bubble from those labels. Anchoring the
              // content to both bubble edges instead would make the bubble's
              // width depend on content that depends on the bubble: a binding
              // loop, which collapses every bubble to a few pixels.
              readonly property real maxInner: Math.max(Style.space(60), bubbleRow.width * 0.82 - bubbleRow.pad * 2)
              readonly property bool showSender: !bubbleRow.fromMe
                && root.threadIsGroup
                && !!bubbleRow.sender
              // A ListModel role cannot hold an array: a nested one comes
              // back as another ListModel, not the objects that went in, so
              // the row carries the images serialised instead.
              readonly property var imageAttachments: JSON.parse(bubbleRow.images)
              readonly property bool selected: root.messageIndex === bubbleRow.index
              readonly property real imageWidth: bubbleRow.imageAttachments.length > 0
                ? Math.min(bubbleRow.maxInner, Style.space(180))
                : 0

              Rectangle {
                id: bubble
                width: bubbleContent.width + bubbleRow.pad * 2
                height: bubbleContent.implicitHeight + bubbleRow.pad
                anchors.right: bubbleRow.fromMe ? parent.right : undefined
                anchors.left: bubbleRow.fromMe ? undefined : parent.left
                radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(6)
                border.width: bubbleRow.selected ? 1 : 0
                border.color: root.accent
                opacity: bubbleRow.pending ? 0.6 : 1.0
                color: bubbleRow.fromMe
                  ? Style.selectedFillFor(root.foreground, root.accent)
                  : Style.normalFillFor(root.foreground, root.accent)

                // The send settles rather than snapping: every other state
                // change in this panel animates, and a bare opacity flip at the
                // moment the ack lands reads as a flicker.
                Behavior on opacity {
                  NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
                }

                Column {
                  id: bubbleContent
                  x: bubbleRow.pad
                  y: bubbleRow.pad / 2
                  spacing: Style.space(1)
                  width: Math.max(
                    bubbleRow.showSender ? senderLabel.width : 0,
                    bubbleRow.imageWidth,
                    bodyLabel.width,
                    Math.min(metaLabel.implicitWidth, bubbleRow.maxInner))

                  Text {
                    id: senderLabel
                    visible: bubbleRow.showSender
                    width: Math.min(implicitWidth, bubbleRow.maxInner)
                    text: bubbleRow.sender
                    color: root.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    elide: Text.ElideRight
                  }

                  Repeater {
                    model: bubbleRow.imageAttachments

                    delegate: Rectangle {
                      id: imageFrame
                      required property var modelData

                      readonly property string localPath: root.client
                        ? (root.client.attachmentPaths[imageFrame.modelData.guid] || "")
                        : ""
                      // The dimensions the server reported, which the resized
                      // thumbnail preserves. Preferred over the decoded image
                      // even once that is ready: switching between them is the
                      // relayout this is here to avoid.
                      readonly property real declaredRatio: imageFrame.modelData.width > 0
                        && imageFrame.modelData.height > 0
                        ? imageFrame.modelData.height / imageFrame.modelData.width
                        : 0

                      width: bubbleRow.imageWidth
                      height: {
                        if (imageFrame.declaredRatio > 0)
                          return Math.max(1, Math.round(width * imageFrame.declaredRatio))
                        if (picture.status === Image.Ready)
                          return Math.max(1, Math.round(width * picture.implicitHeight / Math.max(1, picture.implicitWidth)))
                        return Style.space(100)
                      }
                      radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(6)
                      color: Style.normalFillFor(root.foreground, root.accent)

                      Component.onCompleted: if (root.client) root.client.requestAttachment(imageFrame.modelData.guid)

                      Image {
                        id: picture
                        anchors.fill: parent
                        source: imageFrame.localPath
                        asynchronous: true
                        fillMode: Image.PreserveAspectFit
                        opacity: status === Image.Ready ? 1 : 0

                        Behavior on opacity {
                          NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
                        }
                      }

                      Text {
                        anchors.centerIn: parent
                        opacity: picture.status === Image.Ready ? 0 : 1

                        Behavior on opacity {
                          NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
                        }
                        // nf-md-image, or nf-md-image_off once loading failed
                        text: picture.status === Image.Error ? "󰋫" : "󰋩"
                        color: root.secondaryForeground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.subtitle
                      }

                      MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: if (root.client) root.client.requestPreview(imageFrame.modelData.guid)
                      }
                    }
                  }

                  Text {
                    id: bodyLabel
                    visible: bubbleRow.body.length > 0
                    width: Math.min(implicitWidth, bubbleRow.maxInner)
                    text: root.linkify(bubbleRow.body)
                    textFormat: Text.StyledText
                    color: root.foreground
                    linkColor: root.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    wrapMode: Text.Wrap
                    onLinkActivated: function (link) { Qt.openUrlExternally(link) }

                    MouseArea {
                      anchors.fill: parent
                      acceptedButtons: Qt.NoButton
                      hoverEnabled: true
                      cursorShape: bodyLabel.hoveredLink.length > 0
                        ? Qt.PointingHandCursor
                        : Qt.ArrowCursor
                    }
                  }

                  Text {
                    id: metaLabel
                    width: parent.width
                    horizontalAlignment: Text.AlignRight
                    text: {
                      if (bubbleRow.failed) return "failed"
                      if (bubbleRow.pending) return "sending…"
                      return root.clockTime(bubbleRow.ts)
                    }
                    color: bubbleRow.failed ? root.accent : root.secondaryForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: root.messages.length === 0
            // "No messages yet." is a claim about the chat, so it waits until a
            // page has actually come back; until then the thread is loading.
            // The Mac can hold a chat whose messages it never linked to it, and
            // no BlueBubbles route reaches those -- say so rather than implying
            // the conversation is empty.
            text: root.threadUnavailable
              ? "The Mac has no messages filed under this conversation."
              : (root.threadLoaded ? "No messages yet." : "Loading…")
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          TextField {
            id: composer
            width: parent.width
            foreground: root.foreground
            accent: root.accent
            placeholderText: root.connected ? "Message…" : "Not connected"
            enabled: root.connected
            onAccepted: root.send()
            Keys.onEscapePressed: function (event) {
              root.focusSection = "messages"
              keyCatcher.forceActiveFocus()
              event.accepted = true
            }
          }
        }
      }
    }
  }
}
