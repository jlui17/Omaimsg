# omaimsg

Proof of concept: iMessage in the Omarchy menu bar. A bar-widget plugin (Quickshell QML popup: chat list, thread view, compose) backed by a Node daemon that talks to a [BlueBubbles](https://bluebubbles.app) server running on a Mac. Keyboard-native: `j`/`k` through chats and through a thread's messages, `Enter` or `l` opens a thread or previews a selected image, `i` focuses the composer, `Enter` sends, `a` picks images to send, `u` narrows the list to chats with unread messages, `Esc` or `h` walks back out a layer at a time.

Prototype code answering one question: is a keyboard-driven iMessage popup in the bar actually pleasant to use? Bridge choice, plugin architecture, and the precedents this copies are in `docs/research/`; the daemon↔plugin wire contract is `docs/daemon-protocol.md`.

## Layout

- `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Client.qml` — the Omarchy shell plugin, at the repo root (required by `omarchy plugin add`, which clones the repo straight into the plugins dir).
- `daemon/` — Node daemon. Speaks REST + Socket.IO to BlueBubbles, serves NDJSON over a Unix socket (`$XDG_RUNTIME_DIR/io.omaimsg.sock`) to the plugin. One daemon, many plugin clients (one per monitor).
- `test/` — the test harness: a fake BlueBubbles server with canned chats, `smoke.js` for the daemon over the real Unix socket, and `qsmcp/` for the plugin rendered headlessly. See `TESTING.md`.

## Install

```sh
omarchy plugin add https://github.com/jlui17/Omaimsg.git
~/.config/omarchy/plugins/io.omaimsg/install.sh
```

`omarchy plugin add` only clones and validates — it never runs anything from a plugin. `install.sh`
does the rest: installs the daemon's dependency with the pinned npm, writes a config template,
installs and (re)starts `omaimsg-daemon@io.omaimsg.service`, and adds the widget to the bar. It is
safe to re-run: a re-install restarts the daemon onto the code it just copied in, and restarts the
shell so a changed widget is re-instantiated rather than silently ignored. Pass `--no-restart` to
skip that last step.

It prints the path of the config template it wrote. Fill in your BlueBubbles server URL and
password (see [Run against a real Mac](#run-against-a-real-mac)), then:

```sh
systemctl --user restart omaimsg-daemon@io.omaimsg.service
```

To remove it, including the config file holding your server password:

```sh
~/.config/omarchy/plugins/io.omaimsg/install.sh --uninstall
```

`--uninstall` acts on that one plugin id: it stops and disables its service, removes its plugin
directory, and deletes its config, pins, attachment cache, and socket. A second copy installed
under another id is left alone, and the shared unit template goes only when the last instance does.

## Run against the fake BlueBubbles server

Dev tooling is pinned in `mise.toml` (Node and npm); `mise install` gets both.

```sh
mise run setup                     # dependencies
node test/server.js                # fake BlueBubbles on :3010
OMAIMSG_CONFIG=test/config.json node daemon/index.js
./install.sh                       # copies this checkout into the plugins dir and wires it up
```

Run from a checkout, `install.sh` copies the tree in first; run from the installed copy, it skips
the copy and does the rest. It owns the exclude list, so there is one copy of what an install
leaves behind.

The plugin dir must be a real copy, not a symlink: the shell's file watcher doesn't see writes through a symlink, so hot reload never fires. And hot reload only refreshes panel code; a changed `BarWidget.qml` (anything touching the bar widget instance or its `IpcHandler`) needs `omarchy-restart-shell` to re-instantiate. `omarchy-shell io.omaimsg toggle` opens/closes the panel from a script or keybinding.

`node test/smoke.js` runs the whole daemon protocol end to end without the shell.

## Run a second copy beside the one you use

The manifest `id` is the plugin's identity, and everything else follows from it: the bar entry, the `omarchy-shell` IPC target, the daemon's socket, and the daemon's config, pins, and attachment cache. Install a copy under a different id and it cannot touch the one you use.

```sh
./install.sh io.omaimsg.b
```

Given an id, `install.sh` installs under it instead of the one the manifest names, rewriting the
manifest in the copy so the install genuinely is that id. Several at once share one shell restart:

```sh
./install.sh io.omaimsg.b --no-restart
./install.sh io.omaimsg.c --no-restart
omarchy-restart-shell
```

**Each one says which build it is.** A variant renders its id beside the glyph (`󰍡 io.omaimsg.b`,
and `󰍡 io.omaimsg.b · 3` with unread), and its panel header carries the branch and short sha it was
installed from. The install you actually use renders neither, so a normal install stays quiet.

Both come from `.deploy.json`, which `install.sh` writes into the plugin directory at install time:
the rsync drops `.git`, so the copy cannot work out its own provenance, and nothing about the build
can be set by hand in a setting that would later go stale and lie. A variant installed from a tree
with no git history says `no build stamp` rather than rendering as though it were canonical.

Every state path is named after the id with no exception, so give the copy its own `~/.config/io.omaimsg.b/config.json` pointing at `test/server.js` rather than the real Mac, or a send from it lands in a real conversation. `omarchy-shell io.omaimsg.b toggle` drives it. `./install.sh --uninstall io.omaimsg.b` takes it away again and leaves the others alone.

## Run against a real Mac

`~/.config/io.omaimsg/config.json` (under `$XDG_CONFIG_HOME` if you set that variable):

```json
{ "serverUrl": "http://<mac-ip>:1234", "password": "<bluebubbles server password>" }
```

Optional `"cache": { "threads": 30, "messagesPerThread": 60 }` sets how much the daemon holds, and `messagesPerThread` is also the page size it serves a thread in — the panel pages further back by scrolling to the top (`docs/daemon-protocol.md`).

Optional `"notifications": false` silences the desktop notification an inbound message raises. It is a daemon setting rather than a manifest one because the daemon raises the toast, and manifest settings reach the QML only.

Then `node daemon/index.js` (the plugin also autostarts it: `omaimsg-daemon@io.omaimsg.service` if installed, else `setsid node <plugin-dir>/daemon/index.js`). The unit `install.sh` writes is the template in `systemd/`, with `%i` standing for both the plugin id and the directory it is installed under, so one file serves any number of installs. It passes its instance through as `Environment=OMAIMSG_PLUGIN_ID=%i`; without that the daemon binds the canonical paths while the widget waits on the variant's socket, and because `systemctl start` succeeded the widget never falls back to spawning its own. `ExecStart` is written with an absolute node path resolved at install time, because a systemd user unit's PATH does not include mise's shims. Sending uses BlueBubbles' `apple-script` method by default (no Private API/SIP setup needed on the Mac); set `"method": "private-api"` in the config if the server has it enabled.

The panel renders from `~/.cache/io.omaimsg/cache.json` on a restart, so it comes up populated before BlueBubbles answers a fetch that pages the whole account. Delete it and the first open is slower; nothing else changes.

### What the unread badge counts

The bar badge counts **conversations** with something unread; a chat's own badge counts its unread **messages**, so the two do not add up to each other.

A message is unread when it is newer than the chat's read boundary, which is the later of what Apple says the account has seen and what you have opened here. The first half is re-derived from the server on every daemon start. The second is a timestamp per chat in `~/.local/state/io.omaimsg/read-state.json`, which is why opening a chat here keeps it read across restarts — and why deleting that file makes chats unread again.

Reading a chat here cannot mark it read on the Mac: that needs the Private API this setup does not use. It also runs the other way — reading a chat on an iPhone does not stamp a read date on the Mac's copy of an incoming message. Apple's own "last seen" marker catches most of those, but it syncs from a phone only sometimes, so it is allowed to clear a chat and never to raise one. Whatever it misses stays unread until you open the chat here once.

## Contributing

```sh
sudo pacman -S sway cue jq wtype   # UI checks only
mise run setup
mise run test                      # path derivation, daemon protocol, then the UI
```

`TESTING.md` has the rest: what each suite covers, the two manual checks, and the headless harness
an agent uses to drive the plugin.

Issues live on GitHub (`gh` CLI). A ticket lands as one commit closing it (`Closes #N`);
adjustments asked for mid-round get squashed into that commit. Review feedback on an open PR is
the other case and keeps one commit per item.

## POC scope

Text messages and inline images (thumbnail-sized, cached under `~/.cache/omaimsg/`); clicking an image opens it in the system viewer, thumbnail first, upgrading in place once the full-size download lands. `a` in an open thread, or the paperclip beside the composer, picks images off disk and sends them (the panel steps aside for the file dialog and comes back with it, because a layer-shell popup covering the screen would otherwise swallow every click aimed at the dialog); each file is its own message, so a caption is a second send and non-image files cannot be sent at all. URLs in message text render as links and open in the browser on click. Non-image attachments render as `[attachment]`. An inbound message raises a desktop notification through `omarchy-notification-send`, one per message, and clicking it opens the panel on that conversation. Deferred, not dropped: tapbacks, typing indicators, read-receipt sync back to Apple (reading a chat here does not mark it read on the Mac; that needs the Private API).
