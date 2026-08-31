# Omaimsg

iMessage in the Omarchy menu bar: a Quickshell QML bar plugin (`manifest.json`, `BarWidget.qml`, `Panel.qml`, `Client.qml`, at the repo root) backed by a Node daemon (`daemon/`) that talks to a BlueBubbles server on a Mac. Read `README.md` for what it is and how to run it; this file is working knowledge for making changes.

## Architecture and contracts

- The plugin is pure UI; the daemon owns all networking (BlueBubbles REST + Socket.IO) and state (unread counts, pins, contact resolution). They speak NDJSON over a Unix socket. The wire contract is `docs/daemon-protocol.md` — it is the source of truth; change the doc in the same round as either side.
- The daemon never trusts BlueBubbles' chat ranking: `/api/v1/chat/query`'s sort/paging silently drops merged `any;-;` chats (verified against a real server; see the header comment in `daemon/lib/bluebubbles.js`). It always paginates the full chat list and sorts locally (pinned first, then `lastMessage.ts` descending, nulls last).
- Contact matching mirrors BlueBubbles' own suffix algorithm but with a ≥7-digit floor for fuzzy matches — anything shorter lets SMS shortcodes claim contacts. Emails match exactly only.
- Sends default to BlueBubbles' `apple-script` method (no Private API/SIP setup on the Mac). `~/.config/omaimsg/config.json` holds `serverUrl`/`password` and is never committed.
- Thread paging is the daemon's: it sizes a page from `cache.messagesPerThread`, which is also the tail it caches, so the two cannot disagree. The panel asks for a thread and then for the page before it (`olderMessages`); the manifest has no message-count setting.

## Verification

`mise run test` is the check for any change: the daemon protocol suite, the same suite against the committed bundle, then the UI suite. Keep it green, and when adding an assertion, mutation-prove it (break the code it pins, watch it fail, restore). `TESTING.md` is the full picture — suites, setup, the manual `qmllint` and `omarchy plugin validate` checks, and how the headless harness works; read it before changing how anything is tested.

Working knowledge that bites:

- A change under `daemon/` re-runs `bun run bundle` and commits `daemon/dist/omaimsg-daemon.cjs` in the same round. It's the daemon installed plugins actually run, so `test:bundle` fails without it.
- UI checks address nodes by what they are (`moduleName === "io.omaimsg"`, the composer's `placeholderText`), never by child index — index paths move when Omarchy reorders the bar.
- Keystrokes go through `wtype`, bracketed with `-s 300`. Sway drops events delivered before the virtual keyboard's keymap settles, and a bare `wtype j` then exits 0 having done nothing at all.
- The quickshell-mcp pin lives in `.mcp.json` alone; the mise task reads it from there, so it cannot drift.

## Omarchy dev loop

- Install is a real copy: `rsync -a --delete --exclude .git --exclude node_modules --exclude .worktrees \
  --exclude .mcp.json --exclude .claude --exclude mise.toml --exclude /test/qsmcp/stage \
  ./ ~/.config/omarchy/plugins/io.omaimsg/`. A symlink breaks hot reload (the shell's file watcher can't see writes through it).
- Hot reload refreshes panel code, but anything touching the bar-widget instance (`BarWidget.qml`, its `IpcHandler`, the manifest) needs `omarchy-restart-shell` to re-instantiate.
- `omarchy-shell io.omaimsg toggle|open|close` drives the panel from scripts/keybindings (requires `OMARCHY_PATH=/usr/share/omarchy`).
- Templates this code follows: Omarchy first-party plugins (`/usr/share/omarchy/shell/plugins/`, especially clipboard and agents) and `srineshr1/omarchy-whatsapp` for the daemon/socket architecture. `docs/research/` has the full background.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `jlui17/Omaimsg`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

A ticket lands as one commit closing it (`Closes #N`): adjustments asked for mid-round get squashed into that commit, not stacked after it. Review feedback on an open PR is the other case and keeps its commit per item.

### Triage labels

The five canonical roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`, neither created yet. See `docs/agents/domain.md`.
