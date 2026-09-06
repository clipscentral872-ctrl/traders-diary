"""Build a year of five-minute bars for the replay, from Dukascopy tick data.

WHY THIS EXISTS, AND WHAT IT IS NOT

Yahoo will not serve five-minute bars older than sixty days. Not with a longer
range, not with an explicit period: the request is refused. So the futures
archive can only grow forwards from the day publish_bars.py started keeping
it, which is fine in ten months and no use for backtesting a year today.

Dukascopy publish their tick history as static files with no key and no
account, going back years. What they publish is the CASH INDEX as a contract
for difference, not the future. That matters and it is not hidden anywhere:

  The shape is the same. The swing highs and lows, the sweeps, the sessions,
  the reaction to an 08:30 release: all of it is the same market.

  The prices are NOT the same. The future trades at a basis to the index that
  moves with rates and dividends, tens of points, and it drifts. A level read
  off this will not be the level on your NQ chart.

So this is published as its own instrument, named for what it is, and never
merged into the futures files. Practise structure on it. Do not read exact
levels off it.

Only the New York cash session is kept, because that is the session being
practised and because keeping the other seventeen hours would quadruple a
file a phone has to pull.

    python tools/backfill_index.py --days 365
    python tools/backfill_index.py --days 30 --only NDX     (a quick one)

Files already downloaded are reused, so stopping this and running it again
picks up where it left off.
"""
import argparse
import datetime as dt
import functools
import io
import json
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request as u

print = functools.partial(print, flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "bars")
CACHE = os.path.join(HERE, "..", ".tickcache")

# What the app will call it, and what Dukascopy call it. The names are the
# index, not the future, because that is what the data is.
INSTRUMENTS = {
    "NDX": ("USATECHIDXUSD", "Nasdaq 100 index"),
    "SPX": ("USA500IDXUSD", "S&P 500 index"),
    "DJI": ("USA30IDXUSD", "Dow index"),
    "RUT": ("USSC2000IDXUSD", "Russell 2000 index"),
}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# 13:00 to 21:00 UTC covers 09:30 to 16:00 New York in summer, 14:00 to 22:00
# covers it in winter. Both windows are fetched and the bars outside the
# session are dropped afterwards on the New York clock, which is the only way
# to get this right across a daylight saving change.
HOURS = range(13, 22)
STEP = 300
PRICE_SCALE = 1000.0     # index CFDs are published in thousandths

# Their server refuses roughly one request in two when it is being asked for a
# lot, and answers the retry. Politeness is not optional here: this is a free
# public file server and a year is a few thousand requests.
PAUSE = 0.35
RETRIES = 5


def url_for(instr, day, hour):
    # Their months are zero based, which is a Java Calendar showing through.
    return (f"https://datafeed.dukascopy.com/datafeed/{instr}/"
            f"{day.year:04d}/{day.month - 1:02d}/{day.day:02d}/{hour:02d}h_ticks.bi5")


def cached_path(instr, day, hour):
    return os.path.join(CACHE, instr,
                        f"{day.year:04d}{day.month:02d}{day.day:02d}_{hour:02d}.bi5")


def fetch(instr, day, hour):
    """The raw hour, from disk if it is already here. b"" means no ticks."""
    path = cached_path(instr, day, hour)
    if os.path.exists(path):
        return io.open(path, "rb").read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wait = 1.0
    for attempt in range(RETRIES):
        try:
            req = u.Request(url_for(instr, day, hour), headers={"User-Agent": UA})
            with u.urlopen(req, timeout=45) as r:
                raw = r.read()
            io.open(path, "wb").write(raw)
            time.sleep(PAUSE)
            return raw
        except urllib.error.HTTPError as e:
            if e.code == 404:
                # A market holiday. Recorded as empty so it is never asked for
                # again on a rerun.
                io.open(path, "wb").write(b"")
                return b""
            if e.code in (429, 503) and attempt < RETRIES - 1:
                time.sleep(wait)
                wait *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < RETRIES - 1:
                time.sleep(wait)
                wait *= 2
                continue
            raise
    return b""


