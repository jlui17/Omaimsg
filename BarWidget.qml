import QtQuick
import Quickshell.Io
import qs.Ui

// Bar entry point. Owns the daemon connection and hosts Panel.qml, mirroring
// the first-party clock/audio widgets: one manifest kind, panel loaded inside.
BarWidget {
  id: root
  // The host overwrites this after load with the bar-layout entry id
  // (Bar.qml's ModuleSlot.injectProps), which for a plugin is this same id.
  // The binding is what the widget answers to before that and outside a bar.
  moduleName: root.pluginId

  // nf-md-message_text
  readonly property string glyph: "󰍡"

  readonly property string pluginDir: {
    var url = Qt.resolvedUrl(".").toString()
    if (url.indexOf("file://") === 0) url = url.substring(7)
    if (url.length > 1 && url.charAt(url.length - 1) === "/") url = url.substring(0, url.length - 1)
    return decodeURIComponent(url)
  }

  // The plugin's own id, as the host registry knows it. Read here once and
  // handed down, so a copy installed under a different id is a separate widget,
  // a separate IPC target, and a separate daemon. `omarchy plugin add` installs
  // a plugin into a directory named after this id, which is why the directory
  // is the honest fallback when the manifest cannot be read.
  readonly property string pluginId: {
    var parsed = root.readJson(manifestFile)
    if (parsed && typeof parsed.id === "string" && parsed.id.length > 0) return parsed.id
    return root.pluginDir.substring(root.pluginDir.lastIndexOf("/") + 1)
  }

  function readJson(view) {
    try {
      var parsed = JSON.parse(view.text())
      if (parsed && typeof parsed === "object") return parsed
    } catch (e) {
    }
    return null
  }

  readonly property int unread: client.unread
  readonly property bool showCount: root.setting("showUnreadCount", true) === true
  readonly property string countLabel: root.showCount && root.unread > 0
    ? (root.unread > 99 ? "99+" : String(root.unread))
    : ""

  // install.sh is the only thing that can know this install is a variant: once
  // the manifest is rewritten the copy agrees with itself. So it records the
  // answer and the widget reads it, holding no rule of its own.
  readonly property var deploy: root.readJson(deployFile)
  readonly property bool variant: root.deploy ? root.deploy.variant === true : false

  // Only a variant says anything, so the install you actually use stays quiet.
  // A variant whose stamp names no commit says so rather than showing nothing,
  // which would read as the canonical install.
  readonly property string buildLine: {
    if (!root.variant) return ""
    var branch = root.deploy.branch || ""
    var sha = root.deploy.sha || ""
    if (branch.length === 0 || sha.length === 0) return root.pluginId + " · no build stamp"
    return root.pluginId + " · " + branch + " @ " + sha
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    if (!panelLoader.item) return
    panelLoader.item.bar = root.bar
    panelLoader.item.anchorItem = button
    panelLoader.item.hostWidget = root
    panelLoader.item.pluginId = root.pluginId
    panelLoader.item.buildLine = root.buildLine
    panelLoader.item.client = client
    panelLoader.item.settings = root.settings
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  FileView {
    id: manifestFile
    path: root.pluginDir + "/manifest.json"
    blockLoading: true
  }

  // Absent by design in a tree nobody ran install.sh over, so a failed read is
  // not a fault to report — it is the quiet the canonical install wants.
  FileView {
    id: deployFile
    path: root.pluginDir + "/.deploy.json"
    blockLoading: true
    printErrors: false
  }

  Client {
    id: client
    pluginDir: root.pluginDir
    pluginId: root.pluginId
    chatLimit: root.setting("chatLimit", 40)
    autostartDaemon: root.setting("autostartDaemon", true) === true
  }

  IpcHandler {
    target: root.pluginId
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: {
      var parts = []
      if (root.variant) parts.push(root.pluginId)
      if (root.countLabel.length > 0) parts.push(root.countLabel)
      return parts.length > 0 ? root.glyph + " " + parts.join(" · ") : root.glyph
    }
    active: root.unread > 0
    dimmed: !client.linkUp
    tooltipText: {
      var name = root.variant ? "Omaimsg " + root.pluginId : "Omaimsg"
      if (!client.linkUp) return client.daemonStarting ? name + " · starting daemon" : name + " · daemon offline"
      if (root.unread > 0) return name + " · " + root.unread + " unread conversation" + (root.unread === 1 ? "" : "s")
      return name
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }
}
