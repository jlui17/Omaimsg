# Omarchy bar integration and keyboard-native popup UI shapes

Research scope: UI/bar-side integration only, for an iMessage client living in
the Omarchy top bar (unread indicator + a keyboard-driven panel: list chats,
read a thread, type a reply). The iMessage bridge backend is out of scope.

Machine: `sfx`, Omarchy `4.0.1-1`, Hyprland `0.56.2-1`, Quickshell `0.3.1-1`
(`omarchy debug --no-sudo --print`; `pacman -Q hyprland quickshell`).

## 0. What bar does this machine actually run

This machine runs **Quickshell**, not Waybar. The only bar-shaped process is:

```
/usr/bin/quickshell -n -p /usr/share/omarchy/shell
```

launched by `/usr/share/omarchy/bin/omarchy-launch-shell` (`pgrep -a quickshell`;
`ps aux`). There is no `waybar` or `gjs` process running. Omarchy 4's bar,
notification daemon, settings panel, and popups all run **inside one
long-lived Quickshell process** called `omarchy-shell`
(`/usr/share/omarchy/shell/README.md`, and confirmed live: `omarchy-launch-shell`
→ `quickshell -p $OMARCHY_PATH/shell`).

This means every question below should be answered against Quickshell/QML +
Hyprland, not Waybar — Waybar's custom-module JSON protocol only shows up
inside Omarchy as one specific escape hatch (see §1), not as the bar itself.

## 1. Custom module/widget story

### Three tiers, increasing effort

Omarchy's bar (`omarchy.bar`, first-party plugin, `id: omarchy.bar`, kind
`bar`) reads its layout from `~/.config/omarchy/shell.json` under `bar.layout.<section>`,
hot-reloaded on save, no deep-merge once the user has a file
(`/usr/share/omarchy/shell/plugins/bar/README.md`; `/usr/share/omarchy/shell/README.md`
"shell.json shape" / "Storage rules"). Confirmed live: this machine's
`~/.config/omarchy/shell.json` already has a fully-customized `bar.layout`
with three sections (`left`/`center`/`right`) and each entry is `{"id": "omarchy.xxx", ...settings}`.

**Tier 1 — `type: "command"` module.** Lowest effort, Waybar-flavored:

```json
{ "id": "vpn", "type": "command", "exec": "~/.config/omarchy/bar/scripts/vpn-status",
  "interval": 5, "tooltip": "VPN", "onClick": "nm-connection-editor" }
```

The `exec` script's stdout is either plain text or **Waybar-style JSON**
(`{"text":"…","tooltip":"…","class":"…"}`), polled every `interval` seconds;
`onClick` is a shell command run on left-click
(`/usr/share/omarchy/shell/plugins/bar/README.md`, "Custom user modules").
No dynamic push/signal-refresh path exists for this tier — it is poll-only at
the configured interval; forcing a refresh means writing state the script
polls, not signaling the widget.

**Tier 2 — `type: "qml"` module.** A single QML `Item` file dropped at
`~/.config/omarchy/bar/modules/<id>.qml` (or a `source` path elsewhere),
referenced as `{ "id": "gpu", "type": "qml" }` in `shell.json`. The bar injects
`bar` (shell root), `moduleName`, and `settings` into the item at load time; the
widget must declare `implicitWidth`/`implicitHeight` and can use `bar.run(command)`
for click handlers and `bar.foreground`/`bar.fontFamily`/`bar.barSize` for
theme-consistent rendering (`/usr/share/omarchy/shell/plugins/bar/README.md`,
"Custom user modules" and "Bar properties available to widgets"). This is full
QML — badges, live text, animated state — but state lives in the QML file
itself (a `Timer`, a `Process` from `Quickshell.Io`, etc.), not in the bar
host.

