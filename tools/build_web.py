"""Turn the shared page template into the standalone web app.

The diary already draws everything in the browser from a list of trades. All
this does is cut the server out of the middle: instead of Python computing the
trades and baking them into the page, the page computes them itself from the
files you drop on it, using engine.js.

That is what lets the same diary run on a phone with nothing installed.

    python tools/build_web.py
"""
import functools
import io
import json
import os
import re

print = functools.partial(print, flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")
TEMPLATE = os.path.join(DOCS, "_template.html")
OUT = os.path.join(DOCS, "index.html")

# Kept in step with the Python renderer's own table.
FLAG_TEXT = {
    "slipped": "stop filled worse than it was set",
    "stop wrong side": "stop moved past the entry, so it fired at once",
    "trailed": "stop was trailed during the trade",
    "trailed early": "trailed before price had run 2R",
    "target hit": "reached the target",
    "closed early": "closed by hand well short of the target",
    "cut short": "price reached the target after the exit",
    "right, stopped early": "direction was right, stop was too tight",
    "target far out": "target set beyond 3.5R",
    "stopped fast": "stopped within a minute",
    "no R": "no stop on record, so no R to measure",
    "stopped into the news": "stopped in the last minute before a data release",
}

HEAD_TAGS = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070C">
<meta name="description" content="A trading journal that shows you the trade, not just the number.">
<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Traders Diary">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon.svg" type="image/svg+xml">
"""

# The bar replay lives in the desktop project, which has a market data store
# behind it. Promising it here and linking to a page that does not exist is
# worse than not offering it.
REPLAY_SECTION = re.compile(
    r'<section>\s*<h2>Bar Replay</h2>.*?</section>', re.S)

# The install step is the whole difference between a bookmark and an app, and
# on an iPhone it cannot be automated: Safari has no install prompt, so the
# only route is telling someone which button to press. That makes it the first
# thing on the page rather than a note near the bottom.
INSTALL = """<section id="installbar" hidden>
  <div class="card hud install">
    <div class="insticon" aria-hidden="true"></div>
    <div class="insttext">
      <p class="instbig">Put this on your home screen</p>
      <p class="instsub" id="inststeps"></p>
    </div>
    <button class="bigbtn" id="instgo" hidden>Install</button>
    <button class="instx" id="instno" aria-label="Dismiss">Not now</button>
  </div>
</section>
"""

PRIVACY = """<section>
  <h2>Where your trades live</h2>
  <p class="lead">Nowhere but this device. The files you drop are read in the
  browser, and the record is kept in this browser's own storage. Nothing is
  uploaded, there is no account, and no one else can see it, including whoever
  made this. That also means clearing your browser data clears the diary, so
  keep a backup.</p>
  <div class="toolrow">
    <button class="bigbtn" id="save">Save a backup file</button>
    <button class="bigbtn ghost" id="load">Restore from a backup</button>
    <button class="bigbtn ghost" id="wipe">Erase everything</button>
    <input type="file" id="loadpick" accept=".json" hidden>
  </div>
  <p class="lead" id="storeline"></p>
</section>

<section>
  <h2>Keep it on your phone</h2>
  <p class="lead">This works as an app rather than a bookmark. On an iPhone,
  open it in Safari, tap the share button and choose <b>Add to Home Screen</b>.
  On an Android phone or a Mac, look for <b>Install</b> in the browser menu or
  the address bar. It then opens full screen, keeps your record, and still
  works with no signal.</p>
</section>
"""

SETTINGS = """<section>
  <h2>One setting</h2>
  <p class="lead">TradingView stamps its exports in your own local time and
  never says which. The diary needs to know, because the check for a stop taken
  seconds before a data release is measured on the New York clock. Pick the
  offset your computer runs on and this is right all year, daylight saving
  included.</p>
  <div class="setrow">
    <label for="tz">Your exports are stamped in</label>
    <select id="tz"></select>
  </div>
</section>
"""


# Styles for the sections this build adds, plus the phone pass. Kept here
# rather than in the shared template because the desktop project has neither
# these controls nor a phone to run on.
EXTRA_CSS = """
.install{
  display:flex; align-items:center; gap:18px; flex-wrap:wrap;
  padding:20px 22px; margin-bottom:34px;
}
.insticon{
  flex:none; width:38px; height:38px; border:2px solid var(--accent);
  border-radius:9px; position:relative; box-shadow:0 0 18px var(--accent-dim);
}
.insticon::before{
  content:""; position:absolute; left:50%; top:9px; width:2px; height:15px;
  background:var(--accent); transform:translateX(-50%);
}
.insticon::after{
  content:""; position:absolute; left:50%; top:8px; width:9px; height:9px;
  border-left:2px solid var(--accent); border-top:2px solid var(--accent);
  transform:translateX(-50%) rotate(45deg);
}
.insttext{flex:1 1 240px; min-width:0}
.instbig{
  font-family:"Orbitron",sans-serif; font-weight:800; font-size:14px;
  letter-spacing:.07em; text-transform:uppercase; margin:0 0 5px;
}
.instsub{margin:0; color:var(--muted); font-size:13.5px; line-height:1.6}
.instsub b{color:var(--text)}
.instx{
  background:none; border:none; color:var(--faint); cursor:pointer;
  font-family:"Chakra Petch",sans-serif; font-size:12px; padding:12px;
  text-transform:uppercase; letter-spacing:.08em; min-height:44px;
}
.instx:hover{color:var(--muted)}
.instx:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.toolrow{display:flex; flex-wrap:wrap; gap:10px; margin:18px 0 12px}
.bigbtn.ghost{
  background:transparent; border-color:var(--line); color:var(--muted);
  box-shadow:none;
}
.bigbtn.ghost:hover{border-color:var(--accent); color:var(--text); background:var(--raised)}
#wipe:hover{border-color:var(--loss); color:var(--loss)}
.setrow{
  display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:18px;
  background:var(--raised); border:1px solid var(--line); padding:14px 16px;
}
.setrow label{color:var(--muted); font-size:13px}
.setrow select{
  background:var(--lift); color:var(--text); border:1px solid var(--line);
  font-family:"JetBrains Mono",monospace; font-size:14px; padding:9px 12px;
  min-height:44px;
}
.setrow select:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

/* A phone has no pointer to hover with and no room to waste. Every control is
   at least the 44px Apple asks for, and the two-column panes stack. */
@media (max-width:640px){
  .wrap{padding-left:16px; padding-right:16px}
  h1{font-size:32px; letter-spacing:.04em}
  .install{gap:14px; padding:18px}
  .install .bigbtn{width:100%; text-align:center}
  .toolrow{flex-direction:column}
  .toolrow .bigbtn{width:100%; text-align:center; padding:15px 18px}
  .drop{padding:26px 14px}
  .dropbig{font-size:15px}
  .dropfiles li{justify-content:flex-start; text-align:left; flex-wrap:wrap}
  .body{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,1fr)}
  .tab{min-height:44px}
  .src{min-height:44px}
  .how summary{padding:15px 16px; min-height:44px}
}
@media (hover:none){
  /* Hover styling that sticks after a tap reads as a stuck button. */
  .drop:hover{border-color:var(--line); background:transparent}
  .bigbtn:hover{background:var(--lift); box-shadow:0 0 24px rgba(53,224,240,.16)}
}
"""


def main():
    src = io.open(TEMPLATE, encoding="utf-8").read()

    src = src.replace("const TRADES = __DATA__;",
                      "// Filled in from browser storage, or from the files you drop.\n"
                      "var TRADES = [];\nvar START = null;")
    # `const` at the top of a classic script lands in the global lexical scope,
    # which a module can read but cannot see through `window`. `var` puts it on
    # the window object, which is how the two halves of the page talk.
    src = src.replace("const FLAG_TEXT = __FLAGTEXT__;",
                      "var FLAG_TEXT = " + json.dumps(FLAG_TEXT) + ";")
    if "__FLAGTEXT__" in src:
        raise SystemExit("the FLAG_TEXT line moved; check the template")
    src = src.replace("__NTRADES__", '<span id="ntrades">0</span>')
    src = src.replace("__HEAD__", '<div class="srcrow" id="srcrow"></div>'
                                  '<div id="srcpanes"></div>')
    src = src.replace("__PAT__", '<div id="patwrap"></div>')
    src = src.replace("__STAND__", "")

    # Directly under the header, above everything else on the page.
    marker = "</header>\n"
    if marker not in src:
        raise SystemExit("the header moved; check the template")
    src = src.replace(marker, marker + INSTALL, 1)
    src = src.replace("__LEARN__", PRIVACY + SETTINGS)

    src, n = REPLAY_SECTION.subn("", src)
    if n != 1:
        raise SystemExit("the Bar Replay section moved; check the template")

    # The template's own START comes from the server. Here it is stored.
    src = re.sub(r"^const START = .*$", "", src, flags=re.M)

    # The import handler posts to a server that does not exist here. Everything
    # from the marker to the end of the script is replaced with the local one.
    cut = src.index("/* ---------------------------------------------------------------- import */")
    end = src.rindex("</script>")
    src = src[:cut] + src[end:]

    app = io.open(os.path.join(DOCS, "app.js"), encoding="utf-8").read()
    src = src.replace("</script>", "</script>\n<script type=\"module\">\n"
                      + app + "\n</script>", 1)

    src = src.replace("</style>", EXTRA_CSS + "</style>", 1)
    src = HEAD_TAGS + src
    io.open(OUT, "w", encoding="utf-8").write(src)
    print(f"{len(src):,} chars -> {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
