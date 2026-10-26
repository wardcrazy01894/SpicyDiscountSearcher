#!/usr/bin/env sh
#
# `npm run prepare`: point git at the versioned hooks in .githooks/.
#
# Refuses to clobber a hooks path somebody set deliberately — a global
# core.hooksPath carrying a signing or commit-msg hook is exactly the kind of
# thing `npm install` must not silently replace. Says so instead, so the
# pre-push gate's absence is a printed fact rather than a silent one. A tree
# that is not a git checkout (an npm tarball) is left alone without a word.

set -eu

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

current=$(git config --get core.hooksPath 2>/dev/null || true)
case "$current" in
'' | .githooks)
  git config core.hooksPath .githooks
  ;;
*)
  echo "install-hooks: core.hooksPath is already '$current'; leaving it. The repo's pre-push gate in .githooks/ is NOT active — see CLAUDE.md." >&2
  ;;
esac
