# omaimsg

Proof of concept: iMessage in the Omarchy menu bar. A bar-widget plugin (Quickshell QML popup: chat list, thread view, compose) backed by a Node daemon that talks to a [BlueBubbles](https://bluebubbles.app) server running on a Mac. Keyboard-native: `j`/`k` through chats, `Enter` opens a thread with the composer focused, `Enter` sends, `Esc` walks back out.

Prototype code answering one question: is a keyboard-driven iMessage popup in the bar actually pleasant to use? Bridge choice, plugin architecture, and the precedents this copies are in `docs/research/`; the daemon↔plugin wire contract is `docs/daemon-protocol.md`.

## Layout

- `daemon/` — Node daemon. Speaks REST + Socket.IO to BlueBubbles, serves NDJSON over a Unix socket (`$XDG_RUNTIME_DIR/omaimsg.sock`) to the plugin. One daemon, many plugin clients (one per monitor).
- `plugin/` — the Omarchy shell plugin (`manifest.json`, `BarWidget.qml`, `Panel.qml`, `Client.qml`).
- `mock/` — fake BlueBubbles server with canned chats for development, plus `smoke.js`, an end-to-end test of the daemon over the real Unix socket.

## Run against the mock

```sh
npm install
node mock/server.js                # fake BlueBubbles on :3010
OMAIMSG_CONFIG=mock/config.json node daemon/index.js
cp -r plugin ~/.config/omarchy/plugins/io.omaimsg
omarchy plugin enable io.omaimsg   # widget lands in the bar's right section
```

The plugin dir must be a real copy, not a symlink: the shell's file watcher doesn't see writes through a symlink, so hot reload never fires. And hot reload only refreshes panel code; a changed `BarWidget.qml` (anything touching the bar widget instance or its `IpcHandler`) needs `omarchy-restart-shell` to re-instantiate. `omarchy-shell io.omaimsg toggle` opens/closes the panel from a script or keybinding.

`node mock/smoke.js` runs the whole daemon protocol end to end without the shell.

## Run against a real Mac

`~/.config/omaimsg/config.json`:

```json
{ "serverUrl": "http://<mac-ip>:1234", "password": "<bluebubbles server password>" }
```

Then `node daemon/index.js` (the plugin also autostarts it: `omaimsg-daemon.service` if installed, else `setsid node daemon/index.js`). Sending uses BlueBubbles' `apple-script` method by default (no Private API/SIP setup needed on the Mac); set `"method": "private-api"` in the config if the server has it enabled.

## POC scope

Text messages only. Deferred, not dropped: attachments (rendered as `[attachment]`), tapbacks, typing indicators, read-receipt sync back to Apple, message cache persistence (unread counts reset with the daemon).
