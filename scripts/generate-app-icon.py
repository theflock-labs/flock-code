#!/usr/bin/env python3
"""Render the macOS/Windows app icon source from the in-app goose sprite.

    python3 scripts/generate-app-icon.py [variant]      # default: firstlight
    cd apps/flock-desktop && npx tauri icon src-tauri/icons/app-icon-source.png

The sprite grid and the palette are read out of `GooseMark.tsx` rather than
copied here. That component is what the app actually draws, so parsing it is
what stops the icon and the bird from drifting apart: the previous source PNG
was still the pre-rebrand "C" long after the app had been showing a goose,
because regenerating it meant re-deriving artwork nobody had a script for.

Geometry matches the icon this replaces, measured off the shipped 256px PNG:
a plate inset to 81.25% of the canvas, corner radius 21.6% of the plate, and
the goose's ink centred at 68.3% of the plate's width. macOS does not mask app
icons the way iOS does, so the rounded plate has to be drawn, not assumed.
"""

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
GOOSE_TSX = ROOT / "apps/flock-desktop/src/components/GooseMark.tsx"
OUT = ROOT / "apps/flock-desktop/src-tauri/icons/app-icon-source.png"

SIZE = 1024
PLATE_FRAC = 0.8125          # plate width / canvas
RADIUS_FRAC = 0.216          # corner radius / plate width
GOOSE_FRAC = 0.683           # goose ink width / plate width
# --bg-window in Nightfall, the same plate the app's own chrome sits on.
PLATE_BG = (7, 17, 34, 255)


def read_grid(src: str, name: str) -> list[str]:
    body = re.search(rf"const {name} = \[(.*?)\];", src, re.S)
    if not body:
        raise SystemExit(f"{name} not found in GooseMark.tsx")
    return re.findall(r'"([.A-Z]+)"', body.group(1))


def read_palette(src: str, variant: str) -> dict[str, str]:
    line = re.search(rf"\n\s*{variant}:\s*\{{(.*?)\}}", src, re.S)
    if not line:
        raise SystemExit(f"palette '{variant}' not found in GooseMark.tsx")
    return dict(re.findall(r'(\w+):\s*"(#[0-9a-fA-F]{6})"', line.group(1)))


def rgba(hex_color: str) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def main() -> None:
    variant = sys.argv[1] if len(sys.argv) > 1 else "firstlight"
    src = GOOSE_TSX.read_text()
    grid = read_grid(src, "UPSTROKE")
    pal = {k: rgba(v) for k, v in read_palette(src, variant).items()}
    # "K" is the eye: the sprite punches it through to the surface behind, which
    # here is the plate rather than the app's window background.
    pal["K"] = PLATE_BG

    # Ink bounds, not grid bounds. UPSTROKE leaves its last rows empty and its
    # first columns clear, so scaling by the full 36x16 would float the bird
    # high and left inside the plate.
    cells = [(x, y) for y, row in enumerate(grid)
             for x, c in enumerate(row) if c != "."]
    x0, x1 = min(c[0] for c in cells), max(c[0] for c in cells)
    y0, y1 = min(c[1] for c in cells), max(c[1] for c in cells)
    cols, rows = x1 - x0 + 1, y1 - y0 + 1

    plate = SIZE * PLATE_FRAC
    cell = round(plate * GOOSE_FRAC / cols)
    ox = round((SIZE - cols * cell) / 2) - x0 * cell
    oy = round((SIZE - rows * cell) / 2) - y0 * cell

    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    inset = (SIZE - plate) / 2
    d.rounded_rectangle(
        [inset, inset, SIZE - inset, SIZE - inset],
        radius=plate * RADIUS_FRAC,
        fill=PLATE_BG,
    )
    for y, row in enumerate(grid):
        for x, c in enumerate(row):
            if c == ".":
                continue
            px, py = ox + x * cell, oy + y * cell
            d.rectangle([px, py, px + cell - 1, py + cell - 1], fill=pal[c])

    OUT.write_bytes(b"")  # touch, so a failed write leaves nothing half-old
    img.save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)}  {SIZE}x{SIZE}  variant={variant}")
    print(f"  sprite ink {cols}x{rows} cells at {cell}px  ->  {cols * cell}px wide")
    print("  next: cd apps/flock-desktop && npx tauri icon src-tauri/icons/app-icon-source.png")


if __name__ == "__main__":
    main()
