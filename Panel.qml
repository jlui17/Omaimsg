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

  readonly property var chats: client ? client.chats : []
  readonly property string activeGuid: client ? client.activeChatGuid : ""
  readonly property var messages: client ? client.activeMessages : []
  readonly property int chatLimit: root.setting("chatLimit", 40)
  readonly property int messageLimit: root.setting("messageLimit", 60)

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

  readonly property bool threadIsGroup: root.activeChat ? root.activeChat.isGroup === true : false

  readonly property string connectionStrip: {
    if (!root.linkUp)
      return "Daemon offline" + root.detail(root.client ? root.client.lastSocketError : "")
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

  function badgeText(count) {
    var n = Math.max(0, count | 0)
    return n > 99 ? "99+" : String(n)
  }

  function cursorToGuid(guid) {
    for (var i = 0; i < root.visibleChats.length; i++) {
      if (root.visibleChats[i].guid !== guid) continue
      root.cursorIndex = i
      chatList.positionViewAtIndex(i, ListView.Contain)
      return
    }
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
  function moveMessageCursor(delta) {
    var count = root.messages.length
    if (count === 0) return
    if (root.messageIndex < 0) {
      if (delta > 0) return
      root.messageIndex = count - 1
    } else {
      var next = root.messageIndex + delta
      if (next >= count) {
        root.messageIndex = -1
        return
      }
      root.messageIndex = Math.max(0, next)
    }
    messageList.positionViewAtIndex(root.messageIndex, ListView.Contain)
  }

  function previewSelectedMessage() {
    if (root.messageIndex < 0 || !root.client) return
    var images = root.imageAttachmentsOf(root.messages[root.messageIndex])
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
      root.client.openChat(chat.guid, root.messageLimit)
      root.client.markRead(chat.guid)
    }
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  function activateCursor() {
    root.openThread(root.chatAt(root.cursorIndex))
  }

  function beginSearch() {
    root.focusSection = "search"
    Qt.callLater(function () { searchField.forceActiveFocus() })
    if (root.searching) return
    root.searching = true
    root.cursorIndex = 0
    // The filter should see more conversations than the list renders, so pull a
    // deeper page for as long as search is up.
    if (root.client) root.client.requestChats(200)
  }

  // Drops the filter and the deep page without touching focus: callers decide
  // where the cursor goes next.
  function clearSearch() {
    root.searching = false
    searchField.text = ""
    root.filterText = ""
    root.cursorIndex = 0
    if (root.client) root.client.requestChats(root.chatLimit)
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

  onVisibleChatsChanged: {
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
    root.client.requestChats(root.chatLimit)
    if (root.view !== "thread" || !root.activeGuid) return
    root.client.reloadActiveMessages(root.messageLimit)
    root.client.markRead(root.activeGuid)
    root.messageIndex = -1
    root.focusSection = "messages"
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  Connections {
    target: root.client
    enabled: root.client !== null

    function onActiveMessagesAppended() {
      if (root.messageIndex >= 0) return
      Qt.callLater(function () { messageList.positionViewAtEnd() })
    }

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
                return unread > 0 ? unread + " unread" : ""
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

          Text {
            width: parent.width
            visible: root.visibleChats.length === 0
            text: root.filterText.length > 0 ? "No matches." : "No conversations yet."
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          ListView {
            id: chatList
            width: parent.width
            visible: root.visibleChats.length > 0
            height: Math.min(contentHeight, Style.space(320))
            model: root.visibleChats
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height
            currentIndex: root.cursorIndex
            spacing: Style.space(1)
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            delegate: CursorSurface {
              id: chatRow
              required property var modelData
              required property int index

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
                  text: chatRow.modelData.name || chatRow.modelData.guid
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: (chatRow.modelData.unread || 0) > 0
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  text: root.chatPreview(chatRow.modelData)
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
                visible: chatRow.modelData.pinned === true
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
                  text: chatRow.modelData.lastMessage
                    ? root.relativeTime(chatRow.modelData.lastMessage.ts)
                    : ""
                  color: root.secondaryForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Rectangle {
                  id: badge
                  anchors.right: parent.right
                  visible: (chatRow.modelData.unread || 0) > 0
                  implicitWidth: badgeLabel.implicitWidth + Style.space(8)
                  implicitHeight: badgeLabel.implicitHeight + Style.space(2)
                  width: implicitWidth
                  height: implicitHeight
                  radius: height / 2
                  color: root.accent

                  Text {
                    id: badgeLabel
                    anchors.centerIn: parent
                    text: root.badgeText(chatRow.modelData.unread)
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
                onClicked: root.openThread(chatRow.modelData)
              }
            }
          }
        }

        // ── Thread ───────────────────────────────────────────────────────
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: root.view === "thread"

          ListView {
            id: messageList
            width: parent.width
            height: Style.space(320)
            model: root.messages
            clip: true
            spacing: Style.space(4)
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            delegate: Item {
              id: bubbleRow
              required property var modelData
              required property int index

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
              readonly property bool showSender: !bubbleRow.modelData.fromMe
                && root.threadIsGroup
                && !!bubbleRow.modelData.sender
              readonly property var imageAttachments: root.imageAttachmentsOf(bubbleRow.modelData)
              readonly property bool selected: root.messageIndex === bubbleRow.index
              readonly property real imageWidth: bubbleRow.imageAttachments.length > 0
                ? Math.min(bubbleRow.maxInner, Style.space(180))
                : 0
              // The daemon substitutes "[attachment]" for attachment-only
              // messages (docs/daemon-protocol.md); when the image itself is
              // rendered here, that placeholder is noise.
              readonly property string bodyText: {
                var t = bubbleRow.modelData.text || ""
                return t === "[attachment]" && bubbleRow.imageAttachments.length > 0 ? "" : t
              }

              Rectangle {
                id: bubble
                width: bubbleContent.width + bubbleRow.pad * 2
                height: bubbleContent.implicitHeight + bubbleRow.pad
                anchors.right: bubbleRow.modelData.fromMe ? parent.right : undefined
                anchors.left: bubbleRow.modelData.fromMe ? undefined : parent.left
                radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(6)
                border.width: bubbleRow.selected ? 1 : 0
                border.color: root.accent
                opacity: bubbleRow.modelData.pending ? 0.6 : 1.0
                color: bubbleRow.modelData.fromMe
                  ? Style.selectedFillFor(root.foreground, root.accent)
                  : Style.normalFillFor(root.foreground, root.accent)

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
                    text: bubbleRow.modelData.sender || ""
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

                      width: bubbleRow.imageWidth
                      height: picture.status === Image.Ready
                        ? Math.max(1, Math.round(width * picture.implicitHeight / Math.max(1, picture.implicitWidth)))
                        : Style.space(100)
                      radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(6)
                      color: Style.normalFillFor(root.foreground, root.accent)

                      Component.onCompleted: if (root.client) root.client.requestAttachment(imageFrame.modelData.guid)

                      Image {
                        id: picture
                        anchors.fill: parent
                        source: imageFrame.localPath
                        asynchronous: true
                        fillMode: Image.PreserveAspectFit
                        visible: status === Image.Ready
                      }

                      Text {
                        anchors.centerIn: parent
                        visible: picture.status !== Image.Ready
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
                    visible: text.length > 0
                    width: Math.min(implicitWidth, bubbleRow.maxInner)
                    text: bubbleRow.bodyText
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    wrapMode: Text.Wrap
                  }

                  Text {
                    id: metaLabel
                    width: parent.width
                    horizontalAlignment: Text.AlignRight
                    text: {
                      if (bubbleRow.modelData.failed) return "failed"
                      if (bubbleRow.modelData.pending) return "sending…"
                      return root.clockTime(bubbleRow.modelData.ts)
                    }
                    color: bubbleRow.modelData.failed ? root.accent : root.secondaryForeground
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
            text: "No messages yet."
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
