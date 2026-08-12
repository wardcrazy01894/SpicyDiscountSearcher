#!/usr/bin/env python3
"""Round an icon's corners, restoring the alpha `qlmanage` flattens away.

QuickLook rasterises onto an opaque white ground, so an `rx` in the source SVG
does not round the tile — it leaves four opaque *white* corners around the
artwork, which on a dark toolbar reads as a white square with something
floating inside it. The icons on `main` had genuine alpha, so losing it was a
regression rather than a cosmetic difference.

The first attempt at this PR gave up and shipped a full-bleed square, on the
grounds that keeping transparency needed a rasteriser that preserves it. That
was wrong: the render is already in hand as a PNG, `make-icons.sh` already
depends on python3 to validate the sources, and masking a rounded rectangle
into the alpha channel needs nothing but `zlib` and `struct`.

Reads and writes 8-bit non-interlaced RGBA PNGs, which is what `sips` emits.
Anything else is refused rather than silently mangled.
"""

from __future__ import annotations

import struct
import sys
import zlib

# 28/128 of the tile, the radius the source SVGs used before it was removed.
RADIUS_RATIO = 28 / 128


def _chunks(data: bytes):
    pos = 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        yield kind, data[pos + 8 : pos + 8 + length]
        pos += 12 + length


def _unfilter(raw: bytes, width: int, height: int) -> bytearray:
    """Undo the per-scanline filters. Bytes-per-pixel is 4 (RGBA)."""
    bpp, stride = 4, width * 4
    out, prev, i = bytearray(), bytearray(stride), 0
    for _ in range(height):
        kind = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        for x in range(stride):
            left = line[x - bpp] if x >= bpp else 0
            up = prev[x]
            upleft = prev[x - bpp] if x >= bpp else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                pred = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                line[x] = (line[x] + pred) & 0xFF
            elif kind != 0:
                raise SystemExit(f"unsupported PNG filter {kind}")
        out += line
        prev = line
    return out


def _coverage(px: float, py: float, size: int, radius: float) -> float:
    """How much of the pixel is inside the rounded rectangle, 0..1.

    Sampled 4x4 rather than tested at the centre: a hard in/out test leaves the
    curve visibly stepped at 16px, which is the size that matters most.
    """
    inside = 0
    for sy in range(4):
        for sx in range(4):
            x, y = px + (sx + 0.5) / 4, py + (sy + 0.5) / 4
            cx = radius if x < radius else (size - radius if x > size - radius else x)
            cy = radius if y < radius else (size - radius if y > size - radius else y)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius**2:
                inside += 1
    return inside / 16


def round_corners(path: str) -> None:
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")

    idat = b""
    width = height = 0
    for kind, payload in _chunks(data):
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", payload)
            if (depth, colour, interlace) != (8, 6, 0):
                raise SystemExit(f"{path}: expected 8-bit RGBA non-interlaced")
        elif kind == b"IDAT":
            idat += payload

    if width != height:
        raise SystemExit(f"{path}: expected a square icon, got {width}x{height}")

    pixels = _unfilter(zlib.decompress(idat), width, height)
    radius = width * RADIUS_RATIO

    for y in range(height):
        for x in range(width):
            cover = _coverage(x, y, width, radius)
            if cover < 1.0:
                i = (y * width + x) * 4 + 3
                pixels[i] = round(pixels[i] * cover)

    # Re-encode with filter 0 on every scanline: these are tiny, and the point
    # is a file that is obviously correct rather than one that is small.
    raw = b"".join(
        b"\x00" + bytes(pixels[y * width * 4 : (y + 1) * width * 4]) for y in range(height)
    )

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    out = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    open(path, "wb").write(out)


if __name__ == "__main__":
    for target in sys.argv[1:]:
        round_corners(target)
