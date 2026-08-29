# omaimsg

Proof of concept: iMessage in the Omarchy menu bar. A bar-widget plugin (Quickshell QML popup: chat list, thread view, compose) backed by a Node daemon that talks to a [BlueBubbles](https://bluebubbles.app) server running on a Mac. Keyboard-native: `j`/`k` through chats, `Enter` or `l` opens a thread, `i` focuses the composer, `Enter` sends, `Esc` or `h` walks back out a layer at a time.

Prototype code answering one question: is a keyboard-driven iMessage popup in the bar actually pleasant to use? Bridge choice, plugin architecture, and the precedents this copies are in `docs/research/`; the daemon↔plugin wire contract is `docs/daemon-protocol.md`.

## Layout

- `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Client.qml` — the Omarchy shell plugin, at the repo root (required by `omarchy plugin add`, which clones the repo straight into the plugins dir).
- `daemon/` — Node daemon. Speaks REST + Socket.IO to BlueBubbles, serves NDJSON over a Unix socket (`$XDG_RUNTIME_DIR/omaimsg.sock`) to the plugin. One daemon, many plugin clients (one per monitor).
- `test/` — the test harness: a fake BlueBubbles server with canned chats, plus `smoke.js`, an end-to-end test of the daemon over the real Unix socket.

## Install

```sh
omarchy plugin add https://github.com/jlui17/Omaimsg.git --enable
```

To remove it: `omarchy plugin remove io.omaimsg`.

## Run against the fake BlueBubbles server

```sh
bun install
node test/server.js                # fake BlueBubbles on :3010
OMAIMSG_CONFIG=test/config.json node daemon/index.js
rsync -a --delete --exclude .git --exclude node_modules --exclude .worktrees ./ ~/.config/omarchy/plugins/io.omaimsg/
omarchy plugin enable io.omaimsg   # widget lands in the bar's right section
```

The plugin dir must be a real copy, not a symlink: the shell's file watcher doesn't see writes through a symlink, so hot reload never fires. And hot reload only refreshes panel code; a changed `BarWidget.qml` (anything touching the bar widget instance or its `IpcHandler`) needs `omarchy-restart-shell` to re-instantiate. `omarchy-shell io.omaimsg toggle` opens/closes the panel from a script or keybinding.

`node test/smoke.js` runs the whole daemon protocol end to end without the shell.

## Run against a real Mac

`~/.config/omaimsg/config.json`:

```json
{ "serverUrl": "http://<mac-ip>:1234", "password": "<bluebubbles server password>" }
```

Then `node daemon/index.js` (the plugin also autostarts it: `omaimsg-daemon.service` if installed, else the bundled fallback `daemon/dist/omaimsg-daemon.cjs`, `setsid node <plugin-dir>/daemon/dist/omaimsg-daemon.cjs`). Sending uses BlueBubbles' `apple-script` method by default (no Private API/SIP setup needed on the Mac); set `"method": "private-api"` in the config if the server has it enabled.

The bundle is committed (`daemon/dist/omaimsg-daemon.cjs`, built with `bun run bundle`) because a plugin installed via `omarchy plugin add` is a plain git clone with no build step and no `node_modules`. Any change to `daemon/` must re-run `bun run bundle` and commit the result in the same round.

## POC scope

Text messages and inline images (thumbnail-sized, cached under `~/.cache/omaimsg/`); clicking an image opens it in the system viewer, thumbnail first, upgrading in place once the full-size download lands. Non-image attachments render as `[attachment]`. Deferred, not dropped: tapbacks, typing indicators, read-receipt sync back to Apple, message cache persistence (unread counts reset with the daemon).
