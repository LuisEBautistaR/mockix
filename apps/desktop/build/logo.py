"""
Draws the Mockix logo: a stack of two server slabs (mocks) on a dark stone
tile, in the three stones of the family; the lower one is running (green
light). Writes build/icon.png (1024 px), build/icon.ico (16-256 px) and
docs/logo.svg at the repository root.

Run: python -I apps/desktop/build/logo.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent
ROOT = BUILD.parent.parent.parent
S = 1024
TILE = "#333231"
SLABS = [("#c3b8aa", "#6f675f"), ("#e4e1dd", "#a99d8e")]  # fill, vents
LIGHTS = ["#6f675f", "#9db091"]  # stopped, running

# Geometry on a 1024 grid (shared by the PNG and the SVG).
RADIUS = 228
X0, X1 = 184, 840
SLAB_H, SLAB_R = 196, 44
SLAB_Y = [292, 536]
VENTS = [(262, 52), (342, 52), (422, 52)]  # x, width of each vent
VENT_H = 22
LIGHT_X, LIGHT_R = 742, 40


def draw(size: int) -> Image.Image:
    k = 4  # supersample, then shrink for smooth edges
    big = S * k
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=RADIUS * k, fill=TILE)
    for (fill, vent), light, y in zip(SLABS, LIGHTS, SLAB_Y):
        d.rounded_rectangle([X0 * k, y * k, X1 * k, (y + SLAB_H) * k], radius=SLAB_R * k, fill=fill)
        cy = y + SLAB_H / 2
        for x, w in VENTS:
            d.rounded_rectangle([x * k, (cy - VENT_H / 2) * k, (x + w) * k, (cy + VENT_H / 2) * k], radius=VENT_H / 2 * k, fill=vent)
        d.ellipse([(LIGHT_X - LIGHT_R) * k, (cy - LIGHT_R) * k, (LIGHT_X + LIGHT_R) * k, (cy + LIGHT_R) * k], fill=light)
    return img.resize((size, size), Image.LANCZOS)


def svg() -> str:
    parts = [f'<rect width="{S}" height="{S}" rx="{RADIUS}" fill="{TILE}"/>']
    for (fill, vent), light, y in zip(SLABS, LIGHTS, SLAB_Y):
        cy = y + SLAB_H / 2
        parts.append(f'<rect x="{X0}" y="{y}" width="{X1 - X0}" height="{SLAB_H}" rx="{SLAB_R}" fill="{fill}"/>')
        for x, w in VENTS:
            parts.append(f'<rect x="{x}" y="{cy - VENT_H / 2:g}" width="{w}" height="{VENT_H}" rx="{VENT_H / 2:g}" fill="{vent}"/>')
        parts.append(f'<circle cx="{LIGHT_X}" cy="{cy:g}" r="{LIGHT_R}" fill="{light}"/>')
    body = "".join(parts)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" role="img" aria-label="Mockix">{body}</svg>\n'


if __name__ == "__main__":
    full = draw(1024)
    full.save(BUILD / "icon.png")
    full.save(BUILD / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "logo.svg").write_text(svg(), encoding="utf-8")
    print("icon.png, icon.ico y docs/logo.svg escritos")
