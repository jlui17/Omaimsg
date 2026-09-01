# Testing

Three suites and two manual checks. `mise run test` runs all three in order, cheapest first.

```sh
mise run test          # everything
mise run test:paths    # plugin id -> state path derivation (test/paths.test.js)
mise run test:daemon   # daemon protocol over the real Unix socket (test/smoke.js)
mise run test:ui       # widget and panel, rendered headlessly (test/qsmcp/check.py)
```

## Setup

```sh
sudo pacman -S sway cue jq wtype   # UI checks only
mise run setup                     # workspace deps for daemon/ and test/
```

`sway` never replaces your session compositor. The UI checks boot it headless
(`WLR_BACKENDS=headless`, no GPU), so a run never touches your desktop. `cue` validates the harness
profile, `jq` reads the harness pin, and `wtype` delivers keystrokes.

`mise run setup` installs the dependencies a fresh checkout or worktree needs. A worktree starts
without them whatever created it (a t3code thread, `EnterWorktree`, `wtnew`), so the SessionStart
hook in `.claude/settings.json` says so when it sees a worktree with no `node_modules`. It only
reminds; provisioning stays a command someone runs.

Also assumed present: `node`, `npm`, `rsync`, `mise`, and `uv` (fetches the harness; no Python
install of your own). Omarchy supplies `qs`, `qmllint`, and `omarchy plugin`.

## The manual checks

```sh
/usr/lib/qt6/bin/qmllint *.qml     # the bare qmllint on PATH is Qt5's and rejects valid QML6
omarchy plugin validate .          # manifest + plugin folder
```

`qmllint` warns about unresolved `qs.Ui` and `Quickshell` imports outside the shell tree. That is
expected. `omarchy plugin validate` rejects symlinks anywhere in the tree, and npm's workspace linker puts
one in `node_modules/` for each workspace, so run it from a fresh clone rather than a provisioned
checkout.

## What the UI checks cover

The protocol suites stop at the socket. `test/qsmcp/check.py` picks up where they stop, asserting
what the widget renders and how the panel answers the keyboard:

- **Build identity**: the install you use renders a bare glyph and no build line; a variant renders
  its id beside the glyph, keeps it when a count arrives, and names its branch and sha in the panel
  header. Both staged installs carry a `.deploy.json`, so the checks pin the recorded flag rather
  than whether the file exists.
- **The unread badge**: bare glyph at zero, the conversation count beside the glyph, the `99+` clamp, the tooltip.
- **The chat list**: the daemon's order survives into what renders, and the empty state clears.
- **Pinning**: a pinned chat renders first, unpinning restores the recency order.
- **Keyboard**: `j`/`k` walk the chat list, `l` opens the chat under the cursor.
- **The composer**: `i` focuses it, typing lands in it, `Enter` sends into the thread and clears it.
- **Thread paging**: reaching the oldest end pages past the first page, pages join in timestamp
  order, and draining the thread ends exhausted without duplicating a message.

`test:ui` re-stages first, so it never runs against a stale copy.

## How the UI checks work

Tests are Python because the harness is. They import `Driver` from the pinned quickshell-mcp
package, which boots the compositor, spawns the backends, and speaks to the probe. **The MCP server
is not involved.** MCP is the interactive door, for an agent to boot the plugin and look around;
`Driver` is the programmatic one, for tests.

Keystrokes are real. `keys()` shells out to `wtype`, which drives the Wayland virtual-keyboard
protocol, so a test exercises the same path a person's keypress takes rather than calling the
handler directly. Each call brackets the keystroke with `-s 300`: wtype's keyboard dies with the
process, and sway drops events delivered before the keymap settles, so without the sleeps nothing
arrives and nothing reports an error.

Nodes are addressed by what they are, not by index: the bar widget is the node whose `moduleName` is
`io.omaimsg`, the composer is the field whose placeholder starts with `Message`. Index paths would
move the moment Omarchy reorders the bar.

