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
WIN = "#22B877"
ARROW = "#2BE08A"
SIZES = [180, 192, 512]
SS = 4          # supersample, then shrink, because these have thin strokes


def draw(size):
    n = size * SS
    im = Image.new("RGB", (n, n), GROUND)
    d = ImageDraw.Draw(im)
    u = n / 512.0                     # the SVG was drawn on a 512 grid
    w = max(1, round(14 * u))

    # HUD corner brackets, the same frame the app draws round every card
    for (x, y, dy) in ((52, 124, -72), (460, 124, -72),
                       (52, 388, 72), (460, 388, 72)):
        d.line([(x * u, y * u), (x * u, (y + dy) * u)], fill=ACCENT, width=w)
    for (x, y, dx) in ((52, 52, 72), (460, 52, -72),
                       (52, 460, 72), (460, 460, -72)):
        d.line([(x * u, y * u), ((x + dx) * u, y * u)], fill=ACCENT, width=w)

    # Candles behind, dimmed: the ground the move happens on, not the subject.
    def blend(c, a):
        g = tuple(int(GROUND[i:i + 2], 16) for i in (1, 3, 5))
        f = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
        return tuple(round(g[k] + (f[k] - g[k]) * a) for k in range(3))

    for (cx, top, bot, bt, bb, col) in (
            (140, 286, 376, 304, 360, LOSS),
            (205, 252, 352, 272, 334, WIN),
            (270, 272, 360, 288, 342, LOSS),
            (335, 180, 300, 198, 278, WIN)):
        c = blend(col, 0.5)
        d.line([(cx * u, top * u), (cx * u, bot * u)], fill=c,
               width=max(1, round(10 * u)))
        d.rectangle([(cx - 16) * u, bt * u, (cx + 16) * u, bb * u], fill=c)

    # The zigzag through them: higher lows and a higher high, which is the
    # shape the whole app is about.
    zig = [(118, 366), (188, 300), (262, 336), (344, 208), (400, 158)]
    d.line([(x * u, y * u) for x, y in zig], fill=ARROW,
           width=max(1, round(22 * u)), joint="curve")
    # and the arrowhead, pointing the way it went
    head = [(340, 152), (406, 152), (406, 218)]
    d.line([(x * u, y * u) for x, y in head], fill=ARROW,
           width=max(1, round(22 * u)), joint="curve")

    return im.resize((size, size), Image.LANCZOS)


for s in SIZES:
    out = os.path.join(DOCS, f"icon-{s}.png")
    draw(s).save(out, optimize=True)
    print(f"  icon-{s}.png  {os.path.getsize(out):,} bytes")
