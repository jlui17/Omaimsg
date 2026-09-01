#!/bin/bash
# Installs omaimsg into the Omarchy plugin directory: copies the tree when run
# from a source checkout, installs the daemon's dependency, writes a config
# template, starts the user service, and enables the bar widget.
#
# Safe to re-run. --uninstall removes one plugin id and everything it owns,
# including the config file holding the BlueBubbles password.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# Hardcoded rather than XDG-derived because omarchy-plugin-add hardcodes it too;
# deriving it here would put the two on different paths on the same machine.
PLUGINS_ROOT="$HOME/.config/omarchy/plugins"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TEMPLATE="omaimsg-daemon@.service"

# The one copy of what a plugin install excludes. README points here rather than
# repeating it.
RSYNC_EXCLUDES=(
  --exclude .git
  --exclude node_modules
  --exclude .worktrees
  --exclude .mcp.json
  --exclude .claude
  --exclude /test/qsmcp/stage
)

die() {
  echo "install: $*" >&2
  exit 1
}

say() { echo "==> $*"; }

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--uninstall]

  --uninstall   remove the plugin, its service, and its state, including the
                config file holding the BlueBubbles password
  -h, --help    this message
USAGE
}

uninstall=0
while (( $# > 0 )); do
  case "$1" in
  --uninstall) uninstall=1; shift ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; die "unknown argument: $1" ;;
  esac
done

command -v jq >/dev/null || die "jq is required"
[[ -f $SOURCE_DIR/manifest.json ]] || die "no manifest.json beside this script"
PLUGIN_ID="$(jq -re '.id' "$SOURCE_DIR/manifest.json")" || die "manifest.json has no id"
PLUGIN_DIR="$PLUGINS_ROOT/$PLUGIN_ID"
UNIT_INSTANCE="omaimsg-daemon@$PLUGIN_ID.service"

# The daemon owns every rule for turning an id into a state path, so ask it
# rather than restating them here. Reads from the installed copy when there is
# one, so an uninstall uses the same rules the running daemon used.
instance_paths() {
  local from="$PLUGIN_DIR"
  [[ -f $from/daemon/lib/paths.js ]] || from="$SOURCE_DIR"
  node --input-type=module -e '
    const [entry, id] = process.argv.slice(1)
    const { instancePaths } = await import(entry)
    const p = instancePaths(id)
    console.log([p.configPath, p.pinsPath, p.attachmentsDir, p.socketPath].join("\n"))
  ' "$from/daemon/lib/paths.js" "$PLUGIN_ID"
}

if (( uninstall )); then
  mapfile -t paths < <(instance_paths)
  config_path="${paths[0]}"

  say "Stopping $UNIT_INSTANCE"
  systemctl --user disable --now "$UNIT_INSTANCE" 2>/dev/null || true
  rm -f "$UNIT_DIR/default.target.wants/$UNIT_INSTANCE"

  # The template serves every installed id, so it only goes when the last one does.
  if ! compgen -G "$UNIT_DIR/default.target.wants/omaimsg-daemon@*.service" >/dev/null; then
    rm -f "$UNIT_DIR/$UNIT_TEMPLATE"
    say "Removed $UNIT_TEMPLATE (no instances left)"
  else
    say "Kept $UNIT_TEMPLATE — other instances still use it"
  fi
  systemctl --user daemon-reload

  if [[ -d $PLUGIN_DIR ]]; then
    say "Removing $PLUGIN_DIR"
    omarchy plugin disable "$PLUGIN_ID" 2>/dev/null || true
    rm -rf "$PLUGIN_DIR"
  fi

  for p in "${paths[@]}"; do
    [[ -e $p ]] || continue
    say "Removing $p"
    rm -rf "$p"
    # The id-named directory holding it is ours too, so it goes when it empties.
    # Guarded by name because the socket's parent is the shared runtime dir.
    parent="$(dirname "$p")"
    [[ "$(basename "$parent")" == "$PLUGIN_ID" ]] &&
      rmdir --ignore-fail-on-non-empty "$parent"
  done
  echo
  say "Deleted $config_path, which held your BlueBubbles server password."
  command -v omarchy-shell >/dev/null && omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
  exit 0
fi

if [[ $SOURCE_DIR != "$PLUGIN_DIR" ]]; then
  say "Copying into $PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"
  # A real copy, never a symlink: the shell's file watcher cannot see writes
  # through one, so hot reload never fires.
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SOURCE_DIR/" "$PLUGIN_DIR/"
  command -v omarchy-shell >/dev/null && omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
fi

command -v mise >/dev/null || die "mise is required (Omarchy ships it)"
say "Installing the pinned toolchain"
mise install --cd "$PLUGIN_DIR"

say "Installing the daemon's dependency"
mise exec --cd "$PLUGIN_DIR" -- npm ci --omit=dev --workspace daemon --prefix "$PLUGIN_DIR"

mapfile -t paths < <(instance_paths)
config_path="${paths[0]}"
fresh_config=0
if [[ ! -f $config_path ]]; then
  mkdir -p "$(dirname "$config_path")"
  cat >"$config_path" <<'CONFIG'
{
  "serverUrl": "http://<mac-ip>:1234",
  "password": "<bluebubbles server password>"
}
CONFIG
  fresh_config=1
  say "Wrote a config template to $config_path"
fi

say "Installing $UNIT_TEMPLATE"
mkdir -p "$UNIT_DIR"
node_bin="$(mise which node --cd "$PLUGIN_DIR")"
[[ -x $node_bin ]] || die "could not resolve node through mise"
# Resolved now rather than left to systemd: a user unit's PATH does not include
# mise's shims, so an unresolved `node` fails on exactly the setup Omarchy gives
# everyone.
sed "s|@NODE@|$node_bin|" "$PLUGIN_DIR/systemd/$UNIT_TEMPLATE" >"$UNIT_DIR/$UNIT_TEMPLATE"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_INSTANCE"
# Restart rather than start: on a re-install the daemon is already up, running
# the code this run just replaced.
systemctl --user restart "$UNIT_INSTANCE"
say "Enabled and started $UNIT_INSTANCE"

if [[ "$(omarchy-plugin-list --json | jq -r --arg id "$PLUGIN_ID" 'map(select(.id == $id))[0].enabled // false')" != true ]]; then
  say "Adding the widget to the bar"
  omarchy plugin enable "$PLUGIN_ID"
fi

echo
if (( fresh_config )); then
  say "Fill in $config_path with your BlueBubbles server URL and password,"
  say "then: systemctl --user restart $UNIT_INSTANCE"
else
  say "Done."
fi
