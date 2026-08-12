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
# **It prefers false positives to false negatives, deliberately** — see the
# matching note below. A wasted build is an annoyance; an unverified PR is the
# thing this exists to stop.

set -uo pipefail

# Any unexpected exit is a refusal, not an allow. Without this, "fails closed"
# held only while the script ran to completion: a crash exits non-zero, which a
# PreToolUse hook treats as a *non-blocking* error, and the command proceeds.
# Cleared explicitly on every intended exit path.
trap 'printf "%s\n" "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Refused: the pre-PR gate exited unexpectedly, so npm run verify did not complete. A bug in scripts/pre-pr-verify.sh rather than a problem with the diff.\"}}"' ERR

allow() {
  trap - ERR
  exit 0
}

# `deny <reason>` — refuse the tool call and say why.
deny() {
  trap - ERR
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

payload=$(cat)

# jq is how the payload is read at all, so a missing jq cannot be allowed to
# mean "not a PR command". Written by hand rather than through `deny`, which
# needs the very tool that is missing.
if ! command -v jq >/dev/null 2>&1; then
  trap - ERR
  echo 'pre-pr-verify: jq not found on PATH; cannot read the hook payload' >&2
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refused: this repo'"'"'s pre-PR gate needs `jq` to read the hook payload and it is not on PATH, so `npm run verify` never ran. Install it (`brew install jq`) and retry. An environment problem, not a failing check."}}'
  exit 0
fi

# A payload jq cannot parse is not "not a PR command" either. Checked, because
# the fail-open this gate exists to close came back exactly here: jq present,
# JSON malformed, `command` empty, no match, silent allow.
if ! command=$(printf '%s' "$payload" | jq -er '.tool_input.command // ""' 2>/dev/null); then
  deny "Refused: the pre-PR gate could not parse the hook payload, so \`npm run verify\` never ran. A bug in the hook rather than a problem with the diff."
fi

# **Substring, on purpose.** A previous version anchored this to a command
# position so that `grep -rn "gh pr create"` would not trigger a build. It did
# fix that, and it also silently stopped matching real commands:
#
#   gh pr create; echo done     the trailing `;` defeated the tail anchor
#   (gh pr create)              so did `)`
#   git push⏎gh pr create       a newline, which `^` does not match in ERE
#
# The last is the shape this repo's own `pr` skill documents. No regex
# separates "runs the command" from "mentions the phrase" in a raw string, so
# the only choice is which way to be wrong: a build that need not have run, or
# a PR that was never verified. The build is much the cheaper mistake.
case "$command" in
*"gh pr create"*) ;;
*) allow ;;
esac

# The tree the command is actually being run in, not the one this script lives
# in. Agents run in git worktrees here — `.gitignore` carries
# `.claude/worktrees/` — and deriving the root from BASH_SOURCE verified the
# *main* checkout instead: a clean main passes, the gate allows, and the
# worktree's broken branch ships.
#
# Walks up rather than testing `cwd` alone. A cwd of `<worktree>/src` is
# ordinary and holds no package.json, and a single `-f` test fell straight back
# to the main checkout — reintroducing the bug it was added to fix.
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null || echo "")
repo_root=""
probe="$cwd"
while [ -n "$probe" ] && [ "$probe" != "/" ] && [ "$probe" != "." ]; do
  if [ -f "$probe/package.json" ]; then
    repo_root="$probe"
    break
  fi
  probe=$(dirname "$probe")
done
[ -n "$repo_root" ] || repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Whatever we landed on has to be *this* project. `repo_root` comes from the
# payload and we are about to run its npm scripts, so without this the gate is
# satisfied by any directory holding a package.json with a `verify` script —
# including one that only echoes success.
name=$(jq -r '.name // ""' "$repo_root/package.json" 2>/dev/null || echo "")
if [ "$name" != "spicy-discount-searcher" ]; then
  deny "Refused: the pre-PR gate resolved \"$repo_root\", which is not the spicy-discount-searcher checkout, so it will not run npm scripts there. Run \`gh pr create\` from inside the repo."
fi

if ! command -v npm >/dev/null 2>&1; then
  deny "Refused: \`npm\` is not on PATH for this hook, so \`npm run verify\` could not run and this PR was not opened. An environment problem, not a test failure — nothing in the diff needs fixing."
fi

output=$(cd "$repo_root" && npm run verify 2>&1)
status=$?

if [ "$status" -eq 0 ]; then
  allow
fi

# 127 is "could not run" rather than "ran and failed", and the two want opposite
# responses: one means fix the environment, the other means fix the code.
if [ "$status" -eq 127 ]; then
  deny "Refused: \`npm run verify\` could not run in $repo_root (exit 127 — a command it calls was not found), so this PR was not opened. An environment problem rather than a failing check.

$(printf '%s' "$output" | tail -20)"
fi

# `npm audit` is the one step in `verify` that talks to the network, and it
# exits 1 on an unreachable registry exactly as it does on a real advisory.
# Told apart so the model is not sent hunting a code defect that does not
# exist. Needing the network at all costs nothing here: `gh pr create` posts to
# GitHub, so the command being gated could not have run offline either.
if printf '%s' "$output" |
  grep -qiE 'audit endpoint returned an error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network error'; then
  deny "Refused: \`npm run verify\` failed in $repo_root, and it looks like the network rather than the diff — \`npm audit\` could not reach the registry. Check connectivity and retry.

$(printf '%s' "$output" | tail -20)"
fi

# Only the tail is worth returning — `verify` is a chain of tools, and the
# failure is whichever one stopped it.
deny "Refused: \`npm run verify\` failed in $repo_root, so this PR was not opened. CI would
have failed it the same way. Fix the failure below, re-run \`npm run verify\`,
then create the PR again.

$(printf '%s' "$output" | tail -40)"
