"""Draw the home-screen icons.

iOS will not use an SVG for the home screen, so the same mark is drawn again
as PNG at the sizes Safari and Android ask for. Drawn rather than converted so
the repo needs no SVG rasteriser to rebuild it.

    python tools/make_icons.py
"""
import functools
import os

print = functools.partial(print, flush=True)

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")

GROUND = "#05070C"
ACCENT = "#35E0F0"
LOSS = "#C4485A"
WIN = "#2BE08A"
SIZES = [180, 192, 512]
SS = 4          # supersample, then shrink, because these have thin strokes


def draw(size):
    n = size * SS
    im = Image.new("RGB", (n, n), GROUND)
    d = ImageDraw.Draw(im)
    u = n / 512.0                     # the SVG was drawn on a 512 grid
    w = max(1, round(14 * u))

    # HUD corner brackets, the same frame the diary draws round every card
    for (x, y, dx, dy) in ((56, 128, 0, -72), (456, 128, 0, -72),
                           (56, 384, 0, 72), (456, 384, 0, 72)):
        d.line([(x * u, y * u), (x * u, (y + dy) * u)], fill=ACCENT, width=w)
    for (x, y, dx) in ((56, 56, 72), (456, 56, -72), (56, 456, 72), (456, 456, -72)):
        d.line([(x * u, y * u), ((x + dx) * u, y * u)], fill=ACCENT, width=w)

    # one losing candle, one winning candle
    for (cx, top, bot, bodyt, bodyb, col) in (
            (196, 146, 366, 196, 326, LOSS),
            (316, 146, 366, 186, 316, WIN)):
        d.line([(cx * u, top * u), (cx * u, bot * u)], fill=col,
               width=max(1, round(12 * u)))
        d.rectangle([(cx - 30) * u, bodyt * u, (cx + 30) * u, bodyb * u], fill=col)

    return im.resize((size, size), Image.LANCZOS)


for s in SIZES:
    out = os.path.join(DOCS, f"icon-{s}.png")
    draw(s).save(out, optimize=True)
    print(f"  icon-{s}.png  {os.path.getsize(out):,} bytes")
