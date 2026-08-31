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
    try {
      var parsed = JSON.parse(manifestFile.text())
      if (parsed && typeof parsed.id === "string" && parsed.id.length > 0) return parsed.id
    } catch (e) {
    }
    return root.pluginDir.substring(root.pluginDir.lastIndexOf("/") + 1)
  }

  readonly property int unread: client.unread
  readonly property bool showCount: root.setting("showUnreadCount", true) === true

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
    text: root.showCount && root.unread > 0
      ? root.glyph + " " + (root.unread > 99 ? "99+" : String(root.unread))
      : root.glyph
    active: root.unread > 0
    dimmed: !client.linkUp
    tooltipText: {
      if (!client.linkUp) return client.daemonStarting ? "Omaimsg · starting daemon" : "Omaimsg · daemon offline"
      if (root.unread > 0) return "Omaimsg · " + root.unread + " unread"
      return "Omaimsg"
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }
}
