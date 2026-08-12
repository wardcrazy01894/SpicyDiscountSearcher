#!/usr/bin/env bash
#
# Regenerate the extension icon PNGs from the SVG sources in `assets/icons/`.
#
# Chrome will not take an SVG in `manifest.json`, so the PNGs are committed —
# but they are *generated*, and this is the only thing that writes them. Edit
# `assets/icons/icon.svg` (128/48) or `icon-small.svg` (32/16) and re-run.
#
# The sources live outside `public/` on purpose: vite copies `public/` verbatim
# into `dist/`, so keeping them there shipped the artwork and its licensing
# comment inside the packaged extension, where Chrome never reads them.
#
# macOS only, and deliberately not wired into `npm run build` or `verify`: it
# leans on `qlmanage` and `sips`, which ship with the OS, so the repo needs no
# image toolchain. CI never runs it and there is therefore **no freshness gate**
# on these PNGs — see the note in CLAUDE.md.
#
# Rendered large and downsampled rather than rasterised straight to 16px:
# qlmanage's own tiny thumbnails lose the stem entirely.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/assets/icons"
out="$root/public/icons"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Preflight, because every one of these fails silently otherwise. A missing
# qlmanage exits 127 printing nothing (its own errors go to the /dev/null
# below), and — worse — `qlmanage -t` on a file that does not exist never
# returns at all, so a renamed source hangs the script with no output rather
# than failing.
for tool in qlmanage sips; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "make-icons: needs macOS \`$tool\`; this script does not run on other platforms" >&2
    exit 1
  fi
done
for source in icon.svg icon-small.svg; do
  if [ ! -r "$src/$source" ]; then
    echo "make-icons: cannot read $src/$source" >&2
    exit 1
  fi
done

# Rasterise each source once, at 512, and downsample from that.
for source in icon.svg icon-small.svg; do
  # Well-formedness is checked *before* rendering, and checking the output
  # instead does not work: qlmanage exits 0 on a malformed SVG and writes a
  # perfectly valid, non-empty PNG **of WebKit's XML parse-error page** — "This
  # page contains the following errors". A file-exists or file-size test passes
  # happily and the error page ships as the icon, because CI never regenerates
  # these. Measured, not imagined: an earlier version of this script did exactly
  # that.
  if ! python3 -c 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' \
    "$src/$source" 2>/dev/null; then
    echo "make-icons: $source is not well-formed XML; refusing to render it" >&2
    exit 1
  fi

  rm -f "$work/$source.png"
  qlmanage -t -s 512 -o "$work" "$src/$source" >/dev/null 2>&1 || true
  if [ ! -s "$work/$source.png" ]; then
    echo "make-icons: qlmanage produced nothing for $source" >&2
    exit 1
  fi
done

emit() {
  local source="$1" size="$2" name="$3"
  sips -z "$size" "$size" "$work/$source.png" --out "$out/$name" >/dev/null
}

emit icon.svg 128 icon128.png
emit icon.svg 48 icon48.png
emit icon-small.svg 32 icon32.png
emit icon-small.svg 16 icon16.png

echo "wrote icon16 icon32 icon48 icon128 to public/icons"
