#!/usr/bin/env bash
#
# PreToolUse hook: refuse `gh pr create` until `npm run verify` passes.
#
# Why this exists: PR #65 failed the `build / typecheck / lint` job twice on
# things a local run catches in seconds. Both times the author had run some
# checks by hand — vitest, tsc — and simply not thought of prettier. Choosing
# the checks by hand is the bug, so this removes the choice.
#
# Reads the hook payload on stdin, exits 0 (silently allowing the command) for
# anything that is not a PR creation. On failure it emits a PreToolUse deny so
# the model is told why rather than being left to guess.

set -uo pipefail

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

# Substring rather than a prefix test: `gh pr create` is reached through `&&`
# chains and subshells often enough that anchoring to the start would let the
# common case straight through.
case "$command" in
*"gh pr create"*) ;;
*) exit 0 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

output=$(cd "$repo_root" && npm run verify 2>&1)
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# Only the tail is worth returning — `verify` is six tools chained, and the
# failure is whichever one stopped it.
reason="Refused: \`npm run verify\` failed, so this PR was not opened. CI would
have failed it the same way. Fix the failure below, re-run \`npm run verify\`,
then create the PR again.

$(printf '%s' "$output" | tail -40)"

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
