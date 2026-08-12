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
#
# **Fails closed.** Every way this can go wrong short of "verify passed" denies
# the command, because a gate that fails open is worse than no gate: it reports
# nothing and lets the thing it exists to stop straight through.

set -uo pipefail

# `deny <reason>` — refuse the tool call and say why.
deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }' 2>/dev/null || printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pre-pr-verify failed and could not format its reason"}}\n'
  exit 0
}

payload=$(cat)

# jq is how the payload is read at all, so a missing jq cannot be allowed to
# mean "not a PR command". Without this the whole gate degrades to silence: an
# empty `command`, the case falls through, every PR is allowed with no output.
# The one failure mode that must not be quiet was the quiet one.
if ! command -v jq >/dev/null 2>&1; then
  # Written by hand rather than through `deny`, which needs the very tool that
  # is missing. Routed through it, this case denied with "could not format its
  # reason" — fail-closed, but silent about the one thing that would fix it.
  echo 'pre-pr-verify: jq not found on PATH; cannot read the hook payload' >&2
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refused: this repo'"'"'s pre-PR gate needs `jq` to read the hook payload and it is not on PATH, so `npm run verify` never ran. Install it (`brew install jq`) and retry. This is an environment problem, not a failing check."}}'
  exit 0
fi

command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

# Matched as a *command*, not as a substring. `gh pr create` appears in prose —
# in CLAUDE.md, in this file's own header — so a raw substring test refused
# `grep -rn "gh pr create"` and ran a full build to do it. A read-only grep
# denied with "so this PR was not opened" is a nonsense diagnosis.
#
# Anchored to a command position (start of line, or after ; & | && || or an
# opening paren) and tolerant of extra whitespace between the words.
if [[ ! $command =~ (^|[;\&\|\(])[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]]; then
  exit 0
fi

# The tree the command is actually being run in, not the one this script lives
# in. Agents run in git worktrees here — `.gitignore` carries `.claude/worktrees/`
# — and deriving the root from BASH_SOURCE verified the *main* checkout instead:
# a clean main passes, the gate allows, and the worktree's broken branch ships.
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')
if [ -n "$cwd" ] && [ -f "$cwd/package.json" ]; then
  repo_root="$cwd"
else
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

if ! (cd "$repo_root" && command -v npm >/dev/null 2>&1); then
  deny "Refused: \`npm\` is not on PATH for this hook, so \`npm run verify\` could not run and this PR was not opened. This is an environment problem, not a test failure — nothing in the diff needs fixing."
fi

output=$(cd "$repo_root" && npm run verify 2>&1)
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# 127 is "could not run" rather than "ran and failed", and the two want opposite
# responses: one means fix the environment, the other means fix the code. Told
# apart here so the model is not sent hunting for a test failure that does not
# exist.
if [ "$status" -eq 127 ]; then
  deny "Refused: \`npm run verify\` could not run in $repo_root (exit 127 — a command it calls was not found), so this PR was not opened. An environment problem rather than a failing check.

$(printf '%s' "$output" | tail -20)"
fi

# Only the tail is worth returning — `verify` is a chain of tools, and the
# failure is whichever one stopped it.
deny "Refused: \`npm run verify\` failed in $repo_root, so this PR was not opened. CI would
have failed it the same way. Fix the failure below, re-run \`npm run verify\`,
then create the PR again.

$(printf '%s' "$output" | tail -40)"
