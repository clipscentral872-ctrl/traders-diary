"""Draw the home-screen icons.

iOS will not use an SVG for the home screen, so the same mark is drawn again
as PNG at the sizes Safari and Android ask for. Drawn rather than converted so
the repo needs no SVG rasteriser to rebuild it.

Kept deliberately in step with docs/icon.svg: same grid, same geometry, same
colours. If one changes, change the other.

    python tools/make_icons.py
"""
import functools
import os

print = functools.partial(print, flush=True)

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")

GROUND = (5, 7, 12)
ACCENT = (53, 224, 240)
COL_TOP = (46, 127, 168)
COL_BOT = (20, 52, 74)
COL_EDGE = (79, 168, 216)
LINE_LO = (34, 184, 119)
LINE_HI = (91, 255, 176)
GLOW = (43, 224, 138)
SIZES = [180, 192, 512]
SS = 4          # supersample, then shrink, because these have thin strokes

# The mark, on the 512 grid the SVG is drawn on.
COLUMNS = [(128, 278), (222, 212), (316, 126)]
COL_W, BASE = 72, 418
GRID_Y = (330, 242, 154)
ZIG = [(108, 376), (196, 300), (262, 338), (352, 196)]
HEAD = [(300, 172), (388, 156), (372, 244)]
AREA = [(108, 376), (196, 300), (262, 338), (356, 190), (356, 418), (108, 418)]


def ramp(n, stops):
    """A one pixel wide vertical ramp, stretched to n wide, used as a paint.

    stops is a list of (position 0..1, value), where value is a colour tuple
    for a paint or a single number for a mask.
    """
    single = not isinstance(stops[0][1], tuple)
    strip = Image.new("L" if single else "RGB", (1, n))
    px = strip.load()
    for y in range(n):
        t = y / max(1, n - 1)
        lo = stops[0]
        hi = stops[-1]
        for a, b in zip(stops, stops[1:]):
            if a[0] <= t <= b[0]:
                lo, hi = a, b
                break
        span = max(1e-6, hi[0] - lo[0])
        f = min(1.0, max(0.0, (t - lo[0]) / span))
        if single:
            px[0, y] = round(lo[1] + (hi[1] - lo[1]) * f)
        else:
            px[0, y] = tuple(round(lo[1][k] + (hi[1][k] - lo[1][k]) * f)
                             for k in range(3))
    return strip.resize((n, n), Image.BILINEAR)


def draw(size):
    n = size * SS
    u = n / 512.0
    im = Image.new("RGB", (n, n), GROUND)

    # A halo where the move ends, so the corner it climbs into is not dead
    # space. Concentric rings rather than one blurred blob: a blob has a hard
    # edge that survives the blur and reads as a stain across the corner.
    halo = Image.new("L", (n, n), 0)
    hd = ImageDraw.Draw(halo)
    cx, cy, r = 0.72 * n, 0.30 * n, 0.62 * n
    for i in range(48, 0, -1):
        t = i / 48.0
        hd.ellipse([cx - r * t, cy - r * t, cx + r * t, cy + r * t],
                   fill=round(66 * (1 - t) ** 1.6))
    halo = halo.filter(ImageFilter.GaussianBlur(0.03 * n))
    im.paste(Image.new("RGB", (n, n), GLOW), (0, 0), halo)

    d = ImageDraw.Draw(im)

    # Gridlines, faint, the way a chart shows its scale.
    faint = tuple(round(GROUND[k] + (ACCENT[k] - GROUND[k]) * 0.18)
                  for k in range(3))
    for y in GRID_Y:
        d.line([(92 * u, y * u), (440 * u, y * u)], fill=faint,
               width=max(1, round(5 * u)))

    # Columns, lifting from bright at the top to deep at the base, so they
    # read as solid objects standing on the axis rather than flat blocks.
    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    for x, top in COLUMNS:
        md.rounded_rectangle([x * u, top * u, (x + COL_W) * u, BASE * u],
                             radius=8 * u, fill=255)
    im.paste(ramp(n, [(0.0, COL_TOP), (1.0, COL_BOT)]), (0, 0), mask)
    for x, top in COLUMNS:
        d.rounded_rectangle([x * u, top * u, (x + COL_W) * u, (top + 6) * u],
                            radius=3 * u, fill=COL_EDGE)

    # The area under the move, fading out downward the way a chart's area
    # series does. This is the thing that makes it read as a chart.
    area = Image.new("L", (n, n), 0)
    ImageDraw.Draw(area).polygon([(x * u, y * u) for x, y in AREA], fill=255)
    fade = ramp(n, [(0.0, 118), (150 / 512.0, 118), (BASE / 512.0, 0),
                    (1.0, 0)])
    area = Image.composite(fade, Image.new("L", (n, n), 0), area)
    im.paste(Image.new("RGB", (n, n), GLOW), (0, 0), area)

    # The move, drawn once into a mask so it can be blurred into a glow and
    # then laid over itself sharp.
    move = Image.new("L", (n, n), 0)
    mv = ImageDraw.Draw(move)
    mv.line([(x * u, y * u) for x, y in ZIG], fill=255,
            width=max(1, round(26 * u)), joint="curve")
    mv.polygon([(x * u, y * u) for x, y in HEAD], fill=255)
    paint = ramp(n, [(0.0, LINE_HI), (1.0, LINE_LO)])
    im.paste(paint, (0, 0),
             move.filter(ImageFilter.GaussianBlur(0.028 * n))
                 .point(lambda v: round(v * 0.6)))
    im.paste(paint, (0, 0), move)

    # The axes last, so they sit cleanly over everything.
    ax = max(1, round(15 * u))
    d.line([(92 * u, 76 * u), (92 * u, BASE * u)], fill=ACCENT, width=ax)
    d.line([(92 * u, BASE * u), (440 * u, BASE * u)], fill=ACCENT, width=ax)

    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for s in SIZES:
        out = os.path.join(DOCS, f"icon-{s}.png")
        draw(s).save(out, optimize=True)
        print(f"  icon-{s}.png  {os.path.getsize(out):,} bytes")
