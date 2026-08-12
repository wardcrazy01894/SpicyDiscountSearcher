#!/usr/bin/env bash
#
# Regenerate the extension icon PNGs from the SVG sources beside them.
#
# Chrome will not take an SVG in `manifest.json`, so the PNGs are committed —
# but they are *generated*, and this is the only thing that should write them.
# Edit `public/icons/icon.svg` (128/48) or `icon-small.svg` (32/16) and re-run.
#
# macOS only, and deliberately not wired into `npm run build` or `verify` for
# that reason: it leans on `qlmanage` and `sips`, which ship with the OS, so the
# repo needs no image toolchain. CI never runs it — it checks the committed PNGs
# like any other asset.
#
# Rendered large and downsampled rather than rasterised straight to 16px:
# qlmanage's own tiny thumbnails lose the stem entirely.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icons="$root/public/icons"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

render() {
  local source="$1" size="$2" out="$3"
  qlmanage -t -s 512 -o "$work" "$icons/$source" >/dev/null 2>&1
  sips -z "$size" "$size" "$work/$source.png" --out "$icons/$out" >/dev/null
}

render icon.svg 128 icon128.png
render icon.svg 48 icon48.png
render icon-small.svg 32 icon32.png
render icon-small.svg 16 icon16.png

echo "wrote icon16 icon32 icon48 icon128 to public/icons"
