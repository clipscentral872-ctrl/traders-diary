"""Check the bar archive grows instead of rolling off.

The failure this exists to catch left no trace. Every run overwrote the file
with just the window Yahoo will serve, so the history could never be longer
than sixty days, and each day's run quietly threw away the day that had just
fallen out the back. Nothing looked wrong: the file was there, the bars were
right, the chart drew. It simply could not remember.

    python tools/test_merge.py
"""
import functools
import os
import sys

print = functools.partial(print, flush=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_bars import merge

FAILED = []


def check(name, ok, detail=""):
    if not ok:
        FAILED.append(name)
    print("  %s  %s%s" % ("pass" if ok else "FAIL", name,
                          "" if ok else "   " + str(detail)))


def series(t0, step, prices):
    """A grid where each price becomes one bar, and None is a closed slot."""
    return {"t0": t0, "step": step,
            "bars": [None if p is None else [p, p + 1, p - 1, p]
                     for p in prices]}


def at(packed, t):
    i = (t - packed["t0"]) // packed["step"]
    if i < 0 or i >= len(packed["bars"]):
        return None
    return packed["bars"][i]


DAY = 86400
STEP = 300

print("\nan older archive is not thrown away by a newer window")
old = series(1000 * STEP, STEP, [10, 11, 12])
fresh = series(1010 * STEP, STEP, [20, 21, 22])
out, kept = merge(old, fresh, STEP, 500)
check("every bar from both sides survives", kept == 6, kept)
check("it starts at the older start", out["t0"] == 1000 * STEP, out["t0"])
check("an old bar is still readable", at(out, 1001 * STEP)[0] == 11)
check("and a new one", at(out, 1011 * STEP)[0] == 21)
check("the gap between them is empty, not invented",
      at(out, 1005 * STEP) is None)

print("\nthe fresh copy wins where they disagree")
old = series(1000 * STEP, STEP, [10, 11, 12])
fresh = series(1001 * STEP, STEP, [99, 98])
out, kept = merge(old, fresh, STEP, 500)
check("a revised bar takes the new value", at(out, 1001 * STEP)[0] == 99,
      at(out, 1001 * STEP))
check("a bar only the archive has is left alone",
      at(out, 1000 * STEP)[0] == 10)
check("nothing is duplicated", kept == 3, kept)

print("\nthe archive is capped so it cannot grow without limit")
old = series(0, STEP, [1])
fresh = series(400 * DAY, STEP, [2])
out, kept = merge(old, fresh, STEP, 100)
check("a bar past the cap is dropped", kept == 1, kept)
check("and the newest is the one kept", at(out, 400 * DAY)[0] == 2)

old = series(0, STEP, [1])
fresh = series(50 * DAY, STEP, [2])
out, kept = merge(old, fresh, STEP, 100)
check("a bar inside the cap is kept", kept == 2, kept)

print("\na first run has nothing to merge into")
fresh = series(1000 * STEP, STEP, [10, 11])
out, kept = merge(None, fresh, STEP, 500)
check("the window is published as it is", kept == 2, kept)
check("starting where it starts", out["t0"] == 1000 * STEP)

print("\nrunning the same window twice changes nothing")
fresh = series(1000 * STEP, STEP, [10, 11, 12])
once, a = merge(None, fresh, STEP, 500)
twice, b = merge(once, fresh, STEP, 500)
check("the same bars", a == b == 3, "%s vs %s" % (a, b))
check("the same grid", once == twice)

print("\ngaps in the middle stay gaps")
old = series(1000 * STEP, STEP, [10, None, None, 13])
out, kept = merge(None, old, STEP, 500)
check("closed slots are not counted as bars", kept == 2, kept)
check("and are still empty", at(out, 1001 * STEP) is None)

print("\n" + ("%d check(s) failed" % len(FAILED) if FAILED
              else "all checks passed"))
sys.exit(1 if FAILED else 0)
