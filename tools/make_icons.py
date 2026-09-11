"""Draw the app's logo: the SVG, and every PNG the platforms ask for.

The app is white with blue and black candles, the way TradingView draws a
chart, and the logo is three of those candles climbing on a white tile. The
logo before this was a dark neon chart from before the redesign, and it was
the one thing on the laptop's taskbar that still looked like the old app.

One set of numbers draws both the SVG and the PNGs, so the two cannot drift
apart the way hand-kept copies do.

The PNGs are drawn with Pillow rather than converted from the SVG, so
rebuilding needs no SVG rasteriser.

    python tools/make_icons.py
"""
import functools
import os

print = functools.partial(print, flush=True)

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")

# The app's own colours, from the stylesheet: --ground, --candle-up and
# --candle-dn. The edge is a hairline so a white tile still has an outline on
# a light taskbar, where white on beige is otherwise nearly invisible.
WHITE = (255, 255, 255)
EDGE = (220, 224, 232)
BLUE = (41, 98, 255)
BLACK = (19, 23, 34)

SS = 4            # supersample, then shrink, because the wicks are thin
RADIUS = 112      # the tile's corner, about a fifth of it, like other app icons
EDGE_W = 8
BODY_W = 72
WICK_W = 16
BODY_R = 6

# Three candles on the 512 grid, climbing left to right: a black one, then
# two blue. Each is (left edge of the body, wick top, body top, body bottom,
# wick bottom, colour). The group is centred on the tile. At this size it fits
# inside the middle 80% circle Android keeps when it crops a maskable icon;
# the other outputs draw it larger, below.
CANDLES = [
    (112, 244, 280, 360, 392, BLACK),
    (220, 184, 218, 326, 352, BLUE),
    (328, 120, 150, 276, 310, BLUE),
]

# (file, size, full bleed). The tab and desktop sizes are a rounded tile with
# clear corners. The iPhone's home screen icon is a full square with no
# transparency, because iOS rounds it itself and paints clear corners black.
# The maskable one is full bleed too, because Android cuts its own shape.
#
# The last number scales the candles about the centre. At 1.0 they filled
# only half the tile and were tiny at 32 pixels beside the old icon, which
# filled its whole square, so the tile, the desktop sizes and the iPhone draw
# them a quarter larger. The maskable one keeps 1.0: Android may crop it to a
# circle, and at the larger size the tip of the right candle would be cut off.
BIG = 1.25
OUTPUTS = [
    ("logo-32.png", 32, False, BIG),
    ("logo-48.png", 48, False, BIG),
    ("logo-180.png", 180, True, BIG),
    ("logo-192.png", 192, False, BIG),
    ("logo-512.png", 512, False, BIG),
    ("logo-maskable-512.png", 512, True, 1.0),
]


def placed(k):
    """The candles scaled by k about the centre of the tile."""
    at = lambda v: 256 + (v - 256) * k
    return [(at(x), at(wt), at(bt), at(bb), at(wb), col)
            for x, wt, bt, bb, wb, col in CANDLES]


def draw(size, bleed, k):
    n = size * SS
    u = n / 512.0
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bleed:
        d.rectangle([0, 0, n, n], fill=WHITE + (255,))
    else:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=RADIUS * u,
                            fill=WHITE + (255,))
        half = EDGE_W * u / 2
        d.rounded_rectangle([half, half, n - 1 - half, n - 1 - half],
                            radius=(RADIUS - EDGE_W / 2) * u,
                            outline=EDGE + (255,), width=max(1, round(EDGE_W * u)))
    bw, ww, br = BODY_W * k, WICK_W * k, BODY_R * k
    for x, wt, bt, bb, wb, col in placed(k):
        cx = x + bw / 2
        d.rectangle([(cx - ww / 2) * u, wt * u, (cx + ww / 2) * u, wb * u],
                    fill=col + (255,))
        d.rounded_rectangle([x * u, bt * u, (x + bw) * u, bb * u],
                            radius=br * u, fill=col + (255,))
    out = im.resize((size, size), Image.LANCZOS)
    # No alpha where there must be none: iOS would paint it black.
    return out.convert("RGB") if bleed else out


def hexc(c):
    return "#%02X%02X%02X" % c


def svg(k=BIG):
    half = EDGE_W / 2
    rows = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'role="img" aria-label="Traders Diary">',
        '  <rect x="%g" y="%g" width="%g" height="%g" rx="%g" fill="%s" '
        'stroke="%s" stroke-width="%g"/>'
        % (half, half, 512 - EDGE_W, 512 - EDGE_W, RADIUS - half,
           hexc(WHITE), hexc(EDGE), EDGE_W),
    ]
    bw, ww, br = BODY_W * k, WICK_W * k, BODY_R * k
    for x, wt, bt, bb, wb, col in placed(k):
        cx = x + bw / 2
        rows.append('  <rect x="%g" y="%g" width="%g" height="%g" fill="%s"/>'
                    % (cx - ww / 2, wt, ww, wb - wt, hexc(col)))
        rows.append('  <rect x="%g" y="%g" width="%g" height="%g" rx="%g" fill="%s"/>'
                    % (x, bt, bw, bb - bt, br, hexc(col)))
    rows.append("</svg>")
    return "\n".join(rows) + "\n"


if __name__ == "__main__":
    path = os.path.join(DOCS, "logo.svg")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(svg())
    print("  logo.svg  %s bytes" % format(os.path.getsize(path), ","))
    for name, size, bleed, k in OUTPUTS:
        out = os.path.join(DOCS, name)
        draw(size, bleed, k).save(out, optimize=True)
        print("  %s  %s bytes" % (name, format(os.path.getsize(out), ",")))
