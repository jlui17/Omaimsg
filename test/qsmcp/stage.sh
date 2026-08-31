#!/usr/bin/env bash
# Builds the config tree quickshell-mcp boots: a private copy of Omarchy's shell
# with this repo installed as a plugin, under a fake HOME holding the bar layout.
# Rerun after an Omarchy upgrade or any QML change.
set -euo pipefail

OMARCHY_SRC="${OMARCHY_SRC:-/usr/share/omarchy}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STAGE="$HERE/stage"
PLUGIN="$STAGE/home/.config/omarchy/plugins/io.omaimsg"
# A second install of the same tree under a different id. It is what makes the
# identity check able to fail: with the id hardcoded in QML both widgets would
# claim io.omaimsg, and nothing else in the suite distinguishes them.
#
# Its directory is deliberately not named after its id. BarWidget falls back to
# the directory name when the manifest will not parse, so a matching directory
# would answer for the manifest and the check would pass with the read broken.
VARIANT_ID=$(jq -r '.bar.layout.right[1].id' "$HERE/shell.json")
VARIANT="$STAGE/home/.config/omarchy/plugins/second-install"

[[ -d $OMARCHY_SRC/shell ]] || {
  echo "no Omarchy shell at $OMARCHY_SRC/shell (set OMARCHY_SRC)" >&2
  exit 1
}

rm -rf "$STAGE"
mkdir -p "$STAGE/config/omarchy" "$PLUGIN" "$VARIANT"

rsync -a "$OMARCHY_SRC/shell/" "$STAGE/shell/"
cp "$OMARCHY_SRC/config/omarchy/shell.json" "$STAGE/config/omarchy/shell.json"
cp "$HERE/shell.json" "$STAGE/home/.config/omarchy/shell.json"

rsync -a --exclude .git --exclude node_modules --exclude .worktrees \
  --exclude /test/qsmcp/stage "$REPO/" "$PLUGIN/"

rsync -a "$PLUGIN/" "$VARIANT/"
jq --arg id "$VARIANT_ID" '.id = $id' "$PLUGIN/manifest.json" >"$VARIANT/manifest.json"

# Declare the types in every directory shell.qml pulls in by relative path.
# Left to scan those directories itself, quickshell resolves them racily under
# the probe wrapper: a different type fails to resolve on each boot.
while read -r dir; do
  [[ -d $STAGE/shell/$dir ]] || continue
  : >"$STAGE/shell/$dir/qmldir"
  for f in "$STAGE/shell/$dir"/*.qml; do
    [[ -e $f ]] || continue
    printf '%s 1.0 %s\n' "$(basename "$f" .qml)" "$(basename "$f")" >>"$STAGE/shell/$dir/qmldir"
  done
done < <(grep -oP '^import "\K[^"]+' "$STAGE/shell/shell.qml")

echo "staged: $STAGE"
