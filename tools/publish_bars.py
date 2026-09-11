"""Publish recent minute bars beside the app, so the phone can draw charts.

A browser cannot fetch a market feed. Both Yahoo and Stooq refuse the request
outright, because neither sends the CORS header a page needs to read a reply
from another site. So instead of the page reaching out for bars, the bars are
fetched here once a day and committed next to the page, where it can read them
from its own origin with no permission needed at all.

Format is a flat array on a fixed one-minute grid rather than a list of
objects. It is about a fifth of the size, which matters when a phone on a bad
connection has to pull it:

    {"symbol": "NQ", "t0": <unix seconds of the first bar>,
     "step": 60, "bars": [[o,h,l,c], null, [o,h,l,c], ...]}

`null` is a minute the market did not trade. The gaps are kept rather than
squeezed out so the grid stays fixed and a bar's time is its position.

    python tools/publish_bars.py
"""
import argparse
import functools
import io
import json
import os
import time
import urllib.request as u

print = functools.partial(print, flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "bars")

SYMBOLS = {"NQ": "NQ=F", "ES": "ES=F", "YM": "YM=F", "RTY": "RTY=F"}

# What Yahoo will give away, per timeframe, and how much of it is kept.
#
# The window is a hard cap on Yahoo's side and there is no asking for more: a
# five-minute request for anything older than sixty days is refused outright,
# whatever period you pass. That is the whole reason KEEP exists. Every run
# used to overwrite the file with just the window, so the archive could never
# be longer than the window and every bar older than sixty days was thrown
# away, daily, forever. Now each run is merged into what is already there and
# the history grows on its own.
#
# One minute is not kept, because a year of it is 100,000 bars a contract and
# it exists for drawing the candles under a recent trade, not for replay.
TIMEFRAMES = [("1m", "8d", 60, 12), ("5m", "60d", 300, 500),
              ("1h", "730d", 3600, 800)]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def yahoo(symbol, rng="8d", interval="1m"):
    sym = symbol.replace("=", "%3D").replace("^", "%5E")
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?range={rng}&interval={interval}")
    req = u.Request(url, headers={"User-Agent": UA})
    with u.urlopen(req, timeout=45) as r:
        return json.load(r)["chart"]["result"][0]


def pack(res, step):
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    t0 = ts[0]
    # Lay every bar onto the fixed grid. Yahoo skips closed minutes, so
    # position alone would drift by hours across a weekend without this.
    n = (ts[-1] - t0) // step + 1
    grid = [None] * n
    kept = 0
    # Volume rides along as a fifth number. Every reader takes the first four
    # by position, so they carry on as they were; the chart reads the fifth
    # when it is there. A minute Yahoo prices but has no volume for is stored
    # as zero rather than dropped, because the price is still real.
    vol = q.get("volume") or []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        j = (t - t0) // step
        if 0 <= j < n:
            v = vol[i] if i < len(vol) else None
            grid[j] = [round(o, 2), round(h, 2), round(l, 2), round(c, 2),
                       int(v) if v else 0]
            kept += 1
    return {"t0": t0, "step": step, "bars": grid}, kept, n


def merge(old, fresh, step, keep_days):
    """Fold a fresh window into the archive, oldest bar first.

    Both sides are a fixed grid, so this goes back to (time, bar) pairs, lets
    the fresh copy win any minute they disagree on, and lays a new grid over
    the union. Fresh wins because Yahoo revises: a bar can come back with a
    different high once the late prints land.
    """
    have = {}
    if old:
        t0, st = old["t0"], old["step"]
        for i, b in enumerate(old["bars"]):
            if b:
                have[t0 + i * st] = b
    t0, st = fresh["t0"], fresh["step"]
    for i, b in enumerate(fresh["bars"]):
        if b:
            have[t0 + i * st] = b
    if not have:
        return fresh, 0

    newest = max(have)
    floor = newest - keep_days * 86400
    have = {t: b for t, b in have.items() if t >= floor}

    first = min(have)
    n = (newest - first) // step + 1
    grid = [None] * n
    for t, b in have.items():
        j = (t - first) // step
        if 0 <= j < n:
            grid[j] = b
    return {"t0": first, "step": step, "bars": grid}, len(have)


def read_existing(path, step):
    """The archive as it stands, or None. A file that will not parse is
    treated as absent rather than allowed to take the run down: losing the
    history is bad, publishing nothing at all is worse."""
    if not os.path.exists(path):
        return None
    try:
        j = json.load(io.open(path, encoding="utf-8"))
        if j.get("step") != step or not isinstance(j.get("bars"), list):
            return None
        return j
    except (ValueError, OSError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="just these timeframes, eg 1m")
    a = ap.parse_args()
    wanted_tf = [t for t in TIMEFRAMES
                 if not a.only or t[0] in a.only.split(",")]
    if not wanted_tf:
        raise SystemExit(f"no timeframe matches --only {a.only!r}")

    os.makedirs(OUT, exist_ok=True)
    index = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "series": []}
    failed = wanted = 0
    for name, feed in SYMBOLS.items():
        for tf, rng, step, keep_days in wanted_tf:
            wanted += 1
            path = os.path.join(OUT, f"{name}_{tf}.json")
            try:
                packed, kept, n = pack(yahoo(feed, rng, tf), step)
            except Exception as e:
                # A feed down for one run must not wipe yesterday's file, which
                # is still perfectly good for everything but today.
                print(f"  {name:<4} {tf:<3} FAILED ({type(e).__name__}), "
                      f"keeping what is there")
                failed += 1
                continue
            before = read_existing(path, step)
            packed, kept = merge(before, packed, step, keep_days)
            packed["symbol"] = name
            packed["tf"] = tf
            io.open(path, "w", encoding="utf-8").write(
                json.dumps(packed, separators=(",", ":")))
            kb = os.path.getsize(path) / 1024
            first = time.strftime("%Y-%m-%d", time.gmtime(packed["t0"]))
            days = (packed["t0"] + len(packed["bars"]) * step
                    - packed["t0"]) // 86400
            grew = ""
            if before and before["t0"] < packed["t0"] + 1:
                added = time.strftime("%Y-%m-%d", time.gmtime(before["t0"]))
                grew = "" if added == first else f"  (was from {added})"
            print(f"  {name:<4} {tf:<3} {kept:>7,} bars from {first}"
                  f"  {days:>4} days  {kb:>6,.0f} KB{grew}")
            index["series"].append({"symbol": name, "tf": tf, "bars": kept,
                                    "from": first, "days": days})

    # A partial run only knows about what it fetched, so the rest of the index
    # is carried across rather than dropped. Otherwise a 1m-only refresh would
    # report that the 5m and 1h series had vanished.
    prev_path = os.path.join(OUT, "index.json")
    if a.only and os.path.exists(prev_path):
        try:
            prev = json.load(io.open(prev_path, encoding="utf-8"))
            fresh = {(x["symbol"], x["tf"]) for x in index["series"]}
            index["series"] += [x for x in prev.get("series", [])
                                if (x["symbol"], x["tf"]) not in fresh]
        except (ValueError, KeyError, TypeError):
            pass
    index["series"].sort(key=lambda x: (x["symbol"], x["tf"]))
    io.open(prev_path, "w", encoding="utf-8").write(json.dumps(index, indent=1))

    if failed == wanted:
        raise SystemExit("every feed failed, so nothing was published")
    print(f"\n  published to {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
