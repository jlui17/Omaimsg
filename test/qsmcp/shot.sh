#!/usr/bin/env bash
# Captures the headless compositor while the harness is up. The MCP server owns
# the sway instance and never exports its socket, so this locates the runtime
# dir the server made and captures through that.
#
# The probe's own screenshot() cannot grab an Omarchy bar: it requires the
# window's content item to have exactly one visual child, and BarPanel has two.
# Capturing the compositor also records what the screen really shows, and takes
# video through the same socket.
set -euo pipefail

OUT="${1:-/tmp/omaimsg-headless.png}"

mapfile -t dirs < <(find /tmp -maxdepth 2 -type d -name xdg -path '/tmp/quickshell-mcp-*' 2>/dev/null)
live=()
for d in "${dirs[@]}"; do
  compgen -G "$d/wayland-*" >/dev/null && live+=("$d")
done

case ${#live[@]} in
  0) echo "no live harness: call the MCP server's up() first" >&2; exit 1 ;;
  1) ;;
  *) printf 'more than one live harness, pass XDG_RUNTIME_DIR yourself:\n%s\n' "${live[*]}" >&2; exit 1 ;;
esac

sock=$(basename "$(compgen -G "${live[0]}/wayland-[0-9]*" | head -1)")
XDG_RUNTIME_DIR="${live[0]}" WAYLAND_DISPLAY="$sock" grim "$OUT"
echo "$OUT"
