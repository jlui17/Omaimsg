# Omarchy shell plugin system: can a full chat UI live inside a plugin?

Scope: whether a Tier 3 Omarchy shell plugin (per
`docs/research/omarchy-bar-integration.md`) can host the entire iMessage
client — chat list, thread view, compose box, plus the network layer that
talks to a BlueBubbles server (REST + Socket.IO) — or whether the sane
architecture splits UI (plugin) from networking (a companion process).

Machine: this machine (`quickshell 0.3.1-1`, `qt6-base`/`qt6-declarative
6.11.2-2/-1`, `hyprland 0.56.2-1`). All line numbers below are against the
files as they exist on disk right now (`/usr/share/omarchy/shell/`,
package-owned, timestamps 2026-08-25).

## The one-sentence frame

Omarchy's shell is **one long-lived Quickshell/QML process that renders
everything and touches the network for nothing**: every first-party plugin
that needs live external data — a daemon's status, an HTTP API, a file on
disk — reaches it by spawning a short-lived helper process (`curl`, a Python
script, a bash script) through Quickshell's `Process` type and parsing
stdout as JSON in QML JS, never by holding an open socket or making an HTTP
call from QML itself. A plugin is exactly as capable as any other file under
`plugins/`: same manifest schema, same `Panel`/`PopupCard` chrome, same
`Process`/`FileView` toolbox, same "unsandboxed code in your session"
warning. There is no reduced third-party API — first-party plugins are
flagged only with `__isFirstParty: true`
(`/usr/share/omarchy/shell/plugins/README.md:5`) and are discovered the same
way (`/usr/share/omarchy/shell/README.md:16-44`, "Installing by hand").

## 1. Plugin anatomy

**Manifest schema**, validated by `PluginRegistry.qml`
(`/usr/share/omarchy/shell/services/PluginRegistry.qml:43-91`):

- Required: `schemaVersion` (must be `1`), `id`, `name`, `version`, `kinds`
  (non-empty array), `entryPoints` (object). `id` is rejected if it contains
  `/` or `..` or starts with `/` (path-traversal guard,
  `PluginRegistry.qml:59-63`).
- Every `entryPoints` value must be a *relative* path with no leading `/`
  and no `..` (`PluginRegistry.qml:36-41`, `isSafeEntryPoint`), and is
  re-checked at resolve time to confirm it still resolves inside the
  plugin's own source directory (`PluginRegistry.qml:93-108`,
  `entryPointUrl` — "defense in depth: even after validateManifest, confirm
  the resolved path stays inside the plugin's sourceDir"). A plugin cannot
  point its entry point outside its own folder.
- `kinds` (`/usr/share/omarchy/shell/README.md:74-83`): `bar-widget`,
  `panel`, `overlay`, `menu`, `service`, `bar` (only one `bar` plugin active
  at a time, safe fallback to `omarchy.bar`). A plugin can declare more than
  one kind (the Agents plugin's manifest declares one `bar-widget`, but
  first-party menu declares both `menu` and `bar-widget` with two entry
  points — `/usr/share/omarchy/shell/plugins/README.md:21`).
- `barWidget` sub-object: `displayName`, `category`, `aliases`,
  `allowMultiple`, `defaultSection`, `defaults` (settings defaults), `schema`
  (an array of `{key, type, label, ...}` descriptors rendered into Omarchy's
  own settings UI) — concretely: `/usr/share/omarchy/shell/plugins/agents/manifest.json:14-38`.
  `defaultSection` is validated against `["left","center","right"]`
  (`PluginRegistry.qml:72-79`).
- `activation: "on-demand"` (`agents/manifest.json:10`) vs. `keepLoaded:
  true` for a plugin whose window should stay mounted between summons (the
  image picker: `/usr/share/omarchy/shell/plugins/README.md:76-77`).