Each finder is also rooted at the widget that owns it, because the staged bar holds two installs of
this plugin. "The first node with a composer" would otherwise answer for whichever of the two the
walk reached first, and which one that is has nothing to do with the change under test.

`test/qsmcp/daemon-config.json` runs the daemon with a five-message page, because the fake server
gives each chat 10 to 30 messages and the default page of 60 would swallow every thread whole,
leaving nothing for the paging checks to page. It carries no `serverUrl`: the fake server adds one for the
port it took into the seeded copy the harness points `OMAIMSG_CONFIG` at.

## The harness

`.mcp.json` registers [quickshell-mcp](https://github.com/jlui17/quickshell-mcp), pinned to a
commit, as a project-scoped MCP server. It boots the plugin inside a headless sway, then exposes
`tree()`, `find()`, `get_property()`/`set_property()`, `qml_eval()`, and `invoke()` over `qs ipc`.

The pin is a fork of [hsjobeki/quickshell-mcp](https://github.com/hsjobeki/quickshell-mcp) carrying
two fixes to the probe's child walk. Upstream targets single-window apps, where the config root is a
plain `Item`. A Quickshell shell root is neither: reading its `children` raises "List doesn't define
a Count function", and its windows hang off object properties instead of any list. Without both
fixes `windows()` returns nothing at all.

Build the config tree it boots, once, and again after any Omarchy upgrade or QML change:

```sh
mise run stage
```

That writes `test/qsmcp/stage/` (gitignored): a private copy of Omarchy's shell tree, this repo
installed twice -- into `plugins/io.omaimsg` and again into `plugins/io.omaimsg.b` with only the
manifest `id` rewritten -- and a fake `HOME` whose bar layout carries both. The second install is
what lets the identity checks fail: both widgets run the same QML off the same disk, so if the id
were hardcoded rather than read from the manifest they would claim the same name, the same IPC
target, and the same daemon socket. Neither install autostarts a daemon, so this stays a UI check. Staging is
what makes the harness see the real components. `BarWidget.qml` and `Panel.qml` root on `BarWidget`
and `Panel` from `qs.Ui`, which lives in `/usr/share/omarchy/shell`, so this repo has no entry point
that runs on its own. `test/qsmcp/profile.json` then points the harness at the staged shell and
starts two backends first: `test/server.js` and the real daemon, each gated on its own readiness
signal.

The fake server takes port `0`, so the kernel picks a free one and a harness can run in each of two
worktrees at once. The profile seeds `daemon-config.json` into the harness's own work dir, and the
server writes its port into that copy as `serverUrl` before it announces itself, which is the line
the daemon's start waits on. Everything else a run owns is already private to it: the compositor,
the daemon's socket (the harness gives each boot its own `XDG_RUNTIME_DIR`), and the stage tree.

`stage.sh` also writes a `qmldir` into every directory `shell.qml` imports by relative path. Left to
scan those directories itself, quickshell resolves them racily under the harness: a different type
fails to load on each boot.

`test/qsmcp/shell.json` is the staged bar layout. It sets `autostartDaemon: false`, because the
harness owns the daemon.

To see what rendered, capture the compositor while the harness is up. Name the harness's runtime
dir; `shot.sh` captures that one and nothing else:

```sh
./test/qsmcp/shot.sh "$XDG_RUNTIME_DIR_OF_THE_HARNESS" /tmp/bar.png
```

The harness object carries the dir (`srv.HARNESS._xdg`, which `check.py` already reads to point
`wtype` at the right compositor). Over MCP, ask the app itself:
`qml_eval("Quickshell.env('XDG_RUNTIME_DIR')")`. `shot.sh` deliberately does not go looking: a
harness runs per worktree, so a script that scanned `/tmp` would capture a sibling's compositor and
exit 0, and a plausible screenshot of someone else's build is worse than no screenshot.

The probe's own `screenshot()` cannot grab an Omarchy bar, because it requires the window's content
item to have exactly one visual child and `BarPanel` has two. Capturing the compositor also records
what the screen really shows, and takes video through the same socket.