**Tier 3 — a real plugin.** A directory at
`~/.config/omarchy/plugins/<plugin-id>/` with its own `manifest.json`
declaring `"kinds": ["bar-widget"]` and a `barWidget.entryPoints` QML file,
following the same manifest schema first-party plugins use
(`/usr/share/omarchy/shell/README.md`, "Plugin manifest"; example schema also
mirrored on the manual at
[omarchy.org/manual/shell-plugins/](https://omarchy.org/manual/shell-plugins/)).
This tier gets everything Tier 2 gets, plus: its own `manifest.json`-declared
settings schema (rendered into Omarchy's settings UI), an `IpcHandler` target
so external processes (a keybinding, a bridge daemon) can call into it
directly, `keepLoaded: true` if the popup should survive between summons, and
first-class support from `omarchy plugin enable/disable`, `omarchy bar move`,
and `omarchy-shell shell rescanPlugins` for hot reload
(`/usr/share/omarchy/shell/README.md`, "Installing a third-party plugin" /
"Installing by hand"). Saving any file under
`~/.config/omarchy/plugins/` auto-reloads (same source, "Installing by hand").

The best concrete template for "one bar icon + one rich popup panel with a
badge and click behaviors" already ships in Omarchy: the **Agents** plugin
(`/usr/share/omarchy/shell/plugins/agents/`, `manifest.json` id
`omarchy.agents`, kind `bar-widget`, entry point `Panel.qml`). Its interaction
contract from the bar's own module catalogue: `left = panel · right = launch
agent · middle = next subscription`
(`/usr/share/omarchy/shell/plugins/bar/README.md`, "Module catalogue"). An
iMessage widget is structurally the same shape: left-click opens the panel,
right-click could compose, middle-click could jump to next unread thread.

### Click handlers and dynamic text/badges

- Tier 1 (`command`): click → `onClick` shell command; badge/text → whatever
  the script prints as Waybar-JSON `text`/`class`, repainted every `interval`
  seconds (`/usr/share/omarchy/shell/plugins/bar/README.md`).
- Tier 2/3 (QML): click → a `MouseArea` with `onPressed`/`onClicked` calling
  `bar.run(...)` or a plugin's own IPC (`/usr/share/omarchy/shell/plugins/bar/README.md`,
  example GPU widget). Badges are hand-rolled QML — there is no generic
  "badge" property on the bar host. The existing pattern is a small
  `Rectangle`/glyph overlaid on the icon with a `color`, e.g. Tailscale's icon
  takes a `badgeColor: root.urgent` property that lights up on a warning state
  (`/usr/share/omarchy/shell/plugins/panels/tailscale/Panel.qml`, lines
  ~385-393 and ~465-473). An unread-count badge for iMessage would follow the
  same shape: a small numeric/dot overlay on the bar icon bound to a QML
  property that a `Process`/service updates.
- Dynamic refresh without polling: a Tier 3 plugin's `IpcHandler` target lets
  an external event (e.g. the iMessage bridge posting "new message") call
  straight into the loaded QML and flip a property, which is instant — no
  poll interval — versus Tier 1's `interval`-bound `exec` polling
  (`/usr/share/omarchy/shell/README.md`, "IPC contract": `summon`, `toggle`,
  `call <id> <method> <arg>`).

## 2. Viable UI shapes for the keyboard-native popup

### (a) Layer-shell native app — Quickshell widget (in-process) or standalone GTK4 + gtk4-layer-shell

Quickshell's popups (what Omarchy itself uses for every bar panel) are built
on `PanelWindow`, which "automatically adapts to use WlrLayershell when
available," so a Quickshell popup **is** a layer-shell surface
([quickshell.org/docs/v0.2.0/types/Quickshell/PanelWindow/](https://quickshell.org/docs/v0.2.0/types/Quickshell/PanelWindow/)).
Keyboard focus on a `WlrLayershell`/`PanelWindow` is controlled by
`keyboardFocus`, one of `WlrKeyboardFocus.None | OnDemand | Exclusive`
(`None`: no keyboard input; `OnDemand`: compositor-mediated focus/unfocus;
`Exclusive`: this surface takes all keyboard input, locking out every other
window) — same three modes GTK4-layer-shell exposes
(`GTK_LAYER_SHELL_KEYBOARD_MODE_{NONE,ON_DEMAND,EXCLUSIVE}`,
[github.com/wmww/gtk4-layer-shell](https://github.com/wmww/gtk4-layer-shell);
[quickshell.org/docs/types/Quickshell.Wayland/WlrKeyboardFocus](https://quickshell.org/docs/types/Quickshell.Wayland/WlrKeyboardFocus)).

Omarchy's own keyboard-native popups already prove this works well for typed
input on this exact machine: the Omarchy menu (`omarchy-menu`, a search-as-you-type
picker) sets `WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive`
unconditionally while open
(`/usr/share/omarchy/shell/plugins/menu/Menu.qml:1024`), and the keyboard-shortcuts
overlay primes briefly into `Exclusive` then relaxes to `OnDemand`
(`/usr/share/omarchy/shell/Ui/KeyboardPanel.qml:98-100`, "Built on PanelWindow
with a brief WlrKeyboardFocus.Exclusive prime"). A chat panel with a reply
`TextField` is the same shape as the menu's search field — type-to-filter/type-to-reply,
arrow-key navigation, `Escape` to close.

Effort to build as a **Tier 3 Omarchy plugin** (QML inside `omarchy-shell`):
lowest of the layer-shell options, because the panel chrome (`Panel.qml` base
class handling open/close/IPC lifecycle, `PanelController`, `Ui/PopupCard.qml`,
`Ui/TextField.qml`, `Ui/Button.qml`) already exists and is exactly what every
first-party panel (audio, network, tailscale, agents) reuses
(`/usr/share/omarchy/shell/Ui/Panel.qml`; `/usr/share/omarchy/shell/plugins/README.md`
catalogue). Cost is learning QML/Quickshell idioms and running unsandboxed
code inside the user's shell process — a crash or infinite loop in the plugin
can affect the whole shell (`/usr/share/omarchy/shell/README.md`, "Plugins run
as unsandboxed code inside `omarchy-shell`").

Effort as a **standalone GTK4 + gtk4-layer-shell binary**, launched from a bar
click via `bar.run(...)` or a keybinding: higher — you own the entire window
lifecycle, IPC-to-bar for the badge, and layer-shell setup yourself, but it is
decoupled from Omarchy's shell process (a crash doesn't touch the bar) and is
portable to non-Omarchy Hyprland setups.

Typing feel: excellent either way — `Exclusive` keyboard focus plus a real
GTK/QML text input is indistinguishable from typing in any other native app.
One documented Hyprland quirk to know about: layer-shell keyboard-focus
*transitions* have had bugs on Hyprland (switching a surface's interactivity
away from `None` doesn't always cleanly release focus back to the window
underneath, requiring a manual focus-away/focus-back to recover) — reported
against Hyprland, not Sway, milestoned for a fix
([github.com/hyprwm/Hyprland/issues/8293](https://github.com/hyprwm/Hyprland/issues/8293)).
This affects the close/hide path of a panel, not the open/typing path, and
Omarchy's own panels already work around it by keeping focus mode static
while open rather than flipping it mid-session.

### (b) TUI in a floating/special-workspace terminal window

Omarchy has a **first-class, already-wired convention** for exactly this
shape: TUI apps launched with a dedicated Wayland `app-id` of the form
`org.omarchy.<name>`, via:

```
omarchy-launch-tui [--app-id=<id>] <command> [args...]   # launches in $TERMINAL with that app-id
omarchy-launch-or-focus-tui [--app-id=<id>] <command>    # focuses an existing window instead of relaunching
```

(`/usr/bin/omarchy-launch-tui`, `/usr/bin/omarchy-launch-or-focus-tui` —
read directly; the bar README itself demonstrates this exact pattern for a
custom QML widget's click handler: `bar.run("omarchy-launch-or-focus-tui btop")`,
`/usr/share/omarchy/shell/plugins/bar/README.md`). `omarchy-launch-or-focus`
underneath does a `hyprctl clients -j` lookup by class/title regex and either
focuses the existing window or launches fresh (`/usr/bin/omarchy-launch-or-focus`).

Window rules already match this convention globally: any window whose class
matches `org\.omarchy\..*|TUI\..*` (among terminal emulators) gets tagged
`+floating-window`, and the `floating-window` tag rule centers it at a fixed
`875x600` (`/usr/share/omarchy/default/hypr/apps/terminals.lua:3`,
`/usr/share/omarchy/default/hypr/apps/system.lua:1-9`). So a Rust/ratatui or
Go/bubbletea iMessage TUI launched as
`omarchy-launch-or-focus-tui --app-id=org.omarchy.imessage imsg-tui` gets, for
free, floating-centered placement and toggle-focus-or-launch from a
keybinding — no Hyprland config authoring required beyond the bind itself.

Keyboard focus: this is a **normal Wayland toplevel**, not a layer-shell
surface, so none of the layer-shell focus modes or quirks in (a) apply — it
just receives focus like any other window when Hyprland focuses it. Typing
feel is a plain terminal app: excellent for a chat-log-plus-reply-line UI
(this is essentially what `irssi`/`weechat` are), slightly worse than (a) if
Justin wants proportional fonts, inline images/avatars, or rich formatting,
which a TUI can only approximate.

Effort to build: lowest of the three real options if the backend is a CLI/API
already — ratatui or bubbletea for a scrollback list + input line is a
well-trodden pattern, and zero Hyprland/Omarchy plumbing is required beyond
one keybinding and (optionally) one `org.omarchy.*` app-id registration. This
is the path with the least new infrastructure to learn, since Omarchy's own
docs already hand you the launcher scripts and the window rule is global.

### (c) walker/rofi-style picker for quick actions

Omarchy's own root menu (`omarchy-menu`) is exactly this shape: a
Quickshell-native, keyboard-driven fuzzy picker summoned over shell IPC
(`omarchy-shell shell toggle omarchy.menu ...`), defined declaratively in
`default/omarchy/omarchy-menu.jsonc` + user
`~/.config/omarchy/extensions/omarchy-menu.jsonc`
(`/usr/share/omarchy/shell/plugins/README.md`, "Omarchy menu"). This shape is
good for **quick actions** — "jump to chat X," "mark all read," "reply to last
message" as a one-line quick-capture — but it is not a chat UI: no scrollback,
no multi-line compose, no persistent view. It's a plausible complement (e.g.
`SUPER+.`-style quick-reply) but not a substitute for (a) or (b) as the primary
panel. Effort to build one entry is trivial (a JSONC menu entry calling a
script), but building a *new* rofi/walker-style picker surface for chat
content specifically would mean reimplementing scrollback and multi-line
input on top of a picker paradigm that isn't designed for either — higher
effort than it looks and worse UX than (a)/(b) for anything beyond a single
action.

## 3. Unread badge + global keybinding to pop the panel

**Badge on the bar:** in Omarchy's model this is one of:
- A Tier 1 `command` module whose script prints Waybar-style JSON
  (`{"text":"3","class":"unread"}`), repainted on its `interval`
  (`/usr/share/omarchy/shell/plugins/bar/README.md`).
- A Tier 2/3 QML widget with a bound property (e.g. `unreadCount`) rendered as
  a small overlay, following the same shape as Tailscale's `badgeColor`
  property on its icon component
  (`/usr/share/omarchy/shell/plugins/panels/tailscale/Panel.qml`). For a
  count rather than a status dot, add a `Text`/`Rectangle` badge bound to that
  property instead of only a color.
- Instant refresh (no polling) requires Tier 3: the plugin registers its own
  `IpcHandler` target (as `Panel.qml`/`Ui/Panel.qml`'s base class already does
  for every first-party panel — `ipcTarget`, `open`/`close`/`toggle` methods,
  `/usr/share/omarchy/shell/Ui/Panel.qml`), and the iMessage bridge process
  calls `omarchy-shell <target> <method> <arg>` (or a custom method) whenever
  the unread count changes, e.g. `call omarchy.imessage setUnread 3`
  (`/usr/share/omarchy/shell/README.md`, "IPC contract": `call <id> <method>
  <arg>`).

**Global keybinding to open/toggle the panel:** Hyprland keybindings live in
`~/.config/hypr/bindings.lua`, loaded after Omarchy's defaults, format
`o.bind("<KEYS>", "<description>", "<command or launch table>")`
(`~/.claude/skills/omarchy/hyprland.md`; confirmed live in
`~/.config/hypr/bindings.lua`, which already has a working example:
`o.bind("SUPER + PERIOD", nil, "omarchy-shell shell toggle omarchy.emojis")`).
The exact same shape works for a chat panel plugin:

```lua
o.bind("SUPER + M", "Messages", "omarchy-shell shell toggle omarchy.imessage")
```

which round-trips through the shell's `toggle <id> <payloadJson>` IPC method
(`/usr/share/omarchy/shell/README.md`, "IPC contract"). For option (b) (a TUI
window instead of a shell plugin), the binding instead targets the
launch-or-focus script directly:

```lua
o.bind("SUPER + M", "Messages", "omarchy-launch-or-focus-tui --app-id=org.omarchy.imessage imsg-tui")
```

Any existing key must be freed first via `hl.unbind("<KEYS>")` before
rebinding (`~/.claude/skills/omarchy/hyprland.md`); `SUPER + M` came back
unbound both from `grep -rn "SUPER + M" ~/.config/hypr/*.lua /usr/share/omarchy/default/hypr/**/*.lua`
and from `omarchy menu keybindings --print`, so no unbind is needed for that
specific key today — re-verify with `omarchy menu keybindings --print` at
implementation time since defaults can change between Omarchy versions.

Hyprland-side primitives available if the panel instead needs its own
toggle-visibility semantics as a window (relevant mainly to option (b)):
`hyprctl dispatch togglespecialworkspace <name>` toggles a named scratchpad
workspace on/off per monitor (floating windows cannot live in a special
workspace — making a window floating pulls it back to the active real
workspace, so use this for a normal toplevel, not layer-shell surface)
([wiki.hypr.land/…/Configuring/Dispatchers/](https://wiki.hypr.land/0.41.2/Configuring/Dispatchers/)).
Layer-surface-specific tuning (blur, no-animation for a frequently-updating
badge, xray) is done with a Hyprland `layerrule`/`hl.layer_rule` keyed on the
surface's `namespace` (visible via `hyprctl layers`), e.g. `no_anim = true`
for a clock-like frequently-refreshing layer
([wiki.hypr.land Layer Rules](https://deepwiki.com/hyprwm/hyprland-wiki/3.4-layer-rules);
0.55+ lua form: `hl.layer_rule({ match = { namespace = "..." }, blur = true })`).

## 4. Omarchy updates vs. customizations

Everything under `/usr/share/omarchy/` (including the shipped bar/plugin QML)
is package-owned and **will be overwritten** on `omarchy update` —
`~/.claude/skills/omarchy/plugins.md` and `~/.claude/skills/omarchy/hyprland.md`
both state this plainly, and it's the reason Omarchy provides `omarchy plugin
clone` rather than "just edit the shipped file." Concretely:

- `~/.config/omarchy/shell.json` (bar layout + all widget settings) and
  `~/.config/omarchy/plugins/<id>/` (any custom widget/plugin source) are
  **user-owned and update-safe** — they are never touched by
  `omarchy update`, because they live outside `/usr/share/omarchy/`
  (`/usr/share/omarchy/shell/README.md`, "Persisted state").
- `~/.config/hypr/bindings.lua` (and the other `~/.config/hypr/*.lua` files)
  are loaded *after* Omarchy's own defaults and are the sanctioned override
  surface for keybindings — same update-safety property
  (`~/.claude/skills/omarchy/hyprland.md`).
- If Omarchy's own system-level configs occasionally need restoring to
  original on update, the update system backs up the previous version to a
  `.bak` file in place rather than silently discarding it, and any single
  config can be manually reset via Update → Config in the Omarchy menu
  (per the Omarchy manual's Updates page, summarized via web search of
  [omarchy.org/manual/updates/](https://omarchy.org/manual/updates/); not
  independently re-fetched verbatim, so treat as directionally correct rather
  than word-for-word quoted).
- Cloning a first-party widget (`omarchy plugin clone omarchy.clock` →
  `<username>.clock`) is the sanctioned way to fork built-in behavior; not
  relevant to a brand-new iMessage plugin (which has no built-in to clone),
  but relevant if the eventual implementation starts from, say, the Agents
  plugin as a template — copy it into a new plugin id rather than editing
  `/usr/share/omarchy/shell/plugins/agents/` in place.
- Third-party plugin **updates** (if this ever becomes a git-distributed
  plugin via `omarchy plugin add`) are explicit fast-forward pulls the user
  triggers (`omarchy plugin update <id>`), shown as a diff before applying,
  and never touched automatically by `omarchy update`
  (`/usr/share/omarchy/shell/README.md`, "Installing a third-party plugin").

Net: as long as the iMessage integration lives in `~/.config/omarchy/shell.json`
+ `~/.config/omarchy/plugins/imessage/` (or a Tier 1/2 script/QML file under
`~/.config/omarchy/bar/`) and `~/.config/hypr/bindings.lua`, an `omarchy
update` cannot clobber it — that boundary is the entire point of the
`/usr/share/omarchy` vs `~/.config/omarchy` split.

## Recommendation

**Lowest-friction proof of concept: option (b), a TUI in Omarchy's existing
floating-terminal convention.** Write a small ratatui/bubbletea app (chat list
+ thread view + reply line) and launch it with
`omarchy-launch-or-focus-tui --app-id=org.omarchy.imessage <binary>` bound to
a spare `SUPER`+key combo. This needs zero new Hyprland/Quickshell plumbing —
the `org.omarchy.*` window rule already floats and centers it at 875×600, the
launch-or-focus script already gives toggle-focus-or-launch semantics, and
keyboard focus is a plain toplevel with none of the layer-shell focus-mode
questions to work through. The only missing piece for the "indicator" half of
the ask is a badge, which can be a Tier 1 `command` bar module (a script that
prints the bridge's unread count as Waybar-JSON on an interval) — trivial, if
laggy by up to `interval` seconds, which is an acceptable proof-of-concept
tradeoff.

**Nicer end-state: option (a) as a Tier 3 Omarchy shell plugin.** One bar icon
with a real live-updating unread badge (via the plugin's own `IpcHandler`
target, pushed by the bridge instantly instead of polled) and one popup panel
built from Omarchy's existing `Panel`/`PopupCard`/`TextField` UI primitives —
the same components every first-party panel (audio, network, agents) already
uses, so it inherits Omarchy's look, its `Exclusive`-keyboard-focus pattern
proven by the Omarchy menu, and `omarchy plugin enable/disable` /
`omarchy bar move` management for free. This is more QML to write than the
TUI, and it runs unsandboxed inside the user's shell process, but it is the
shape that actually delivers "an indicator plus a panel living in the top bar"
as one integrated widget rather than a bar badge pointing at a separate
window.
