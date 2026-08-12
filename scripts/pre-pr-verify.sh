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

set -uEo pipefail

# Any unexpected exit is a refusal, not an allow. Without this, "fails closed"
# held only while the script ran to completion: a crash exits non-zero, which a
# PreToolUse hook treats as a *non-blocking* error, and the command proceeds.
# Cleared explicitly on every intended exit path.
UNEXPECTED='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refused: the pre-PR gate exited unexpectedly, so npm run verify did not complete. A bug in scripts/pre-pr-verify.sh rather than a problem with the diff."}}'

# **EXIT, not ERR, and this distinction is the whole backstop.** An `ERR` trap
# does not run for the error class `set -u` exists to produce: an unbound
# variable is a fatal that exits 1 with empty stdout, and a hook exiting
# non-zero is treated as a *non-blocking* error — so the command proceeds. Same
# for a `set -e` fatal inside a function without `set -E`.
#
# An EXIT trap runs for all of them. `decided` is what keeps it from printing a
# second document alongside a real answer, which was the round-2 fail-open:
# stdout carrying two JSON objects parses as neither, so the hook is ignored
# entirely and the PR is created unverified.
decided=0
finish() {
  [ "$decided" = 1 ] && return 0
  printf '%s\n' "$UNEXPECTED"
  # `exit 0` from inside the EXIT trap, because printing a refusal is not
  # enough: a `set -u` fatal exits 1, and a hook exiting non-zero is a
  # *non-blocking* error whose decision the runner ignores entirely. The
  # document has to be accompanied by a zero status or it is not a refusal.
  exit 0
}
trap finish EXIT

allow() {
  decided=1
  exit 0
}

# `deny <reason>` — refuse the tool call and say why.
deny() {
  # Captured before printing, not piped straight to stdout. A jq that writes
  # something *and then* fails — partial output, then exit 3 — otherwise put its
  # fragment on stdout ahead of the fallback, giving two documents and the same
  # fail-open this trap exists to prevent, through a different door.
  #
  # The reason is truncated because `--arg` dies with E2BIG on a very long
  # single line, and a refusal that cannot be formatted is worth less than a
  # slightly shortened one.
  local formatted
  if formatted=$(jq -n --arg reason "$(printf '%.8000s' "$1")" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }' 2>/dev/null); then
    printf '%s\n' "$formatted"
  else
    printf '%s\n' "$UNEXPECTED"
  fi
  decided=1
  exit 0
}

payload=$(cat)

# **Filter on the raw payload first, before jq is needed at all.** This hook is
# registered against `Bash`, so it sees every command in the project. With the
# jq guards ahead of the match, a machine without jq refused *every Bash call*
# — the repo became unusable rather than merely un-PR-able.
#
# Deliberately loose: any `gh` at all, so whitespace variants and `gh api`
# reach the precise check below. It is not a proof, only a cheap skip — a
# command JSON-escaped as `\u0067h` would slip past it, which `JSON.stringify`
# never emits but which nothing here enforces.
case "$payload" in
*gh*) ;;
*) allow ;;
esac

# jq is how the payload is read at all, so a missing jq cannot be allowed to
# mean "not a PR command". Written by hand rather than through `deny`, which
# needs the very tool that is missing.
if ! command -v jq >/dev/null 2>&1; then
  decided=1
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
# Whitespace is collapsed first, so `gh  pr   create` and tab-separated forms
# match too — measured as silent allows before this. And `gh api …/pulls` is
# matched because it is the obvious fallback the moment `gh pr create` is
# denied: refusing one route to opening a PR while leaving another open is not
# a gate.
normalised=$(printf '%s' "$command" | tr '\t\n' '  ' | tr -s ' ')
case "$normalised" in
*"gh pr create"*) ;;
*"gh api"*pulls*) ;;
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
# No fallback to this script's own directory. That fallback *was* the bug: in
# the real deployment the script lives in the main checkout, whose package name
# matches, so an unresolvable cwd quietly verified main and allowed the PR.
if [ -z "$repo_root" ]; then
  deny "Refused: the pre-PR gate could not find a package.json above \"$cwd\", so it does not know which tree to verify and will not guess. Run \`gh pr create\` from inside the repo."
fi

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
# Scoped to the tail rather than the whole transcript: `verify` runs vitest and
# eslint over this repo, and a test named for a network error — or a prettier
# diff quoting one — would otherwise misreport a real code failure as a
# connectivity problem. `npm audit` is the last step, so its output is the end.
if printf '%s' "$output" | tail -15 |
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
