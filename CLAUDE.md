# Omaimsg

iMessage in the Omarchy menu bar: a Quickshell QML bar plugin (`plugin/`) backed by a Node daemon (`daemon/`) that talks to a BlueBubbles server on a Mac. Read `README.md` for what it is and how to run it; this file is working knowledge for making changes.

## Architecture and contracts

- The plugin is pure UI; the daemon owns all networking (BlueBubbles REST + Socket.IO) and state (unread counts, pins, contact resolution). They speak NDJSON over a Unix socket. The wire contract is `docs/daemon-protocol.md` — it is the source of truth; change the doc in the same round as either side.
- The daemon never trusts BlueBubbles' chat ranking: `/api/v1/chat/query`'s sort/paging silently drops merged `any;-;` chats (verified against a real server; see the header comment in `daemon/lib/bluebubbles.js`). It always paginates the full chat list and sorts locally (pinned first, then `lastMessage.ts` descending, nulls last).
- Contact matching mirrors BlueBubbles' own suffix algorithm but with a ≥7-digit floor for fuzzy matches — anything shorter lets SMS shortcodes claim contacts. Emails match exactly only.
- Sends default to BlueBubbles' `apple-script` method (no Private API/SIP setup on the Mac). `~/.config/omaimsg/config.json` holds `serverUrl`/`password` and is never committed.

## Verification

`node mock/smoke.js` is the check for any daemon or protocol change: it boots the mock BlueBubbles server (`mock/server.js`) plus the daemon and drives every protocol frame over the real Unix socket. Keep it green, and when adding an assertion, mutation-prove it (break the code it pins, watch it fail, restore). QML changes: `/usr/lib/qt6/bin/qmllint` (the bare `qmllint` on PATH is Qt5's and rejects valid QML6); import warnings about `qs.Ui`/`Quickshell` are expected outside the shell tree.

## Omarchy dev loop

- Install is a real copy: `cp -r plugin/. ~/.config/omarchy/plugins/io.omaimsg/`. A symlink breaks hot reload (the shell's file watcher can't see writes through it).
- Hot reload refreshes panel code, but anything touching the bar-widget instance (`BarWidget.qml`, its `IpcHandler`, the manifest) needs `omarchy-restart-shell` to re-instantiate.
- `omarchy-shell io.omaimsg toggle|open|close` drives the panel from scripts/keybindings (requires `OMARCHY_PATH=/usr/share/omarchy`).
- Templates this code follows: Omarchy first-party plugins (`/usr/share/omarchy/shell/plugins/`, especially clipboard and agents) and `srineshr1/omarchy-whatsapp` for the daemon/socket architecture. `docs/research/` has the full background.
