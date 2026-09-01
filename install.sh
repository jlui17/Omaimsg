#!/bin/bash
# Installs omaimsg into the Omarchy plugin directory: copies the tree when run
# from a source checkout, installs the daemon's dependency, writes a config
# template, starts the user service, and enables the bar widget.
#
# Given a plugin id, installs under that id instead, which makes it a separate
# install with its own bar entry, daemon, and state. Safe to re-run.
# --uninstall removes one id and everything it owns, including the config file
# holding the BlueBubbles password.

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
  # Written per install, so a source tree that has one must not seed the target.
  --exclude /.deploy.json
)

die() {
  echo "install: $*" >&2
  exit 1
}

say() { echo "==> $*"; }

usage() {
  cat <<'USAGE'
Usage: ./install.sh [<plugin-id>] [--no-restart]
       ./install.sh --uninstall [<plugin-id>]

  <plugin-id>   install under this id instead of the manifest's, giving it its
                own bar entry, daemon, and state
  --no-restart  skip the shell restart, so several installs can share one
  --uninstall   remove the plugin, its service, and its state, including the
                config file holding the BlueBubbles password
  -h, --help    this message
USAGE
}

uninstall=0
restart_shell=1
target_id=""
while (( $# > 0 )); do
  case "$1" in
  --uninstall) uninstall=1; shift ;;
  --no-restart) restart_shell=0; shift ;;
  -h | --help) usage; exit 0 ;;
  -*) usage >&2; die "unknown option: $1" ;;
  *)
    [[ -z $target_id ]] || die "one plugin id at a time"
    target_id="$1"; shift ;;
  esac
done

command -v jq >/dev/null || die "jq is required"
[[ -f $SOURCE_DIR/manifest.json ]] || die "no manifest.json beside this script"
SOURCE_ID="$(jq -re '.id' "$SOURCE_DIR/manifest.json")" || die "manifest.json has no id"
PLUGIN_ID="${target_id:-$SOURCE_ID}"
# The rules omarchy-plugin-validate enforces, checked here because that command
# cannot run against a provisioned tree (it rejects the symlinks npm's workspace
# linker leaves) and because this id names a directory we create and a systemd
# instance we start.
[[ $PLUGIN_ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && $PLUGIN_ID != *..* ]] ||
  die "invalid plugin id '$PLUGIN_ID'"
[[ $PLUGIN_ID != omarchy.* ]] || die "plugin id '$PLUGIN_ID' uses the reserved omarchy.* namespace"
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

# A re-install from the installed copy has neither an id to compare nor a .git to
# read, so the stamp already there is the only source for what this build is; the
# rsync excludes it precisely so it survives to be read. Read before anything is
# copied, so a stamp we cannot use stops the install while it is still a no-op.
prev_variant=false prev_branch="" prev_sha=""
if [[ -f $PLUGIN_DIR/.deploy.json ]]; then
  mapfile -t prev < <(
    jq -r 'if .variant then "true" else "false" end, (.branch // ""), (.sha // "")' \
      "$PLUGIN_DIR/.deploy.json" 2>/dev/null
  )
  (( ${#prev[@]} == 3 )) ||
    die "cannot read $PLUGIN_DIR/.deploy.json; delete it and re-run, naming the id if this is a variant"
  prev_variant="${prev[0]}" prev_branch="${prev[1]}" prev_sha="${prev[2]}"
fi

if [[ $SOURCE_DIR != "$PLUGIN_DIR" ]]; then
  say "Copying into $PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"
  # A real copy, never a symlink: the shell's file watcher cannot see writes
  # through one, so hot reload never fires.
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SOURCE_DIR/" "$PLUGIN_DIR/"
fi

# The id is the whole identity, so rewriting it in the installed copy is what
# makes this a separate install rather than a second copy of the same one.
if [[ $PLUGIN_ID != "$SOURCE_ID" ]]; then
  tmp="$(mktemp)"
  jq --arg id "$PLUGIN_ID" '.id = $id' "$PLUGIN_DIR/manifest.json" >"$tmp"
  mv "$tmp" "$PLUGIN_DIR/manifest.json"
  say "Installed as $PLUGIN_ID"
fi

# After the rewrite, never before: the registry is keyed by manifest id, so a
# scan of a variant still carrying the source id registers it as the install you
# use and points that entry at the variant's directory.
command -v omarchy-shell >/dev/null && omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true

variant="$prev_variant"
if [[ -n $target_id ]]; then
  variant=false
  [[ $PLUGIN_ID != "$SOURCE_ID" ]] && variant=true
fi

# Only when the source is the repo root itself. An installed copy has no .git of
# its own, and a bare rev-parse walks up until it finds one -- stamping a
# dotfiles ~/.config as this build's provenance. Resolving HEAD too, because a
# clone with no commit has a toplevel and no HEAD.
branch="$prev_branch" sha="$prev_sha"
if [[ "$(git -C "$SOURCE_DIR" rev-parse --show-toplevel 2>/dev/null)" == "$SOURCE_DIR" ]] &&
   git -C "$SOURCE_DIR" rev-parse HEAD >/dev/null 2>&1; then
  branch="$(git -C "$SOURCE_DIR" rev-parse --abbrev-ref HEAD)"
  sha="$(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
fi
# Written whole: a stamp truncated by an interrupted install is one the next run
# refuses to proceed against.
tmp="$(mktemp)"
jq -n --argjson variant "$variant" --arg branch "$branch" --arg sha "$sha" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{variant: $variant, branch: $branch, sha: $sha, at: $at}' >"$tmp"
mv "$tmp" "$PLUGIN_DIR/.deploy.json"

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

if (( restart_shell )); then
  say "Restarting the shell"
  omarchy-restart-shell
fi

echo
if (( fresh_config )); then
  say "Fill in $config_path with your BlueBubbles server URL and password,"
  say "then: systemctl --user restart $UNIT_INSTANCE"
else
  say "Done."
fi
