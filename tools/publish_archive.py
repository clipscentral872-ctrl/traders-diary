"""Publish bars from the collector's archive, not from Yahoo.

Yahoo hands out eight days of one-minute bars and refuses anything older,
which is why the app could only ever draw a trade from the last week or so.
The collector on this machine has been keeping those bars every night for
months, so the history already exists, it was just never published beside
the app.

This reads that archive and merges it into docs/bars in the same packed
format publish_bars.py writes, so the two can be run in any order and the
app cannot tell which one filled a minute in.

    python tools/publish_archive.py                 NQ, one minute, 60 days
    python tools/publish_archive.py --symbols NQ,ES --tf 1m,5m --days 90

Nothing here is market data the app did not already publish; it is the same
contracts, further back.
"""
import argparse
import datetime
import functools
import io
import json
import os

print = functools.partial(print, flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "bars")
ARCHIVE = os.path.join(os.path.expanduser("~"), "AITrader", "data", "collected")

STEP = {"1m": 60, "5m": 300, "1h": 3600}


def pack(frame, step):
    """A dataframe of bars onto the fixed grid the app reads.

    The index is UTC timestamps and the columns are open, high, low, close,
    with volume when the collector kept it. Minutes the market did not trade
    stay as null so a bar's time is still its position.
    """
    import pandas as pd

    ts = [int(t.timestamp()) for t in frame.index]
    if not ts:
        return None, 0
    t0, last = ts[0], ts[-1]
    n = (last - t0) // step + 1
    grid = [None] * n
    cols = {c.lower(): c for c in frame.columns}
    has_vol = "volume" in cols
    kept = 0
    for i, t in enumerate(ts):
        row = frame.iloc[i]
        o, h, l, c = (row[cols["open"]], row[cols["high"]],
                      row[cols["low"]], row[cols["close"]])
        if any(pd.isna(v) for v in (o, h, l, c)):
            continue
        j = (t - t0) // step
        if 0 <= j < n:
            v = row[cols["volume"]] if has_vol and not pd.isna(row[cols["volume"]]) else 0
            grid[j] = [round(float(o), 2), round(float(h), 2),
                       round(float(l), 2), round(float(c), 2), int(v)]
            kept += 1
    return {"t0": t0, "step": step, "bars": grid}, kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default="NQ")
    ap.add_argument("--tf", default="1m")
    ap.add_argument("--days", type=int, default=60,
                    help="how much history to keep in the published file")
    ap.add_argument("--archive", default=ARCHIVE)
    args = ap.parse_args()

    # Imported here so the rest of the file still runs where pandas is not
    # installed and the message can say so plainly.
    try:
        import pandas as pd
    except ImportError:
        raise SystemExit("pandas is needed to read the collector's archive: "
                         "pip install pandas pyarrow")

    from publish_bars import merge, read_existing

    os.makedirs(OUT, exist_ok=True)
    for sym in [s.strip().upper() for s in args.symbols.split(",") if s.strip()]:
        for tf in [t.strip() for t in args.tf.split(",") if t.strip()]:
            step = STEP.get(tf)
            if not step:
                print(f"  {sym} {tf}: not a timeframe this publishes")
                continue
            src = os.path.join(args.archive, f"{sym}_{tf}.parquet")
            if not os.path.exists(src):
                print(f"  {sym} {tf}: nothing in the archive")
                continue
            frame = pd.read_parquet(src).sort_index()
            fresh, kept = pack(frame, step)
            if not fresh:
                print(f"  {sym} {tf}: archive is empty")
                continue

            path = os.path.join(OUT, f"{sym}_{tf}.json")
            old = read_existing(path, step)
            merged, total = merge(old, fresh, step, args.days)
            io.open(path, "w", encoding="utf-8").write(
                json.dumps({"symbol": sym, **merged}, separators=(",", ":")))

            t0 = merged["t0"]
            end = t0 + merged["step"] * (len(merged["bars"]) - 1)
            fmt = lambda s: datetime.datetime.fromtimestamp(
                s, datetime.timezone.utc).strftime("%Y-%m-%d")
            size = os.path.getsize(path) / 1e6
            print(f"  {sym} {tf}: {total} bars, {fmt(t0)} to {fmt(end)}, "
                  f"{size:.1f} MB")


if __name__ == "__main__":
    main()
