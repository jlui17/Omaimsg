#!/usr/bin/env bash
# SessionStart. A worktree arrives with no node_modules whoever made it (a
# t3code thread, EnterWorktree, wtnew), and the daemon and both test servers
# need them, so say so before the agent runs a command that fails for it.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

gitdir="$(git rev-parse --absolute-git-dir)"
common="$(cd "$root" && realpath "$(git rev-parse --git-common-dir)")"
[ "$gitdir" != "$common" ] || exit 0

if [ -d "$root/node_modules" ] && [ ! "$root/bun.lock" -nt "$root/node_modules" ]; then
  exit 0
fi

# A worktree whose own mise.toml predates the task would resolve `mise run
# setup` against the main checkout's config and install there instead.
cmd="mise run setup"
grep -q '^\[tasks.setup\]' "$root/mise.toml" 2>/dev/null || cmd="bun install"

echo "This worktree has no usable dependencies yet. Run \`$cmd\` before any test or harness command; without it \`mise run test\` and the quickshell harness both fail."
