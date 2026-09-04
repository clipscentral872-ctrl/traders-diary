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
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def yahoo(symbol, rng="8d", interval="1m"):
    sym = symbol.replace("=", "%3D").replace("^", "%5E")
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?range={rng}&interval={interval}")
    req = u.Request(url, headers={"User-Agent": UA})
    with u.urlopen(req, timeout=45) as r:
        return json.load(r)["chart"]["result"][0]


def pack(res):
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    step = 60
    t0 = ts[0]
    # Lay every bar onto the fixed grid. Yahoo skips closed minutes, so
    # position alone would drift by hours across a weekend without this.
    n = (ts[-1] - t0) // step + 1
    grid = [None] * n
    kept = 0
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        j = (t - t0) // step
        if 0 <= j < n:
            grid[j] = [round(o, 2), round(h, 2), round(l, 2), round(c, 2)]
            kept += 1
    return {"t0": t0, "step": step, "bars": grid}, kept, n


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "symbols": []}
    failed = []
    for name, feed in SYMBOLS.items():
        path = os.path.join(OUT, f"{name}_1m.json")
        try:
            packed, kept, n = pack(yahoo(feed))
        except Exception as e:
            # A feed that is down for one run must not wipe yesterday's file,
            # which is still perfectly good for everything but today.
            print(f"  {name:<4} FAILED ({type(e).__name__}), keeping what is there")
            failed.append(name)
            continue
        packed["symbol"] = name
        io.open(path, "w", encoding="utf-8").write(
            json.dumps(packed, separators=(",", ":")))
        kb = os.path.getsize(path) / 1024
        first = time.strftime("%Y-%m-%d", time.gmtime(packed["t0"]))
        print(f"  {name:<4} {kept:>6,} bars over {n:,} minutes from {first}"
              f"   {kb:,.0f} KB")
        index["symbols"].append({"symbol": name, "bars": kept, "from": first})

    io.open(os.path.join(OUT, "index.json"), "w", encoding="utf-8").write(
        json.dumps(index, indent=1))

    if len(failed) == len(SYMBOLS):
        raise SystemExit("every feed failed, so nothing was published")
    print(f"\n  published to {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