**Lifecycle**: first-party plugins and third-party plugins under
`~/.config/omarchy/plugins/<id>/` are discovered by the same scan at shell
startup; bar widgets and services mount immediately, panels/overlays/menus
load lazily on first summon (`/usr/share/omarchy/shell/README.md:87-90`).
Hot reload is automatic and file-watch-driven: "Saving a file anywhere under
`~/.config/omarchy/plugins/` reloads plugin code automatically"
(`/usr/share/omarchy/shell/README.md:160-161`; also stated for third-party
installs at `plugins/README.md` — confirmed via
[omarchy.org/manual/shell-plugins/](https://omarchy.org/manual/shell-plugins/)
which additionally frames it as: "a plugin isn't a config file — it's code
that runs for as long as your session does"). `omarchy-shell shell
rescanPlugins` forces a reload without relying on the watcher
(`README.md:133,183,205`).

**What a plugin is allowed to create**: whatever its declared `kinds` are —
a bar icon (`bar-widget`), a floating popup panel built on
`PanelWindow`/layer-shell (`panel`, or a bar-widget's own popup via
`KeyboardPanel`/`PopupCard`), a fullscreen layer-shell overlay (`overlay` —
e.g. Emojis, Clipboard, Image picker), a headless singleton with no UI
(`service`), or a full bar replacement (`bar`). Nothing in the manifest
schema or the registry code restricts a plugin from also registering its
own `IpcHandler` target (agents does:
`/usr/share/omarchy/shell/plugins/agents/Panel.qml:327-336`), spawning
`Process`es, watching files, or shipping arbitrary non-QML files alongside
its QML (see §5). The one explicit prohibition, stated as project policy
rather than enforced by the loader, is architectural: "never start a second
Quickshell process for a plugin" (via omarchyplugins.com's `develop.html`,
fetched 2026-08-28) — a plugin must live inside the one shared
`omarchy-shell` process, not spawn its own competing Quickshell instance.
There is no sandboxing of any kind: "Plugins run as unsandboxed code inside
`omarchy-shell`... with everything your user account can reach"
(`/usr/share/omarchy/shell/README.md:107-110`; omarchyplugins.com
`develop.html`).

## 2. Can a plugin popup host a real chat UI?

**Yes, structurally** — the QML/Quickshell runtime here has everything a
compact chat client's UI needs, and shipped code already exercises every
piece:

- **Scrollable lists**: `ListView` is used throughout first-party plugins —
  audio, network, bluetooth panels, the Omarchy menu, and, closest to a chat
  shape, **Clipboard** (`/usr/share/omarchy/shell/plugins/clipboard/Clipboard.qml:460-537`):
  a `ListView` of up to 300 history entries in a left pane, `hasCursor`-based
  row highlighting, `j`/`k`-driven `positionViewAtIndex`, and a right-hand
  detail pane that shows either the full text or a preview `Image` for the
  selected row (`Clipboard.qml:492-499, 564-575`). That is, byte for byte,
  the "chat list on the left, thread/detail on the right" shape a compact
  iMessage panel needs. Nothing here caps list size architecturally;
  `ListView` virtualizes delegates the same way Qt Quick always has, so
  "thousands of items" is a model-size question (paginate the model, not the
  view) rather than a QML-capability question.
- **Multi-line compose**: `Ui/TextField.qml` wraps Qt Quick Controls'
  `TextField` (single-line) with the kit's focus/border styling
  (`/usr/share/omarchy/shell/Ui/TextField.qml:1-18`); nothing shipped uses a
  multi-line `TextArea`, but `QtQuick.Controls` is imported directly by
  first-party plugin code (`agents/Panel.qml:2`) and `TextArea` is part of
  the same module — a compose box is a peer component to `TextField.qml`,
  not a new capability to source.
- **Image display**: `Image { source: ... }` is used with **plain local file
  paths** everywhere (clipboard previews, the Agents plugin's per-provider
  SVG marks via `Qt.resolvedUrl("assets/" + id + ".svg")`,
  `agents/Panel.qml:288-295, 423-434`) and QML's `Image` type is a stock Qt
  Quick element backed by Qt's own `QNetworkAccessManager` for `http(s)://`
  sources — it does not go through any Omarchy/Quickshell-specific plumbing,
  so `Image { source: "https://..." ; asynchronous: true }` for a
  BlueBubbles attachment thumbnail is expected to work out of the box; no
  shipped plugin happens to point an `Image` at a remote URL, so this is
  inferred from Qt Quick's documented `Image` behavior rather than confirmed
  against local code — flag this as the one item worth a five-minute smoke
  test before relying on it.
- **Emoji rendering**: plain text glyphs render fine — the bar itself
  renders Nerd Font icons as `Text` (`agents/Panel.qml:342`, `text: "󱚣"`),
  and the Emojis picker is a `GridView` of literal emoji characters
  (`/usr/share/omarchy/shell/plugins/emojis/Emojis.qml`, `EmojiSearch.filterEmojis`
  — `emojis/Emojis.qml:75`). Whatever font Omarchy's theme uses for the bar
  already has emoji coverage.
- **Clipboard**: no shipped code exercises the *system* clipboard from QML,
  but Qt Quick's `TextEdit`/`TextInput` have built-in copy/paste
  (`Qt.labs` or native `selectedText`/context menu) independent of Omarchy;
  the **Clipboard plugin itself** manages the OS clipboard from outside QML
  via a shell script (`capture.sh`,
  `/usr/share/omarchy/shell/plugins/clipboard/Clipboard.qml:22`,
  `captureScript`), which is the same "shell out for OS integration" pattern
  as networking (§3).

**Qt version and modules actually imported.** `qt6-declarative 6.11.2`
(Qt 6.11, current at investigation time). Grounded in what the shipped code
actually imports, not a permissions list: `QtQuick`, `QtQuick.Controls`
(`agents/Panel.qml:1-2`, `Ui/TextField.qml:1-2`), `Quickshell`,
`Quickshell.Io`, `Quickshell.Wayland`, `Quickshell.Hyprland`,
`Quickshell.Services.Polkit` (`plugins/README.md:89-91`) — all of which a
plugin can freely import since it is ordinary QML running in the same
engine. **`QtWebEngine` is installed on this machine** (`pacman -Q
qt6-webengine` → `6.11.2-1`) but is not imported anywhere under
`/usr/share/omarchy/shell/` — using it for a bar popup would mean embedding
a full Chromium view for what's otherwise a native-widget UI: technically
importable, architecturally the wrong tool, and not something any shipped
plugin does. Confirm before relying on it: nothing here proves Quickshell's
QML engine has the WebEngine QML plugin registered/available at runtime,
only that the underlying Qt module is installed as a system package.

## 3. Networking from QML: the load-bearing finding

**No shipped plugin makes an HTTP call, opens a WebSocket, or uses a raw
socket from QML JS.** Exhaustive greps across `/usr/share/omarchy/shell/`
for `XMLHttpRequest`, `WebSocket`, and `.fetch(`/`Fetch{` all return zero
hits. The idiom, used consistently everywhere network or IPC-to-a-daemon
data is needed, is: **spawn a helper process via `Quickshell.Io.Process`,
parse its stdout as text/JSON in QML JS.**

Three concrete shapes of that one idiom, from shipped code:

- **One-shot HTTP GET via `curl`**, for a simple REST-shaped API — the
  **Weather** panel:
  ```qml
  Process {
    command: ["curl", "-fsS", "--max-time", "10", "https://wttr.in/" + root.locationQuery + "?format=j1"]
  }
  ```
  (`/usr/share/omarchy/shell/plugins/panels/weather/Panel.qml:331-333`, plus
  a second endpoint at line 184 and a geocoding call at line 275-276). The
  JSON response is parsed by hand in `Model.js`. This is the closest
  existing precedent to "call BlueBubbles' REST API" — and it demonstrates
  the ceiling of doing it this way: every GET is a new subprocess spawn plus
  a TLS handshake, fine for a panel that refreshes on an interval or on
  open, not something you'd want per-keystroke or for a live event stream.
- **A bundled interpreted helper script**, for anything with real protocol
  logic (talking to a running daemon, not just an HTTP GET) — the
  **Dropbox** panel bundles its own Python script *inside the plugin
  directory* and shells out to it:
  ```qml
  readonly property string helperPath: (omarchyPath || "") + "/shell/plugins/panels/dropbox/status.py"
  ...
  statusProcess.command = ["python3", helperPath, "25"]
  ```
  (`/usr/share/omarchy/shell/plugins/panels/dropbox/Service.qml:36,64`,
  full file at `panels/dropbox/status.py`). QML never talks to `dropboxd`
  directly; the Python script does, and reports back over stdout as
  JSON/text that QML parses (`Service.qml:68-88`).
- **A system-installed collector binary**, for anything long/expensive
  enough to want to live outside the plugin's own git-tracked files — the
  **Agents** plugin's actual OAuth/API calls (Anthropic's usage endpoint,
  the Codex RPC, Fireworks' billing API) happen inside
  `/usr/bin/omarchy-agent-usage-{claude,codex,fireworks}` (confirmed
  present on disk, `bash`/compiled scripts installed by the OS package, not
  inside `plugins/agents/`), invoked by the shared
  `/usr/bin/omarchy-agent-usage-update` wrapper
  (`agents/Main.qml:146-169`). The plugin's QML side never sees a network
  socket, only `FileView`s watching the JSON records those collectors write
  to `~/.local/state/omarchy/agents/usage/*.json`
  (`agents/Main.qml:16`, `agents/Agent.qml:16-23` — `watchChanges: true`,
  `onFileChanged: reload()`).

**Can QML itself do HTTP/WebSocket at all, independent of Omarchy's own
style choice?** Two separate technical facts, both worth being precise
about:

- **`XMLHttpRequest` is a bare JS global in every QML/JS engine context**,
  not gated behind an import — Qt's own docs describe it as available
  wherever `QtQml`'s JS engine runs
  ([doc.qt.io/qt-6/qml-qtqml-xmlhttprequest.html](https://doc.qt.io/qt-6/qml-qtqml-xmlhttprequest.html)).
  So a plugin *could* do `new XMLHttpRequest()` and hit BlueBubbles' REST
  endpoints directly from QML JS with no `Process`/`curl` detour at all.
  Nothing in the local codebase confirms or contradicts this working inside
  Quickshell specifically (no shipped plugin tries it), so treat it as
  "should work, per Qt's own docs for the engine Quickshell embeds" rather
  than locally verified — a five-minute spike (one `XMLHttpRequest` GET in
  a throwaway QML file loaded by `quickshell -p`) would close the gap
  before depending on it.
- **Persistent WebSocket/Socket.IO is a different question, and this one
  has a real negative finding.** Quickshell's own `Quickshell.Io.Socket`
  type — the one truly "socket-shaped" primitive Quickshell ships — is a
  **Unix domain socket only**: `path` (string, the Unix socket path),
  `connected` (bool), `write(data)`, `flush()`, inherits `DataStream`
  ([quickshell.org/docs/types/Quickshell.Io/Socket/](https://quickshell.org/docs/types/Quickshell.Io/Socket/),
  fetched 2026-08-28). It cannot dial a remote TCP host:port, so it cannot
  speak to a BlueBubbles server over the network by itself. Qt6's
  `QtWebSockets` module (which would provide a real `WebSocket` QML type)
  **is available in Arch's `extra` repo but is not installed on this
  machine** (`pacman -Si qt6-websockets` → found, version `6.11.2-1`;
  `pacman -Q qt6-websockets` → not installed) and, more importantly, no
  shipped Omarchy plugin imports it — it would be a new system dependency
  the plugin's manifest/README would have to document as a prerequisite
  (`pacman -S qt6-websockets`), unlike every module actually exercised
  above.
- **Socket.IO is not "a websocket"** — it is its own framing/handshake
  protocol layered on top of WebSocket-or-long-polling, with its own
  reconnection, namespace, and ack semantics. Even granting a working
  `WebSocket` QML type, hand-rolling the Socket.IO v4 protocol in QML JS
  (parsing Engine.IO packet-type prefixes, ack IDs, binary attachment
  framing) is real protocol-implementation work with no existing QML
  library to lean on — this is the part of the ask a plugin's JS runtime is
  a legitimately poor fit for, independent of the QtWebSockets
  install-vs-not question above.

**Realistic architecture, forced by the above**: the sane split is **plugin
= pure UI, companion process = BlueBubbles client.** A small daemon in any
language with a mature Socket.IO client (Node, Python `python-socketio`, Go)
holds the persistent connection to BlueBubbles, normalizes REST + event
data, and exposes something QML-friendly — concretely, the same shape
Dropbox already uses one level down: either (a) the companion writes
`~/.local/state/.../imessage/*.json` state that `FileView`s watch (like
Agents), or (b) the companion listens on a **Unix domain socket** that the
plugin's own `Quickshell.Io.Socket` connects to for push-style low-latency
updates (new-message events) instead of a poll/refresh cycle. Both are
first-party-precedented patterns, not invented ones; (b) is strictly better
for "the compose box needs a live inbound message to show up instantly" than
(a)'s file-watch latency.

**This section's findings are first-party-only** (`/usr/share/omarchy/shell/`)
and, on the specific point of "does any plugin do real networking from QML,"
they turn out not to generalize to the community — see §6, which corrects an
earlier, wrong pass on this same question and names community plugins that do
exactly the `XMLHttpRequest`/`WebSocket` things this section found no local
evidence for. It does not change the Socket.IO-specific conclusion above (no
community plugin hand-rolls Socket.IO in QML either), but it does mean
"nothing here exercises `QtWebSockets`" is a **local-machine-and-first-party**
finding, not a "this doesn't work" finding.

## 4. Keyboard: plugin panels get full parity with core-shell panels

Confirmed: exclusive keyboard focus is not a core-shell-only privilege. The
first-party plugins that use `WlrKeyboardFocus.Exclusive` are, structurally,
plugins loaded exactly the way a third-party one would be (same manifest
contract, same discovery path, `__isFirstParty` is just a boolean flag) —
and there are *many* of them: the Omarchy menu
(`/usr/share/omarchy/shell/plugins/menu/Menu.qml:1024`), Clipboard
(`plugins/clipboard/Clipboard.qml:321`), Emojis
(`plugins/emojis/Emojis.qml:167`), the image picker (conditionally, only
once images are loaded —
`plugins/image-picker/ImagePicker.qml:370`), the reminders flow
(`plugins/reminders/ReminderFlow.qml:102`), wifi's QR panel
(`plugins/panels/wifiqr/Panel.qml:220`), the lock screen
(`plugins/lock/Service.qml:296`), and the polkit agent
(`plugins/polkit/PolkitAgent.qml:228`). A brand-new plugin dropped in
`~/.config/omarchy/plugins/<id>/` has the identical `WlrLayershell.keyboardFocus`
property available on any `PanelWindow`-based surface it builds (or gets it
for free via the shared `Ui/KeyboardPanel.qml`, which every bar-widget popup
including Agents already reuses — see §2 of the prior research doc for the
prime→OnDemand rationale, `Ui/KeyboardPanel.qml:85-100`).

Key navigation is a solved, reusable pattern, not something to invent per
plugin: `Ui/PanelKeyCatcher.qml` is a drop-in `Item` that turns raw
`Keys.onPressed` into semantic signals —
`moveRequested(dx, dy)` (arrows or **`h`/`j`/`k`/`l`**),
`activateRequested()` (Enter/Space), `closeRequested()` (**Escape**),
`deleteRequested()` (**x**/**X**), `tabRequested(direction)` (Tab/Shift-Tab),
and a catch-all `textKey(text)` for anything else typed
(`/usr/share/omarchy/shell/Ui/PanelKeyCatcher.qml:33-84`). Agents wires it
for `h`/`l` subscription-switch and `j`/`k` scroll
(`agents/Panel.qml:363-379`); a chat panel would wire the same catcher for
`j`/`k` thread-list navigation and use its `blocked: composeField.activeFocus`
escape hatch (documented in the catcher's own header comment,
`PanelKeyCatcher.qml:26-29`) to let a focused compose `TextArea` receive
normal typing instead of having every keystroke intercepted as a nav
command — this is exactly the "wifi passphrase field" case the comment
calls out by name.

## 5. State, persistence, and bundling non-QML assets

- **Plugin settings** are inline entries in the single
  `~/.config/omarchy/shell.json`, under `bar.layout.<section>` for
  bar-widgets or `plugins[]` for anything else — no per-plugin settings
  file, no config sub-object, no merge layers
  (`/usr/share/omarchy/shell/README.md:213-281`, "Storage rules" 1-8).
  Settings are read via a `setting(name, fallback)` helper both `Panel.qml`
  (`Ui/Panel.qml:39-42`) and `BarWidget`-style items expose identically.
- **Plugin-owned application state** (not user settings) has no
  Omarchy-provided convention — it's the plugin's own choice, and the two
  shipped precedents both use XDG paths directly from QML:
  `~/.local/state/omarchy/agents/usage/` (`agents/Main.qml:16`, respecting
  `$XDG_STATE_HOME`) and `~/.local/state/omarchy/clipboard-history.json`
  (`clipboard/Clipboard.qml:20`). A chat plugin's own message cache/thread
  index would follow the same convention.
- **Plugins can bundle non-QML files.** Confirmed two ways: (1) static
  assets sitting next to the QML and referenced by relative URL — the
  Agents plugin's `assets/<id>.svg`/`assets/<id>-light.svg` marks
  (`agents/Panel.qml:288-295`, files present at
  `plugins/agents/assets/*.svg`); (2) a whole **executable helper script
  shipped inside the plugin's own directory** and invoked via `Process` —
  Dropbox's `panels/dropbox/status.py`, a real Python program with its own
  `import json/os/subprocess`, sitting right next to `Service.qml` and
  referenced via a path built from `Quickshell.env("OMARCHY_PATH")`
  (`Service.qml:11,36`). Nothing in `PluginRegistry.qml`'s validation
  touches non-`entryPoints` files at all — only `entryPoints` values are
  path-checked (§1) — so a plugin bundling a compiled companion binary
  (Go, Rust, whatever speaks BlueBubbles' Socket.IO) alongside its QML is
  the same shape as Dropbox's Python script, just a different language.

## 6. Precedent: third-party plugins in the wild

**Correction to an earlier pass on this exact question.** An earlier version
of this research concluded "zero community plugins exist," sourced from
[omarchyplugins.com](https://omarchyplugins.com/) showing "0 community
plugins" / "No plugins found." That reading was wrong, not stale: the
marketplace site is a client-rendered SPA, and fetching it as flat HTML reads
the empty shell before its JS populates the list — it never contradicts a
plugin's existence, only the fetch method used. The actual registry is
[`registry.json`](https://raw.githubusercontent.com/HANCORE-linux/omarchy-plugin-marketplace/main/registry.json)
(fetched 2026-08-28), a flat `sources[]` array with **1,673 entries**
(`1,671` of `type: "plugin-source"` plus 2 `type: "suite"`, one row per
repo). There is an active, populated community ecosystem, and — the part
that matters most for this doc — it already contains **eight independent
messaging plugins**, several of which are full chat clients with live
backends, not stubs.

### Messaging plugins: the direct precedent

All eight repos below were cloned shallow and read in full (not just their
READMEs); line counts are `wc -l` over each repo's own QML/JS/Python/shell
source, excluding tests and docs.

- **[`srineshr1/omarchy-whatsapp`](https://github.com/srineshr1/omarchy-whatsapp)**
  — a real WhatsApp Web client, full stop. `bin/omarchy-whatsapp-daemon`
  starts a Node.js daemon (`daemon/index.js`, 1,419 lines) built on
  **`baileys`** (a real WhatsApp Web protocol library, `import ... from
  'baileys'`) — the daemon speaks the actual WhatsApp protocol, not a shim
  around some other CLI. It exposes a **newline-delimited-JSON server on a
  Unix domain socket** (`daemon/lib/server.js:7-9`: "Newline-delimited JSON
  over a unix socket. Quickshell's `Socket` type speaks exactly this."), and
  the plugin's `WhatsAppClient.qml` connects with Quickshell's own
  `Quickshell.Io.Socket` + `SplitParser` (`WhatsAppClient.qml:262-269`) —
  **exactly** the §3 recommendation (b), already shipped and working, for a
  live messaging protocol rather than a hypothetical one. The panel
  (`Panel.qml`, 964 lines) has two `ListView`s (chat list, thread — lines
  545, 656), an inline `TextField` composer (line 847), inline `Image`
  attachments (lines 482, 749), and its own `Keys.onPressed` handler (line
  898). It is built on the shared `Panel {}` base
  (`Panel.qml:13`, same base class §1/§4 already document first-party plugins
  using) — the bar-anchored popup, not a separate window — so it inherits
  the standard `WlrKeyboardFocus.Exclusive` chrome for free; the one
  *explicit* `WlrKeyboardFocus.Exclusive` line in the file
  (`Panel.qml:914`) is for a secondary full-screen image-peek overlay, not
  the chat surface itself. Daemon autostart is `systemctl --user start` with
  a `setsid` fallback (`WhatsAppClient.qml:335-346`); a `Timer`-driven
  reconnect loop with capped backoff and a 20s liveness ping
  (`WhatsAppClient.qml:280-320`) handles the daemon dying or wedging. Size:
  ~1,432 QML + ~3,481 daemon (mostly JS) lines. **This is the single closest
  precedent to our own plan** — same shape (bundled protocol client in a
  companion daemon, Unix-socket transport, `ListView`+`TextField` panel UI)
  applied to a harder protocol than BlueBubbles' (WhatsApp Web's own
  handshake/crypto, not a documented REST+Socket.IO API).

- **[`gardnmi/omarchy-irc`](https://github.com/gardnmi/omarchy-irc)** — the
  deepest chat *UI* of the eight: separate Chat/Users/DMs tabs, a searchable
  virtualized user roster, slash-command autocomplete, clickable sender names
  with contextual DM/mute actions, and reuse of Omarchy's own emoji picker
  for input (`README.md` feature list) inside `Panel.qml` (1,383 lines),
  which — like WhatsApp above — extends the shared `Panel {}` base
  (`Panel.qml:8`), so this too is a genuinely rich chat client living inside
  the standard bar-popup chrome, not a bespoke window. The backend
  (`irc_helper.py`, 855 lines, stdlib-only) is a real IRC client: raw
  `asyncio` TCP with `ssl.create_default_context()`
  (`irc_helper.py:463-468`), hand-parses the IRC line grammar itself
  (`class IrcMessage`, line 36), and is exposed to QML as a **persistent**
  `Process` (`Panel.qml:577-579`, `command: ["python3", root.helperPath]`) —
  not one-shot like Weather's `curl`, but a long-lived subprocess trading
  NDJSON commands/events over its own stdin/stdout for the life of the
  connection. This is a second working shape for "companion process talks to
  QML" beyond Unix sockets: a persistent `Process` with bidirectional pipes.
  Automatic PING/PONG and bounded exponential reconnect are implemented by
  hand in the Python side. Size: ~1,383 QML + ~871 helper lines.

- **[`Bottelet/omarchy-slack`](https://github.com/Bottelet/omarchy-slack)**
  — also a full chat client (sidebar of DMs/channels + message pane +
  compose, `Panel.qml`, 2,203 lines: `ListView` at line 1664, `TextField`s at
  867/1168/2038, inline `Image`s at 1261/1817) but a different backend shape:
  `scripts/slack.sh` (603 lines of bash) calls Slack's REST Web API directly
  via `curl`, with the OAuth token piped through stdin so it never appears in
  `argv`/`ps` (`scripts/slack.sh:107`). No websocket, no Socket Mode — live
  updates are **polling `Timer`s** (`Panel.qml:560-569`, 65-90s intervals;
  `BarWidget.qml:74`, a separate badge-refresh interval), i.e. the Weather
  idiom (one-shot `curl` via `Process`) scaled up to drive an entire chat UI
  rather than one panel's numbers. Notably, `Panel.qml` is declared
  `kind: panel` in the manifest but is *not* built on the `PanelWindow`/
  layer-shell chrome §1/§4 describe: its own header comment calls it "a
  movable, resizable `FloatingWindow` (kind: panel, the same model as the
  Spotify plugin)" (`Panel.qml:8-9`) — a real, tileable, resizable
  desktop-toplevel-like surface, not an anchored popup. Size: ~2,334 QML +
  ~1,327 helper (bash + a Cloudflare Worker OAuth proxy) lines.

- **[`MoizIbnYousaf/Omarchy-Whatsapp`](https://github.com/MoizIbnYousaf/Omarchy-Whatsapp)**
  — the largest of the eight (~7,136 QML lines, dominated by `App.qml` at
  2,982 lines) and architecturally the most deliberate about **two
  surfaces sharing one resident backend**: a compact `Dropdown.qml` bar
  popup for "click to reply" (`docs/ARCHITECTURE.md`: "The click opens a
  compact interactive conversation client") and a separate `App.qml` full
  app — a real desktop toplevel (imports `QtQuick.Window`, not
  `Quickshell.Wayland`) — summoned by a global `Super+Shift+W` shortcut, both
  reading the same `Service.qml`-owned state. Its backend
  (`bin/omawhatsapp`, 2,166 lines of Python) is **not** a bundled protocol
  implementation like `baileys` above — it is a bounded local bridge/gateway
  in front of a separately-installed third-party CLI, **`wacli`**, which
  does the actual WhatsApp protocol work; `bin/omawhatsapp` reads `wacli`'s
  SQLite mirror read-only and forwards writes through `wacli`'s own CLI
  surface (`docs/ARCHITECTURE.md`, "Data boundary"). This is a materially
  different shape from WhatsApp-via-`srineshr1` — a policy/gateway layer over
  someone else's already-running client, not a self-contained daemon — and
  it depends on the user having `wacli` installed and authenticated
  separately, which is the one thing that would not transfer to BlueBubbles
  (there is no equivalent third-party CLI to delegate to; a BlueBubbles
  client has to be written, as `baileys`-via-`srineshr1` does).

- **[`thisisgm/omarchy-discord`](https://github.com/thisisgm/omarchy-discord)**
  — not a chat client: a rich-presence/voice-status panel (call quality,
  mic mute, mic gain) driven by Discord's local IPC. Still a strong
  networking-shape precedent: `rpc.py` (700 lines, stdlib-only) is a
  **persistent** helper that hand-parses Discord's binary local RPC frame
  protocol over a Unix socket (`struct.Struct("<II")` header, `OP_HANDSHAKE`
  etc.) and re-exposes it to QML as NDJSON over stdin/stdout via a
  **persistent** `Process` (`Rpc.qml:109-112`) — the same "long-lived
  `Process` as an NDJSON bridge" shape as `gardnmi`'s IRC helper, applied to
  a binary rather than line-oriented wire protocol. Its own
  `knowledge/plugin-design-decisions.md` is a rare piece of written-down
  reasoning worth citing directly: credentials are written to the helper
  over stdin rather than argv "so a secret never appears in a command line
  or in `ps`," and a refused command is deliberately *not* escalated to a
  session-ending error because Discord's numeric error codes were never
  verified against the live socket and the author didn't want to guess.
  Size: ~1,520 QML + ~1,159 helper lines.

- **[`thisisgm/omarchy-slack`](https://github.com/thisisgm/omarchy-slack)**
  — despite the name, not a chat client either: a presence/DND/status
  bar-widget (one `TextField`, for a snooze duration) driven by `curl` via a
  bash helper (`bin/omarchy-slack`, using Slack's REST API directly, no
  websocket). Confirms the same "`curl`-via-`Process`, polled" idiom Weather
  and Bottelet-slack use, at the smallest possible scope. Size: ~706 QML +
  ~107 helper lines.

- **[`goktugvatandas/omarchy-quick-chat`](https://github.com/goktugvatandas/omarchy-quick-chat)**
  — not messaging to another *person*: a chat UI (`ui/ChatSurface.qml`,
  `ui/MessageList.qml`, `ui/Composer.qml`'s `ThemedTextArea`, streaming
  `text_delta` events, markdown rendering, attachments) in front of local AI
  coding-agent CLIs (Claude Code, Codex, Cursor, Grok, …), not a remote
  service. Included for completeness because it is the deepest **UI**
  precedent for a compose-box-plus-streaming-timeline chat surface, and it
  reuses the exact NDJSON-over-persistent-`Process`-stdio shape
  (`BridgeClient.qml:69-70`, `bridgeProcess.write(JSON.stringify(object) +
  "\n")`) `gardnmi` and `thisisgm/omarchy-discord` also land on
  independently — three unrelated authors converging on the same bridge
  shape is a real signal about what QML plugin authors reach for when a
  companion process needs to push events, not just answer one-shot queries.
  Its own bridge protocol doc (`docs/bridge-protocol.md`) documents a
  versioned, typed event schema (`ready`/`status`/`text_delta`/`complete`/
  `error`) worth structurally imitating for a BlueBubbles bridge. Size:
  ~4,986 QML + ~6,202 Python (the bridge, adapters, and tests) lines —
  the largest total codebase of the eight.

- **[`Somnius/Messaging-for-Omarchy`](https://github.com/Somnius/Messaging-for-Omarchy)**
  — not a chat client: a bar toggle that launches Slack/Discord/Telegram/
  WhatsApp Web each in its own `chromium --app` window with an isolated
  profile directory. No networking of its own, no message data ever touches
  the plugin. Smallest of the eight (522 QML + ~105 JS lines) and the one
  genuine "just launches an external app" precedent among the eight —
  useful as the honest floor of what "messaging plugin" can mean if nothing
  else is invested.

**Ranking, most instructive first:**

1. **`srineshr1/omarchy-whatsapp`** — the closest match to our own problem
   shape (bundle a real protocol client in a companion daemon, talk to it
   over a Unix domain socket, render `ListView`+`TextField` in the standard
   `Panel {}` popup) applied to a harder protocol than BlueBubbles'.
2. **`gardnmi/omarchy-irc`** — proves the richest multi-conversation,
   tabbed, roster-and-slash-command chat UI still fits inside the standard
   bar-popup chrome, and is the clearest example of the
   persistent-`Process`-as-NDJSON-bridge alternative to a Unix socket.
3. **`Bottelet/omarchy-slack`** — proves a full sidebar+thread+compose chat
   client is buildable on the *simpler* `curl`-via-`Process`-plus-polling
   idiom alone (no persistent connection at all), at the cost of a
   `FloatingWindow` instead of an anchored popup and 65-90s update latency —
   useful as the "cheapest working shape" data point, not the richest one.

### Broader in-QML networking precedent (non-messaging)

The registry has no free-text plugin descriptions to grep (`sources[].catalog`
carries `category`/`tags`/install metadata, not prose), so this was a
targeted clone-and-read of plugins whose *names* suggested live remote data
(stock/crypto tickers, flight/ISS trackers, RSS, mail checkers), not an
exhaustive sweep of 1,673 repos. Three are worth naming as the strongest
"popup panel backed by live remote data" precedent, independent of
messaging:

- **[`ismyhc/omarchy-bitfinex-ticker`](https://github.com/ismyhc/omarchy-bitfinex-ticker)**
  — a **real, working `QtWebSockets` connection from QML**, the single
  strongest counter-example to §3's "Qt's WebSocket module ... isn't
  exercised by any shipped plugin." `Stream.qml` (137 lines) `import
  QtWebSockets` and opens `WebSocket { url:
  "wss://api-pub.bitfinex.com/ws/2" }` (`Stream.qml:2,90-92`), subscribes to
  Bitfinex's public ticker channel, and handles `onTextMessageReceived`,
  reconnection with exponential backoff, and a staleness timer that forces a
  reconnect if heartbeats stop arriving — all in QML/JS, no helper process.
  Critically, this is **optional and gracefully degraded**, not a hard
  dependency: the file's own header comment states it is "Loaded through a
  `Loader` in `Feed.qml` so that a machine without `qt6-websockets` fails
  this one component instead of the whole widget — the feed then falls back
  to polling the REST ticker" (`Stream.qml:4-8`), and the README documents
  the install step explicitly: `omarchy pkg add qt6-websockets`
  (`README.md:42`). This is a directly reusable pattern for any plugin that
  wants to *try* a live-push transport without requiring it.
- **[`guettoblasterr/omarchy-crypto-pulse`](https://github.com/guettoblasterr/omarchy-crypto-pulse)**
  — plain `XMLHttpRequest` against REST APIs, polled on a timer, with the
  author's own code comment stating it was "verified with both curl and this
  QML `XMLHttpRequest` implementation" (`Panel.qml:35`) — direct, in-repo
  confirmation (not just Qt's docs, as §3 had to fall back on) that
  `XMLHttpRequest` works in a live Quickshell/Omarchy session, including
  retry/backoff and `Retry-After` header handling entirely in QML JS
  (`Panel.qml:120-168`).
- **[`stappmus/Omarchy-Spotify`](https://github.com/stappmus/omarchy-spotify)**
  — a hybrid: `AuthManager.qml` uses `XMLHttpRequest` directly for OAuth
  token exchange (`AuthManager.qml:136`), while playback control and state
  go through a companion daemon over a **Unix domain socket**
  (`BackendClient.qml`, `readonly property string socketPath: ...
  "/omarchy-spotify/backend.sock"`) — i.e. the same "REST from QML directly,
  persistent/stateful stuff through a companion socket" split this doc's §3
  recommends for BlueBubbles (REST calls in QML or `Process`, Socket.IO
  through the daemon), independently arrived at by an unrelated plugin
  author for an unrelated protocol.

**What this changes, precisely**: `XMLHttpRequest` from QML is no longer "per
Qt's own docs, unverified locally" (§2/§3's hedge) — it is confirmed working
in at least two published, non-trivial community plugins. `QtWebSockets` is
no longer "installed in Arch's repo but not exercised by any shipped plugin"
— it is confirmed working, with a documented install step and a graceful
fallback pattern, in one. Neither of these touches the Socket.IO-specific
objection in §3 (framing/acks/namespaces on top of WebSocket) — no plugin
found, messaging or otherwise, hand-rolls Socket.IO in QML; the WhatsApp
precedent above sidesteps that exact problem by putting the protocol client
in a companion daemon instead, which is the same thing this doc already
recommends for BlueBubbles.

## 7. API stability

No version-pinning or deprecation-warning language exists anywhere in the
local docs or the fetched web pages. `manifest.json` carries a
`schemaVersion` field (currently always `1`,
`/usr/share/omarchy/shell/README.md:53`, `PluginRegistry.qml:48-51` rejects
anything else outright), which is the one explicit compatibility gate — a
future breaking change to the manifest shape would presumably bump this and
leave old plugins failing validation loudly rather than silently
misbehaving. Beyond that, the closest thing to a stability statement is
process, not a promise: `omarchy plugin update <id>` always shows a diff
before fast-forwarding a git-tracked plugin (`README.md:98,109`), and a
plugin's own git history is the only versioning surface — there is no
"this API may change" disclaimer in `shell/README.md`, `plugins/README.md`,
or the fetched manual/marketplace pages. Given the shell itself is under
active development (phases 1-8a logged in
`/usr/share/omarchy/shell/README.md:283-297`, most recently "unified
shell.json with inline plugin settings"), treat the plugin surface as
**stable in contract shape (manifest fields, IPC verbs, `Panel`/`PopupCard`
API) but not contractually frozen** — an `omarchy update` could plausibly
add fields or panel base-class methods, but nothing here suggests it has
ever removed or renamed one out from under existing plugins.

## Verdict

**(a) Can the whole POC be a plugin — QML UI + networking in-process?**
Revised in light of §6: the REST half is no longer just plausible, it's
confirmed — `guettoblasterr/omarchy-crypto-pulse` and
`stappmus/Omarchy-Spotify` both run `XMLHttpRequest` against real REST APIs
in production, and `ismyhc/omarchy-bitfinex-ticker` runs a real
`QtWebSockets` connection (`wss://api-pub.bitfinex.com/ws/2`) directly from
QML, with a documented `omarchy pkg add qt6-websockets` install step and a
`Loader`-gated fallback to polling when it's absent. So "QML can't do
sockets" is no longer the right way to state the blocker — it can, and a
community plugin proves it in the wild. What still can't be done in-QML is
narrower and unchanged: **Socket.IO's own framing/handshake/ack protocol
layered on top of a WebSocket**, which no plugin found — messaging or
otherwise, first-party or community — hand-rolls in QML JS. The WhatsApp
precedent (`srineshr1/omarchy-whatsapp`) hits the identical shape of problem
(a real, non-trivial wire protocol underneath a chat UI) and resolves it the
same way this doc already recommends: push the protocol client into a
companion daemon. **Answer: still no** for the live-connection half, but for
a narrower and better-evidenced reason than before — it's Socket.IO
specifically, not "QML can't talk to a socket."

**(b) Plugin UI + a tiny companion daemon for Socket.IO/state — this is the
one the evidence points to, now with a working example of the exact shape.**
This was already "the pattern Omarchy's own first-party plugins use for
anything beyond a one-shot GET" (Dropbox, Agents); §6 adds that it is also
**the pattern a published community plugin uses for a live messaging
protocol**: `srineshr1/omarchy-whatsapp`'s Node daemon bundles a real
WhatsApp Web client (`baileys`), owns the persistent connection, and exposes
it over a Unix domain socket as newline-delimited JSON that
`Quickshell.Io.Socket` + `SplitParser` consumes directly
(`daemon/lib/server.js:7-9`, `WhatsAppClient.qml:262-269`) — this is no
longer a pattern inferred from Dropbox/Agents one level removed, it is the
literal architecture, applied to a harder protocol than BlueBubbles' documented
REST+Socket.IO API, shipped and working today. The plugin itself is then
squarely inside precedented territory, confirmed twice over by
`srineshr1`'s and `gardnmi`'s panels: `Panel {}`/`KeyboardPanel` chrome (both
extend the shared base, not a bespoke window), `ListView` for the thread
list (Clipboard's two-pane list+detail shape is still the closest
first-party template, `Clipboard.qml:460-537`, and both community panels
independently build the same shape), a `TextField`/`TextArea` compose box,
custom `Keys.onPressed` handling, `Exclusive` keyboard focus inherited from
the base panel. One new option not identified before: a **persistent
`Process` with bidirectional stdin/stdout NDJSON** (`gardnmi`'s IRC helper,
`thisisgm/omarchy-discord`'s RPC bridge, `goktugvatandas/omarchy-quick-chat`'s
bridge — three independent authors converge on it) is a working alternative
to a Unix domain socket for the companion-daemon link, worth weighing against
the socket approach on its own merits (no separate listener/socket-file
lifecycle to manage; tied 1:1 to the plugin's own process lifetime instead of
surviving independently). **This is the recommended shape, and it is no
longer a first-party-only inference — it is directly precedented by a
shipped messaging plugin solving the same class of problem.**

**(c) Is the TUI-in-floating-terminal from the prior research doc still
meaningfully cheaper for a first POC?** Yes, and §6 turns the prior
estimate from a plausible-sounding guess into a measured one: real published
messaging plugins solving a comparable or smaller problem land at
`gardnmi/omarchy-irc`'s ~1,383 QML + ~871 helper lines,
`srineshr1/omarchy-whatsapp`'s ~1,432 QML + ~3,481 daemon lines,
`Bottelet/omarchy-slack`'s ~2,334 QML + ~1,327 helper lines, and
`MoizIbnYousaf/Omarchy-Whatsapp`'s ~7,136 QML + ~2,166 helper lines (the
largest, because it also builds a second full-window surface and a
parity-tracked command gateway) — every one of them **several thousand lines
total**, matching the "several thousand lines of new QML plus a whole
separate daemon codebase" estimate almost exactly, and every one of them
built by an author who (per their own repos' design-decision docs, e.g.
`thisisgm/omarchy-discord`'s `knowledge/plugin-design-decisions.md`) spent
real effort on QML/Quickshell idioms specific to this ecosystem. Nothing in
§6 shortens that list — a compose box, an unread-badge state machine, and a
companion-daemon protocol are still new ground beyond what Clipboard/Agents
cover, and the messaging precedents confirm it costs what the estimate said
it would. A ratatui/bubbletea TUI doing the same list+detail+compose job,
talking directly to a Socket.IO client library in a language built for it,
remains the cheaper first POC for the same reason as before: it collapses
"companion daemon" and "UI" into one process in a language with real
networking and TUI libraries, without paying the QML-idiom learning cost §6
shows real authors do pay. Recommendation unchanged from the prior doc:
**build the TUI first to de-risk the BlueBubbles/Socket.IO integration
itself**, then decide whether the "nicer end-state" plugin (UI-only, talking
to the now-proven daemon over a Unix socket or a persistent-`Process`
bridge — §6 offers a working precedent for either) is worth the second
build.