def ticks(raw, hour_start_ms):
    """Decode one hour: (ms, bid) pairs, ascending.

    Twenty bytes a tick, big endian: milliseconds into the hour, ask, bid,
    then two volumes this does not use.
    """
    if not raw:
        return []
    try:
        body = lzma.LZMADecompressor(format=lzma.FORMAT_AUTO).decompress(raw)
    except lzma.LZMAError:
        try:
            body = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(raw)
        except lzma.LZMAError:
            return []
    out = []
    for i in range(len(body) // 20):
        ms, ask, bid, _, _ = struct.unpack(">iiiff", body[i * 20:(i + 1) * 20])
        if bid > 0:
            out.append((hour_start_ms + ms, bid / PRICE_SCALE))
    out.sort()
    return out


NY = None


def ny_parts(ms):
    """Year, month, day, hour, minute in New York."""
    global NY
    if NY is None:
        try:
            from zoneinfo import ZoneInfo
            NY = ZoneInfo("America/New_York")
        except ImportError:
            raise SystemExit("this needs Python 3.9 or newer for zoneinfo")
    d = dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).astimezone(NY)
    return d.year, d.month, d.day, d.hour, d.minute


def in_session(ms):
    _, _, _, h, m = ny_parts(ms)
    mins = h * 60 + m
    return 9 * 60 + 30 <= mins < 16 * 60


def to_bars(pairs):
    """Ticks to five-minute bars, keyed on the clock rather than on position."""
    bars = {}
    for ms, px in pairs:
        if not in_session(ms):
            continue
        key = (ms // 1000 // STEP) * STEP
        b = bars.get(key)
        if b is None:
            bars[key] = [px, px, px, px]
        else:
            if px > b[1]:
                b[1] = px
            if px < b[2]:
                b[2] = px
            b[3] = px
    return bars


def grid(bars):
    if not bars:
        return None
    t0, tn = min(bars), max(bars)
    n = (tn - t0) // STEP + 1
    out = [None] * n
    for t, b in bars.items():
        out[(t - t0) // STEP] = [round(v, 2) for v in b]
    return {"t0": t0, "step": STEP, "bars": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--only", default="", help="one key, eg NDX")
    a = ap.parse_args()

    keys = [k for k in INSTRUMENTS if not a.only or k in a.only.split(",")]
    if not keys:
        raise SystemExit(f"no instrument matches --only {a.only!r}")

    today = dt.date.today()
    days = [today - dt.timedelta(days=i) for i in range(a.days, 0, -1)]
    days = [d for d in days if d.weekday() < 5]

    os.makedirs(OUT, exist_ok=True)
    for key in keys:
        instr, label = INSTRUMENTS[key]
        bars = {}
        done = holidays = 0
        started = time.time()
        for d in days:
            got = 0
            for h in HOURS:
                start_ms = int(dt.datetime(d.year, d.month, d.day, h,
                                           tzinfo=dt.timezone.utc).timestamp()) * 1000
                try:
                    raw = fetch(instr, d, h)
                except Exception as e:
                    print(f"  {key} {d} {h:02d}h  {type(e).__name__}, skipped")
                    continue
                tk = ticks(raw, start_ms)
                got += len(tk)
                bars.update(to_bars(tk))
            done += 1
            if not got:
                holidays += 1
            if done % 10 == 0:
                rate = done / max(1e-6, time.time() - started)
                left = (len(days) - done) / max(1e-6, rate) / 60
                print(f"  {key}  {done}/{len(days)} days  {len(bars):,} bars"
                      f"  about {left:.0f} min left")

        packed = grid(bars)
        if not packed:
            print(f"  {key}  nothing came back, nothing written")
            continue
        packed["symbol"] = key
        packed["tf"] = "5m"
        packed["kind"] = "index"
        packed["about"] = (f"{label}, cash session only. This is the index, "
                           f"not the future: the same structure at a "
                           f"different price.")
        path = os.path.join(OUT, f"{key}_5m.json")
        io.open(path, "w", encoding="utf-8").write(
            json.dumps(packed, separators=(",", ":")))
        first = time.strftime("%Y-%m-%d", time.gmtime(packed["t0"]))
        print(f"  {key:<4} {len(bars):>7,} bars from {first}"
              f"  {os.path.getsize(path) / 1024:>6,.0f} KB"
              f"  ({holidays} days with nothing)")


if __name__ == "__main__":
    main()
