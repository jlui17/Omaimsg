#!/usr/bin/env bash
# Captures the headless compositor while the harness is up. The MCP server owns
# the sway instance and never exports its socket, so the runtime dir it made is
# named by the caller -- the harness object carries it, and check.py already
# reads it for wtype. A harness runs per worktree, so a script that went looking
# in /tmp would capture a sibling's compositor and exit 0.
#
# The probe's own screenshot() cannot grab an Omarchy bar: it requires the
# window's content item to have exactly one visual child, and BarPanel has two.
# Capturing the compositor also records what the screen really shows, and takes
# video through the same socket.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: shot.sh <XDG_RUNTIME_DIR> [out.png]" >&2
  exit 2
fi

xdg="$1"
OUT="${2:-/tmp/omaimsg-headless.png}"

# pipefail would abort the assignment on no match, which is the case that
# needs the message.
sock=$(compgen -G "$xdg/wayland-[0-9]*" | head -1) || true
if [[ -z $sock ]]; then
  echo "no live harness in $xdg: call the MCP server's up() first" >&2
  exit 1
fi

XDG_RUNTIME_DIR="$xdg" WAYLAND_DISPLAY="$(basename "$sock")" grim "$OUT"
echo "$OUT"
