"""Bake the existing trade record into the app.

A fresh install used to open empty and ask you to import six CSVs before it
could say anything. That is fine for someone starting out and wrong for a
record that already exists: the app is the record, so the record ships with it.

The seed is only ever used on a browser that has never stored anything. Once
there is a record, or once "Erase everything" has been pressed, this file is
ignored, so it can never overwrite or resurrect anything.

WHAT THIS PUBLISHES: docs/ is a public GitHub Pages site, so every trade in
the seed is readable by anyone with the link. Only put in it what you are
happy for a stranger to read. To go back to an empty app, delete
docs/seed.json and rebuild.

    python tools/make_seed.py ../AITrader/journal_data/trades.json
"""
import datetime
import functools
import io
import json
import os
import sys

print = functools.partial(print, flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")

# Trades you actually placed. The automated system's own record is not seeded:
# it is read live from its own state on the System tab, and folding it into
# the diary would put it behind a source filter that does not list it.
KEEP = "live"

# The account these trades were placed on, from the balance history's first
# "balance before". Without it the equity curve has no zero and every drawdown
# is measured from the wrong place.
START = 100000


def main(src):
    trades = json.load(io.open(src, encoding="utf-8"))
    mine = [t for t in trades if t.get("source", "live") == KEEP]
    if not mine:
        raise SystemExit(f"no {KEEP} trades in {src}")

    days = sorted({t["open_t"][:10] for t in mine})
    body = {
        "trades": mine,
        "start": START,
        "made": datetime.date.today().isoformat(),
    }
    out = os.path.join(DOCS, "seed.json")
    io.open(out, "w", encoding="utf-8", newline="\n").write(
        json.dumps(body, separators=(",", ":")))
    net = sum(t["pnl"] for t in mine)
    print(f"  seed.json  {len(mine)} trades, {days[0]} to {days[-1]}, "
          f"{'+' if net >= 0 else ''}${net:,.0f}  "
          f"({os.path.getsize(out):,} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__.strip().splitlines()[-1].strip())
    main(sys.argv[1])
