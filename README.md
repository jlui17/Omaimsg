# omaimsg

Proof of concept: iMessage in the Omarchy menu bar. A bar-widget plugin (Quickshell QML popup: chat list, thread view, compose) backed by a Node daemon that talks to a [BlueBubbles](https://bluebubbles.app) server running on a Mac. Keyboard-native: `j`/`k` through chats and through a thread's messages, `Enter` or `l` opens a thread or previews a selected image, `i` focuses the composer, `Enter` sends, `u` narrows the list to chats with unread messages, `Esc` or `h` walks back out a layer at a time.

Prototype code answering one question: is a keyboard-driven iMessage popup in the bar actually pleasant to use? Bridge choice, plugin architecture, and the precedents this copies are in `docs/research/`; the daemon↔plugin wire contract is `docs/daemon-protocol.md`.

## Layout

- `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Client.qml` — the Omarchy shell plugin, at the repo root (required by `omarchy plugin add`, which clones the repo straight into the plugins dir).
- `daemon/` — Node daemon. Speaks REST + Socket.IO to BlueBubbles, serves NDJSON over a Unix socket (`$XDG_RUNTIME_DIR/io.omaimsg.sock`) to the plugin. One daemon, many plugin clients (one per monitor).
- `test/` — the test harness: a fake BlueBubbles server with canned chats, `smoke.js` for the daemon over the real Unix socket, and `qsmcp/` for the plugin rendered headlessly. See `TESTING.md`.

## Install

```sh
omarchy plugin add https://github.com/jlui17/Omaimsg.git --enable
```

To remove it: `omarchy plugin remove io.omaimsg`.

## Run against the fake BlueBubbles server

Dev tooling is pinned in `mise.toml` (Node and Bun); `mise install` gets both.

```sh
mise run setup                     # dependencies
node test/server.js                # fake BlueBubbles on :3010
OMAIMSG_CONFIG=test/config.json node daemon/index.js
rsync -a --delete --exclude .git --exclude node_modules --exclude .worktrees \
  --exclude .mcp.json --exclude .claude --exclude mise.toml --exclude /test/qsmcp/stage \
  ./ ~/.config/omarchy/plugins/io.omaimsg/
omarchy plugin enable io.omaimsg   # widget lands in the bar's right section
```

The plugin dir must be a real copy, not a symlink: the shell's file watcher doesn't see writes through a symlink, so hot reload never fires. And hot reload only refreshes panel code; a changed `BarWidget.qml` (anything touching the bar widget instance or its `IpcHandler`) needs `omarchy-restart-shell` to re-instantiate. `omarchy-shell io.omaimsg toggle` opens/closes the panel from a script or keybinding.

`node test/smoke.js` runs the whole daemon protocol end to end without the shell.

## Run a second copy beside the one you use

The manifest `id` is the plugin's identity, and everything else follows from it: the bar entry, the `omarchy-shell` IPC target, the daemon's socket, and the daemon's config, pins, and attachment cache. Install a copy under a different id and it cannot touch the one you use.

```sh
rsync -a --delete --exclude .git --exclude node_modules --exclude .worktrees \
  --exclude .mcp.json --exclude .claude --exclude mise.toml --exclude /test/qsmcp/stage \
  ./ ~/.config/omarchy/plugins/io.omaimsg.b/
jq '.id = "io.omaimsg.b"' manifest.json >~/.config/omarchy/plugins/io.omaimsg.b/manifest.json
omarchy plugin enable io.omaimsg.b
```

Every state path is named after the id with no exception, so give the copy its own `~/.config/io.omaimsg.b/config.json` pointing at `test/server.js` rather than the real Mac, or a send from it lands in a real conversation. `omarchy-shell io.omaimsg.b toggle` drives it.

## Run against a real Mac

`~/.config/io.omaimsg/config.json` (under `$XDG_CONFIG_HOME` if you set that variable):

```json
{ "serverUrl": "http://<mac-ip>:1234", "password": "<bluebubbles server password>" }
```

Optional `"cache": { "threads": 30, "messagesPerThread": 60 }` sets how much the daemon holds in memory, and `messagesPerThread` is also the page size it serves a thread in — the panel pages further back by scrolling to the top (`docs/daemon-protocol.md`).

Then `node daemon/index.js` (the plugin also autostarts it: `omaimsg-daemon@io.omaimsg.service` if installed, else the bundled fallback `daemon/dist/omaimsg-daemon.cjs`, `setsid node <plugin-dir>/daemon/dist/omaimsg-daemon.cjs`). A template unit must pass its instance through as `Environment=OMAIMSG_PLUGIN_ID=%i`, or the daemon binds the canonical paths while the widget waits on the variant's socket: `systemctl start` succeeded, so the widget never falls back to spawning its own. Sending uses BlueBubbles' `apple-script` method by default (no Private API/SIP setup needed on the Mac); set `"method": "private-api"` in the config if the server has it enabled.

The bundle is committed (`daemon/dist/omaimsg-daemon.cjs`, built with `bun run bundle`) because a plugin installed via `omarchy plugin add` is a plain git clone with no build step and no `node_modules`. Any change to `daemon/` must re-run `bun run bundle` and commit the result in the same round.

## Contributing

```sh
sudo pacman -S sway cue jq wtype   # UI checks only
bun install
mise run test                      # daemon protocol, the committed bundle, then the UI
```

`TESTING.md` has the rest: what each suite covers, the two manual checks, and the headless harness
an agent uses to drive the plugin.

Issues live on GitHub (`gh` CLI). A ticket lands as one commit closing it (`Closes #N`);
adjustments asked for mid-round get squashed into that commit. Review feedback on an open PR is
the other case and keeps one commit per item.

## POC scope

Text messages and inline images (thumbnail-sized, cached under `~/.cache/omaimsg/`); clicking an image opens it in the system viewer, thumbnail first, upgrading in place once the full-size download lands. URLs in message text render as links and open in the browser on click. Non-image attachments render as `[attachment]`. Deferred, not dropped: tapbacks, typing indicators, read-receipt sync back to Apple (reading a chat here does not mark it read on the Mac; that needs the Private API), message cache persistence.
