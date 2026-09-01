# Omaimsg

iMessage in the Omarchy menu bar: a Quickshell QML bar plugin (`manifest.json`, `BarWidget.qml`, `Panel.qml`, `Client.qml`, at the repo root) backed by a Node daemon (`daemon/`) that talks to a BlueBubbles server on a Mac. Read `README.md` for what it is and how to run it; this file is working knowledge for making changes.

## Architecture and contracts

- The plugin is pure UI; the daemon owns all networking (BlueBubbles REST + Socket.IO) and state (unread, pins, contact resolution). They speak NDJSON over a Unix socket. The wire contract is `docs/daemon-protocol.md` — it is the source of truth; change the doc in the same round as either side.
- The manifest `id` is the plugin's identity and everything derives from it, so a copy installed under a second id runs beside the one you use without touching it. `BarWidget.qml` reads the id and hands it down; `Client.qml` names the socket by appending `.sock` and passes the id to the daemon as `OMAIMSG_PLUGIN_ID`. Every rule for turning that id into a state path lives in `daemon/lib/paths.js` — QML holds none of it, so the two sides cannot drift. Every path is named by the whole id with no id excepted, never a shortened or scrubbed form: any such form collapses ids differing only in what it drops, and the two installs then share a pins file.
- The daemon never trusts BlueBubbles' chat ranking: `/api/v1/chat/query`'s sort/paging silently drops merged `any;-;` chats (verified against a real server; see the header comment in `daemon/lib/bluebubbles.js`). It always paginates the full chat list and sorts locally (pinned first, then `lastMessage.ts` descending, nulls last).
- Contact matching mirrors BlueBubbles' own suffix algorithm but with a ≥7-digit floor for fuzzy matches — anything shorter lets SMS shortcodes claim contacts. Emails match exactly only.
- Sends default to BlueBubbles' `apple-script` method (no Private API/SIP setup on the Mac). `~/.config/<plugin id>/config.json` (`~/.config/io.omaimsg/config.json` as installed) holds `serverUrl`/`password` and is never committed.
- Desktop notifications are the daemon's too, for the same two reasons the networking is: it is the one component guaranteed to be up, and the plugin runs one client per monitor, so a plugin-side toast fires once per screen. It shells out to `omarchy-notification-send` and the click action is `omarchy-shell <id> openChat <guid>`, which is what the bar widget's `openChat` IPC function exists for. `"notifications": false` in the daemon's config silences them; the manifest cannot, because manifest settings reach the QML only.
- Thread paging is the daemon's: it sizes a page from `cache.messagesPerThread`, which is also the tail it caches, so the two cannot disagree. The panel asks for a thread and then for the page before it (`olderMessages`); the manifest has no message-count setting.
- Two persisted files, and which one a fact belongs in is the question to ask before adding a third. `XDG_STATE_HOME` holds what nothing can reconstruct (pins, and the per-chat read boundary in `read-state.json`); `XDG_CACHE_HOME` holds what a fetch can rebuild (`cache.json`, the chat list and warm thread pages, plus the attachment files). Losing a cache file costs latency; losing a state file loses a decision the user made. `read-state.json` and `cache.json` share one versioned, atomic, never-fatal file discipline, in `daemon/lib/jsonstate.js`; `pins.json` predates it and still does its own unversioned, non-atomic read and write.
- Unread is derived, never counted: a chat is unread in whatever is newer than its read boundary, which is the later of what Apple reports and the timestamp `read-state.json` holds. Apple's half uses both its signals and trusts neither alone — `dateRead` decides which chats count, `properties[0].lastSeenMessageGuid` may only shorten the answer. Each is wrong in its own direction and both are measured in `bluebubbles.js`'s header: reading on an iPhone never stamps `dateRead` on the Mac's copy, and the Mac's last-seen marker syncs from a phone only sometimes. `state.unread` counts chats, `Chat.unread` counts that chat's messages, and the two are not meant to sum.

## Verification

`mise run test` is the check for any change: the path-derivation suite, the notification-shaping suite, the daemon protocol suite, then the UI suite. Keep it green, and when adding an assertion, mutation-prove it (break the code it pins, watch it fail, restore). `TESTING.md` is the full picture — suites, setup, the manual `qmllint` and `omarchy plugin validate` checks, and how the headless harness works; read it before changing how anything is tested.

Working knowledge that bites:

- The daemon ships as source and `install.sh` installs its one dependency, so there is no build step and nothing generated to commit. `daemon/dist/` is gitignored. `package-lock.json` is committed because `install.sh` runs `npm ci` against it, so an install resolves what the checkout resolved.
- UI checks address nodes by what they are (`moduleName === "io.omaimsg"`, the composer's `placeholderText`), never by child index — index paths move when Omarchy reorders the bar. Root each finder at the widget that owns it: the staged bar holds two installs, so an unrooted predicate answers for whichever the walk reaches first.
- Keystrokes go through `wtype`, bracketed with `-s 300`. Sway drops events delivered before the virtual keyboard's keymap settles, and a bare `wtype j` then exits 0 having done nothing at all.
- The quickshell-mcp pin lives in `.mcp.json` alone; the mise task reads it from there, so it cannot drift.

## Omarchy dev loop

- `./install.sh` is the install, from a checkout or from the installed copy. It owns the rsync exclude list, so nothing else states it. A symlink breaks hot reload (the shell's file watcher can't see writes through it), which is why it copies. `./install.sh <id>` installs a variant beside it, rewriting the manifest id in the copy; give it its own `~/.config/io.omaimsg.b/config.json` pointing at `test/server.js`, or a send lands in a real conversation. `README.md` has both flows in full.
- An install is a variant when its id is not the canonical one, and `install.sh` asks `daemon/lib/paths.js` for that id (`CANONICAL_ID`) rather than spelling it twice. Deriving it from the source tree's own id instead was wrong in both directions once that tree was itself a variant. The answer is recorded in `.deploy.json` alongside the branch and sha, because the installed copy has no `.git` and its rewritten manifest agrees with itself, so QML cannot work either out later; QML reads the stamp and holds no rule of its own, the same split as `paths.js` keeps for state paths.
- Hot reload refreshes panel code, but anything touching the bar-widget instance (`BarWidget.qml`, its `IpcHandler`, the manifest) needs `omarchy-restart-shell` to re-instantiate — which is why `install.sh` runs it unless told `--no-restart`.
- `omarchy-shell io.omaimsg toggle|open|close|openChat <chat guid>` drives the panel from scripts/keybindings (requires `OMARCHY_PATH=/usr/share/omarchy`). `openChat` is what a notification's click action runs.
- Templates this code follows: Omarchy first-party plugins (`/usr/share/omarchy/shell/plugins/`, especially clipboard and agents) and `srineshr1/omarchy-whatsapp` for the daemon/socket architecture. `docs/research/` has the full background.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `jlui17/Omaimsg`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

A ticket lands as one commit closing it (`Closes #N`): adjustments asked for mid-round get squashed into that commit, not stacked after it. Review feedback on an open PR is the other case and keeps its commit per item.

### Triage labels

The five canonical roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`, neither created yet. See `docs/agents/domain.md`.
