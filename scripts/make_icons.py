#!/usr/bin/env python3
"""Generate the extension's PNG icons: a spicy-red rounded square with a %.

Kept as a script rather than checked-in binaries alone so the icon can be
tweaked without a design tool. Writes public/icons/icon{16,32,48,128}.png.

Run:  python3 scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "icons"
SIZES = (16, 32, 48, 128)

TOP = (232, 83, 43)  # --spice
BOTTOM = (150, 45, 20)
MARK = (255, 244, 240)


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def inside_rounded_square(x: float, y: float, size: int, radius: float) -> bool:
    """Distance test against a square with rounded corners, in pixel space."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def render(size: int) -> bytes:
    radius = size * 0.22
    # Supersample so small icons don't come out with jagged curves.
    ss = 3
    rows = bytearray()

    for py in range(size):
        rows.append(0)  # PNG filter type 0 for this scanline
        for px in range(size):
            r_acc = g_acc = b_acc = a_acc = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = px + (sx + 0.5) / ss
                    y = py + (sy + 0.5) / ss
                    if not inside_rounded_square(x, y, size, radius):
                        continue

                    t = y / size
                    r, g, b = (
                        lerp(TOP[0], BOTTOM[0], t),
                        lerp(TOP[1], BOTTOM[1], t),
                        lerp(TOP[2], BOTTOM[2], t),
                    )

                    nx, ny = x / size, y / size
                    on_slash = abs(nx + ny - 1.0) < 0.085
                    dot_r = 0.135
                    in_dot = (nx - 0.30) ** 2 + (ny - 0.30) ** 2 < dot_r**2 or (nx - 0.70) ** 2 + (
                        ny - 0.70
                    ) ** 2 < dot_r**2
                    if on_slash or in_dot:
                        r, g, b = MARK

                    r_acc += r
                    g_acc += g
                    b_acc += b
                    a_acc += 255

            samples = ss * ss
            alpha = a_acc // samples
            if alpha == 0:
                rows.extend((0, 0, 0, 0))
            else:
                # Un-weight the colour by coverage so edge pixels stay saturated.
                covered = max(1, a_acc // 255)
                rows.extend((r_acc // covered, g_acc // covered, b_acc // covered, alpha))

    return bytes(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def write_png(path: Path, size: int, raw: bytes) -> None:
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
