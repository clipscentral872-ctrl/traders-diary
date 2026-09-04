# Traders Diary

A trading journal that shows you the trade, not just the number.

Open it, drop in the CSV files TradingView gives you, and it draws every trade
on the minute bars it actually happened on, with your entry, stop, target and
exit marked, and a written read of what went right or wrong.

It runs entirely in your browser. Nothing is uploaded, there is no account, and
your trades never leave your device.

**[Open Traders Diary](https://clipscentral872-ctrl.github.io/traders-diary/)**

## Put it on your phone

It installs like an app, so it opens full screen and works with no signal.

- **iPhone**: open the link in Safari, tap the share button, choose
  **Add to Home Screen**.
- **Android**: open the link in Chrome, then **Install app** from the menu.
- **Mac or Windows**: open it in Chrome or Edge and click the install icon in
  the address bar. In Safari, choose **Add to Dock**.

## Getting your files out of TradingView

1. Open the **Trading Panel** at the bottom of the chart and pick your
   **Paper Trading** account.
2. Click the **gear icon** on the right of that panel, then **Export data**.
3. Tick everything and download. You get six CSV files.
4. Add all six at once.

Do this at the **end** of a session. TradingView caps the activity-log export
at roughly the last hour, so exporting late catches the whole session and
exporting the next morning misses it.

Three of the six files do the work:

| File | What it gives you |
| --- | --- |
| Order history | Every fill. The trades are built from this. |
| Activity log | Stop moves. Without it, a trade has no R. |
| Balance history | The opening balance, so the equity curve shows the account. |

The other three are read as a cross-check. If what they say disagrees with what
the fills say, the page tells you instead of quietly picking one.

## What it checks, every time

These are the mistakes a table of statistics cannot show you, so they are
checked mechanically rather than when you happen to remember to look:

- A stop that filled worse than it was set, and what that cost in R.
- A stop trailed in before price had run the distance your own rule waits for.
- A stop moved to the wrong side of your entry, which fires the moment it lands.
- An exit well short of the target, with how much of the planned move you kept.
- A loss where the direction was right and the stop was simply too tight,
  measured over the bars after you were closed.
- A stop taken in the last seconds before a scheduled data release.
- A target so far out that the trade was never the one being managed.

## Two rules it will not bend

**R is the risk you took at entry, never the trailed stop.** Measuring against
the trailed stop divides a small loss by a tiny remaining risk. On real data
that produced -22R on a single trade and -3.8R of expectancy on a day that made
money.

**A trade with no recorded entry stop has no R.** Not zero, and not a number
measured against whatever stop happens to be known. TradingView caps the
activity-log export, so this happens, and the page says which trades it applies
to and which way it bends the figure that is left.

## Running it yourself

Nothing is required to use it. To build or change it:

```bash
python tools/build_web.py      # build docs/index.html from the template
python tools/make_icons.py     # redraw the home-screen icons
python tools/publish_bars.py   # refresh the candles the charts are drawn on
node tools/test_engine.mjs <exports-folder> <trades.json>
```

`docs/` is the whole app. It is static: any web server, or GitHub Pages, will
serve it.

### Where the candles come from

A browser cannot fetch a market feed. Both Yahoo and Stooq refuse the request,
because neither sends the header a page needs to read a reply from another
site. So `tools/publish_bars.py` fetches recent minute bars once a day and
commits them to `docs/bars/`, where the page reads them from its own origin
with no permission needed. A GitHub Action does this automatically.

That means charts go back about ten days. Import each session while it is
recent and the chart is kept for good. Numbers are kept either way.

## What this is not

It tells you what you did. It does not know whether your strategy works, and
nothing in it has been tested against out-of-sample data. Do not size up
because a page looks encouraging.

## Licence

MIT. See [LICENSE](LICENSE).
