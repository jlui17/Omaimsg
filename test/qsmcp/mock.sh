#!/usr/bin/env bash
# The fake BlueBubbles server on a kernel-assigned port instead of a fixed one,
# so a harness in each of two worktrees can run at the same time. Only this side
# knows the port, so it also writes the daemon's config; $1 is the harness's
# per-boot work dir, which profile.json points OMAIMSG_CONFIG into.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1"

# Bound and released to learn the number. The gap before the server takes it is
# not closable from here, and the kernel does not hand the same ephemeral port
# to a probe running alongside this one.
port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"

jq --arg url "http://127.0.0.1:$port" '.serverUrl = $url' \
  "$here/daemon-config.json" >"$work/daemon-config.json"

exec node "$here/../server.js" "$port"
