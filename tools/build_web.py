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

# The desktop template links to a separate replay page. Here the replay is a
# tab in the same app, so that section is cut and rebuilt in sections.html.
REPLAY_SECTION = re.compile(
    r'<section>\s*<h2>Bar Replay</h2>.*?</section>', re.S)

# One app, four tabs. The diary is the reason to open it, so it comes first
# and it is what a fresh install lands on.
TABS = [("home", "Home"), ("diary", "Diary"), ("demo", "Demo"),
        ("replay", "Replay"), ("videos", "Videos"), ("system", "System"),
        ("learn", "Learn")]

NAV = ('<nav class="tabs2" role="tablist" aria-label="Sections">'
       + "".join(f'<button class="tb" role="tab" data-go="{k}" '
                 f'aria-selected="{"true" if k == "home" else "false"}">'
                 f'{label}</button>' for k, label in TABS)
       + "</nav>\n")

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

# The chart is the reason the diary exists, so it leads the tab and gets the
# whole width. It used to be a small static picture below a screenful of
# statistics, which is exactly backwards.
# The app shell.
#
# A chart wants the whole screen; a lesson wants a readable column. So there
# are two layouts, not one compromise between them. The working tabs run
# edge to edge and never scroll the page, the way a platform does. The
# reading tabs keep a measured column, because 1600 pixels of prose is
# unreadable and calling it "full bleed" does not fix that.
APPBAR = """<div class="appbar">
  <span class="brand">Traders&nbsp;Diary</span>
  __NAV__
  <span class="appmeta" id="appmeta">no trades</span>
</div>
"""


TRADEVIEW = """<div class="ws">
  <div class="wsrail" role="group" aria-label="Which trades" id="dfilter">
    <button class="rbtn2" data-f="all" aria-pressed="true" title="All trades">All</button>
    <button class="rbtn2" data-f="won" aria-pressed="false" title="Winners only">W</button>
    <button class="rbtn2" data-f="lost" aria-pressed="false" title="Losers only">L</button>
    <span class="railgap"></span>
    <button class="rbtn2" id="dzin2" title="Zoom in">+</button>
    <button class="rbtn2" id="dzout2" title="Zoom out">&minus;</button>
    <button class="rbtn2" id="dfit2" title="Fit the trade">Fit</button>
  </div>

  <div class="wsmain">
    <div class="wstop">
      <button class="ptool" id="dprev" title="Previous trade">&#9664;</button>
      <button class="ptool" id="dnext" title="Next trade">&#9654;</button>
      <div class="chead" id="dhead"></div>
      <div class="pgrow" id="dohlc2"></div>
    </div>
    <div class="wsstage">
      <canvas id="dchart"></canvas>
      <p class="nobars" id="dnobars" hidden>No candles were stored for this
      trade. The published bars reach back about ten days, so import each
      session while it is recent. The numbers are exact either way.</p>
    </div>
    <div class="dstrip" id="dtabs" role="tablist" aria-label="Your trades"></div>
    <div class="wsfoot"><div class="values" id="dvalues"></div></div>
  </div>

  <div class="wspanel">
    <div class="pblock">
      <h4>What happened</h4>
      <div class="flags" id="dflags"></div>
      <p class="note" id="dnote"></p>
    </div>
    <div class="pblock">
      <h4>What you were thinking</h4>
      <div class="mynote">
        <textarea id="mynotebox" disabled
          placeholder="Why you took it, what you saw, what you would do differently. Saved on this device as you type."></textarea>
        <p class="mysaved" id="mynotesaved"></p>
      </div>
    </div>
    <div class="pblock">
      <h4>Stop moves</h4>
      <div class="trail" id="dtrail"></div>
    </div>
    <div class="pblock" id="dvidblock" hidden>
      <h4>Watch it back</h4>
      <button class="bigbtn" id="dvid">Play this trade</button>
    </div>
    <div class="pblock">
      <h4>Import a session</h4>
      <div class="drop" id="drop" tabindex="0" role="button"
           aria-label="Choose your TradingView export files">
        <input type="file" id="pick" multiple accept=".csv" hidden>
        <p class="dropbig">Add exports</p>
        <p class="dropsub">All six at once</p>
        <ul class="dropfiles" id="dropfiles"></ul>
        <div class="dropbar" id="dropbar" hidden><i></i></div>
      </div>
      <p class="dropmsg" id="dropmsg" hidden></p>
    </div>
  </div>
</div>
"""



PRIVACY = """<section>
  <h2>Where your trades live</h2>
  <p class="lead">Nowhere but this device. The files you drop are read in the
  browser, and the record is kept in this browser's own storage. Nothing is
  uploaded, there is no account, and no one else can see it, including whoever
  made this. That also means clearing your browser data clears the diary, so
  keep a backup.</p>
  <p class="lead">One exception, and it is worth knowing about. This copy ships
  with a starting record already in it, so a fresh install opens with something
  to look at instead of an empty screen. That record is part of the published
  site, which is public, so anyone with the link can read those trades. Press
  <b>Erase everything</b> and it is gone for good on this device: it is never
  put back. Everything you import after that is yours alone.</p>
  <div class="toolrow">
    <button class="bigbtn" id="save">Save a backup file</button>
    <button class="bigbtn ghost" id="load">Restore from a backup</button>
    <button class="bigbtn ghost" id="wipe">Erase everything</button>
    <input type="file" id="loadpick" accept=".json" hidden>
  </div>
  <p class="lead" id="storeline"></p>
</section>

<section>
  <h2>Your PIN</h2>
  <p class="lead">Your PIN is what this journal is kept under. Everything you
  import belongs to it, and it <b>encrypts</b> the record, so what is left in
  this browser is a blob that means nothing without it.</p>
  <p class="lead">Somebody else can pick up this device, open the app, tap
  <b>Start a new journal</b> and set their own PIN. They get a clean journal
  and see nothing of yours, and you see nothing of theirs. That is the whole
  mechanism: no accounts, nothing shared, nothing on a server.</p>
  <p class="lead">The cost is real and there is no way around it: <b>there is
  no reset.</b> Nobody has a spare key. Forget the PIN and that journal is
  gone, and a backup file is the only way back, so keep one.</p>
  <div class="toolrow" id="lockrow">
    <button class="bigbtn" id="setlock">Change your PIN</button>
    <button class="bigbtn ghost" id="locknow">Lock and switch journal</button>
  </div>
  <p class="lead" id="lockstate"></p>

  <!-- A real form rather than the browser's popups. A home-screen app on an
       iPhone can swallow prompt() entirely, and a passcode you tap Set on and
       nothing happens is worse than no passcode at all. -->
  <div class="setcard hud" id="setpanel" hidden>
    <h3 id="settitle">Change your PIN</h3>
    <p class="lead">Four digits or more. This becomes the PIN that opens this
    journal on this device, and it does not change your other devices.</p>
    <form id="setform" autocomplete="off">
      <label class="rpl" for="pin1">New PIN
        <input type="password" id="pin1" autocomplete="new-password"
               inputmode="numeric" minlength="4" required></label>
      <p class="strength" id="strength" hidden></p>
      <label class="rpl" for="pin2">Type it again
        <input type="password" id="pin2" autocomplete="new-password"
               minlength="4" required></label>
      <label class="ack"><input type="checkbox" id="ack">
        I understand there is <b>no reset</b>. If I forget this, the record on
        this device is gone and only a backup file can bring it back.</label>
      <div class="toolrow">
        <button class="bigbtn" type="submit" id="setgo">Change it</button>
        <button class="bigbtn ghost" type="button" id="setbackup">Save a backup first</button>
        <button class="bigbtn ghost" type="button" id="setcancel">Cancel</button>
      </div>
    </form>
    <p class="lockmsg" id="setmsg" hidden></p>
  </div>
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
  <h2>Clocks</h2>
  <p class="lead">Two different things, on purpose. TradingView stamps its
  exports in your own local time and never says which, so the diary has to be
  told, or a stop taken seconds before a data release lands in the wrong
  minute. What you read on a chart is a separate question, and the answer is
  almost always New York: the open is 09:30 there, the releases are 08:30
  there, and that is what your TradingView charts print.</p>
  <div class="setrow">
    <label for="tz">Your exports are stamped in</label>
    <select id="tz"></select>
  </div>
  <div class="setrow">
    <label for="showtz">Show every time in</label>
    <select id="showtz">
      <option value="America/New_York">New York, like TradingView</option>
      <option value="device">This device</option>
    </select>
  </div>
</section>
"""


# Styles for the sections this build adds, plus the phone pass. Kept here
# rather than in the shared template because the desktop project has neither
# these controls nor a phone to run on.
EXTRA_CSS = """
/* tab navigation */
.tabs2{
  display:flex; gap:6px; margin:0 0 30px; overflow-x:auto;
  border-bottom:1px solid var(--line); padding-bottom:0;
  scrollbar-width:none;
}
.tabs2::-webkit-scrollbar{display:none}
.tb{
  flex:none; background:none; border:none; border-bottom:2px solid transparent;
  color:var(--muted); cursor:pointer; padding:12px 16px; min-height:46px;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:700; font-size:12px;
  letter-spacing:.04em; text-transform:uppercase;
  transition:color .14s, border-color .14s;
}
.tb:hover{color:var(--text)}
.tb[aria-selected="true"]{
  color:var(--accent); border-bottom-color:var(--accent);
}
.tb:focus-visible{outline:2px solid var(--accent); outline-offset:-2px}

/* replay */
.rp{padding:16px}
.rpbar{display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; margin-bottom:14px}
.rpgroup{display:flex; flex-direction:column; gap:6px}
.rpl{
  color:var(--muted); font-size:11px; text-transform:uppercase;
  letter-spacing:.02em; display:flex; flex-direction:column; gap:6px;
}
.rpbar select, .rpbar input, .ticket input{
  background:var(--lift); color:var(--text); border:1px solid var(--line);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:14px; padding:10px 12px;
  min-height:44px; width:100%;
}
.rpbar select:focus-visible, .rpbar input:focus-visible, .ticket input:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px
}
.tfrow{display:flex; gap:4px}
.tfb{
  background:var(--raised); border:1px solid var(--line); color:var(--muted);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:600; font-size:12px;
  padding:0 13px; min-height:44px; cursor:pointer;
}
/* A quiet pill until it is the one you are on, which is how TradingView
   marks the live timeframe. */
.tfb{border-color:transparent; border-radius:4px}
.tfb:hover{background:var(--lift); color:var(--text)}
.tfb[aria-pressed="true"]{
  background:var(--accent-dim); border-color:transparent;
  color:var(--accent); font-weight:600;
}
.rpread{
  display:flex; flex-wrap:wrap; gap:16px; padding:10px 0 12px;
  border-top:1px solid var(--line-soft); border-bottom:1px solid var(--line-soft);
  margin-bottom:12px; font-size:12.5px; color:var(--muted);
}
.rv b{color:var(--text); font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif}
#rc{width:100%; display:block}
.rpctl{display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-top:12px}
.rbtn{
  background:var(--raised); border:1px solid var(--line); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:13px; padding:0 15px;
  min-height:44px; cursor:pointer;
}
.rbtn:hover{border-color:var(--accent)}
.rbtn.ghostb{color:var(--muted); margin-left:auto}
.rpsp{flex:1}
.deck{display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px}
.deck h3{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.02em; text-transform:uppercase; margin:0 0 14px;
}
.sides{display:flex; gap:9px; margin-bottom:14px}
.sbtn{
  flex:1; min-height:48px; cursor:pointer; border:1px solid;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:700; font-size:13px;
  letter-spacing:.11em; text-transform:uppercase; background:var(--raised);
}
.sbtn.buy{border-color:var(--win-faded); color:var(--win)}
.sbtn.sell{border-color:var(--loss-faded); color:var(--loss)}
.sbtn:disabled{opacity:.35; cursor:not-allowed}
.sbtn.buy:not(:disabled):hover{background:var(--win-zone)}
.sbtn.sell:not(:disabled):hover{background:var(--loss-zone)}
.ticket{display:grid; grid-template-columns:1fr 1fr; gap:11px; margin-bottom:12px}
.ticket label:first-child{grid-column:1 / -1}
.risknote{
  margin:0 0 10px; padding:11px 13px; background:var(--lift);
  border-left:2px solid var(--accent); font-size:13.5px;
}
.rplist{list-style:none; padding:0; margin:14px 0 0; display:grid; gap:5px}
.rpi{
  display:grid; grid-template-columns:1fr auto auto auto; gap:12px;
  align-items:baseline; padding:9px 12px; background:var(--raised);
  border:1px solid var(--line); font-size:12.5px;
}
.rpr,.rpm{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif}
.rpt{color:var(--faint); font-size:11px; text-transform:uppercase}

/* system */
.sysbook{margin-bottom:16px}
.warnnote{color:var(--loss); margin-top:12px}

/* learn */
.steps{list-style:none; counter-reset:st; padding:0; margin:0; display:grid; gap:12px}
.steps li{
  counter-increment:st; position:relative; padding:18px 20px 18px 62px;
  background:var(--raised); border:1px solid var(--line);
}
.steps li::before{
  content:counter(st); position:absolute; left:20px; top:17px;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:900; font-size:20px;
  color:var(--accent);
}
.steps h3{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.02em; text-transform:uppercase; margin:0 0 7px;
}
.steps p{margin:0; color:var(--muted); font-size:14px; line-height:1.65}
.lessons{list-style:none; padding:0; margin:0; display:grid; gap:10px}
.lessons li{
  display:grid; grid-template-columns:auto 1fr; gap:15px; align-items:baseline;
  padding:15px 18px; background:var(--raised);
  border-left:2px solid var(--loss-faded);
}
.lessons .ln{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:20px; color:var(--accent);
  font-variant-numeric:tabular-nums;
}
.lessons .lt{font-size:14px; line-height:1.65}
.lessons .lt b{display:block; margin-bottom:4px; color:var(--text)}
.lessons .lt span{color:var(--muted)}

/* your own note on a trade */
.mynote{margin-top:16px; border-top:1px solid var(--line-soft); padding-top:14px}
.mynote label{
  display:block; color:var(--muted); font-size:11px; text-transform:uppercase;
  letter-spacing:.02em; margin-bottom:7px;
}
.mynote textarea{
  width:100%; min-height:84px; resize:vertical; background:var(--lift);
  color:var(--text); border:1px solid var(--line); padding:11px 13px;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:14px; line-height:1.6;
}
.mynote textarea:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.mysaved{color:var(--faint); font-size:11.5px; margin:7px 0 0; min-height:16px}

#updbar{
  position:fixed; left:16px; right:16px; z-index:50;
  bottom:calc(16px + env(safe-area-inset-bottom, 0px));
  display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  background:var(--lift); border:1px solid var(--accent); padding:14px 18px;
  box-shadow:var(--shadow); border-radius:6px;
}
#updbar span{flex:1 1 160px; font-size:13.5px; line-height:1.45}
#updbar .bigbtn{padding:10px 18px; flex:none}
@media (max-width:640px){
  /* Stacked, but not a full screen of it. Left to stretch, a notice with two
     buttons filled half the phone, which is a lot of screen to give a
     sentence saying nothing has to be done. */
  #updbar{
    flex-direction:row; align-items:center; gap:10px; padding:11px 13px;
    left:10px; right:10px;
  }
  #updbar span{flex:1 1 100%; font-size:13px}
  #updbar .bigbtn{padding:9px 14px; font-size:11px}
  #updbar .instx{padding:9px 6px}
}

/* the video library */
.vgroup{margin-top:24px}
.vgroup h3{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.02em; text-transform:uppercase; color:var(--accent);
  margin:0 0 10px;
}
.vlist{display:grid; gap:7px; grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.vcut{
  display:flex; align-items:center; gap:11px; text-align:left; cursor:pointer;
  background:var(--raised); border:1px solid var(--line); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; padding:12px 14px; min-height:52px;
}
.vcut:hover{border-color:var(--accent); background:var(--lift)}
.vcut:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.vcut .vplay{
  flex:none; width:0; height:0; border-left:11px solid var(--accent);
  border-top:7px solid transparent; border-bottom:7px solid transparent;
}
.vcut .vn{flex:1; font-size:13.5px; line-height:1.35}
.vcut .vs{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:11px; color:var(--faint);
}
.vcut.win{border-left:2px solid var(--win)}
.vcut.loss{border-left:2px solid var(--loss)}
.vplayer{
  /* Dark on purpose, and the only dark surface left. A white surround
     round moving footage is glare, and every video player anyone has used
     is dark for that reason. */
  position:fixed; inset:0; z-index:70; background:rgba(19,23,34,.97);
  display:flex; flex-direction:column; gap:12px;
  padding:calc(18px + env(safe-area-inset-top, 0px)) 18px
          calc(18px + env(safe-area-inset-bottom, 0px));
}
.vhead{
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.02em; text-transform:uppercase;
}
.vplayer video{
  flex:1; min-height:0; width:100%; background:#000; border:1px solid var(--line);
}

/* ------------------------------------------------------------- app shell */
/* A platform is a fixed frame with one scrolling area inside it, not a long
   page you fall down. The working tabs get exactly that; the reading tabs
   keep a column you can actually read. */
html,body{height:100%}
body{overflow:hidden}
/* The shell, kept out from under the phone's own furniture.
 *
 * The page is told to cover the whole screen, notch included, which is what
 * makes an installed app look like an app rather than a web page in a frame.
 * The price of that is having to say where the screen actually starts. Left
 * unsaid, the bar ran under the status bar: the clock sat on top of the name
 * and the tab strip was against the very top edge, too high to hit.
 */
.app{
  display:flex; flex-direction:column; min-height:0;
  height:100dvh;
  padding-top:env(safe-area-inset-top, 0px);
  padding-left:env(safe-area-inset-left, 0px);
  padding-right:env(safe-area-inset-right, 0px);
  box-sizing:border-box;
}

.appbar{
  flex:none; display:flex; align-items:center; gap:18px;
  background:var(--raised); border-bottom:1px solid var(--line);
  padding:0 14px; height:46px; overflow:hidden;
}
.brand{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:900; font-size:13px;
  letter-spacing:.04em; text-transform:uppercase; color:var(--text);
  white-space:nowrap; flex:none;
}
.appmeta{
  margin-left:auto; flex:none; font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;
  font-size:11.5px; color:var(--muted); white-space:nowrap;
}
.appmeta b{color:var(--text)}
.appmeta .win{color:var(--win)} .appmeta .loss{color:var(--loss)}

.appbody{flex:1; min-height:0; position:relative}
.tabpane{position:absolute; inset:0; display:flex; flex-direction:column; min-height:0}
.tabpane[hidden]{display:none !important}
/* Reading tabs scroll their own column; working tabs never scroll the page. */
.tabpane.reading{overflow-y:auto; overflow-x:hidden}
.reading .col{
  max-width:1000px; margin:0 auto;
  padding:30px 22px calc(80px + env(safe-area-inset-bottom, 0px));
}

/* the workspace: rail, stage, panel, status */
.ws{display:grid; grid-template-columns:46px minmax(0,1fr) 292px; flex:1; min-height:0}
.wsrail{
  display:flex; flex-direction:column; gap:4px; padding:8px 5px;
  background:var(--raised); border-right:1px solid var(--line);
}
.rbtn2{
  width:36px; height:36px; display:flex; align-items:center;
  justify-content:center; background:none; border:1px solid transparent;
  color:var(--muted); cursor:pointer; font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;
  font-size:12px; font-weight:600; border-radius:2px;
}
.rbtn2{border-radius:4px}
.rbtn2:hover{color:var(--text); background:var(--lift)}
.rbtn2[aria-pressed="true"]{color:var(--accent); background:var(--accent-dim)}
.rbtn2:focus-visible{outline:2px solid var(--accent); outline-offset:-1px}
.railgap{flex:1}
/* The drawing rail, the way TradingView has it: a column of icon buttons down
   the left edge, the armed one lit, a hairline between the groups. */
.drawrail{display:flex; flex-direction:column; gap:2px}
.raildiv{height:1px; background:var(--line); margin:5px 3px}
.rtool{
  width:36px; height:36px; display:grid; place-items:center; cursor:pointer;
  background:none; border:1px solid transparent; border-radius:4px;
  color:var(--muted);
}
.rtool svg{width:17px; height:17px; fill:none; stroke:currentColor;
  stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round}
.rtool:hover{background:var(--lift); color:var(--text)}
.rtool[aria-pressed="true"]{background:var(--accent-dim); color:var(--accent)}
.rtool:focus-visible{outline:2px solid var(--accent); outline-offset:-1px}
.rbtn2:disabled{opacity:.35; cursor:default}
.rbtn2:disabled:hover{background:none; color:var(--muted)}
@media (max-width:900px){ .rtool{width:44px; height:44px} }

.wsmain{display:flex; flex-direction:column; min-width:0; min-height:0}
.wstop{
  flex:none; display:flex; align-items:center; gap:12px; flex-wrap:nowrap;
  padding:0 12px; height:40px; border-bottom:1px solid var(--line);
  background:var(--raised); overflow:hidden;
}
.wsstage{flex:1; min-height:0; position:relative; background:var(--ground)}
.wsstage canvas{position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none}
.wsfoot{
  flex:none; display:flex; align-items:center; gap:14px; padding:0 12px;
  height:34px; border-top:1px solid var(--line); background:var(--raised);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:11px; color:var(--muted);
  overflow-x:auto; white-space:nowrap; scrollbar-width:none;
}
.wsfoot::-webkit-scrollbar{display:none}

.wspanel{
  border-left:1px solid var(--line); background:var(--raised);
  display:flex; flex-direction:column; min-height:0; overflow-y:auto;
}
.pblock{border-bottom:1px solid var(--line); padding:13px 14px}
.pblock h4{
  margin:0 0 9px; font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800;
  font-size:10.5px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--muted);
}
.pblock:last-child{border-bottom:none}

@media (max-width:900px){
  /* No room for a rail and a panel beside a chart. The panel drops under it
     and the rail becomes a row, which is what every platform does on a phone. */
  .ws{
    display:flex; flex-direction:column; min-height:0;
  }
  .wsrail{
    flex:none; flex-direction:row; border-right:none; align-items:center;
    border-bottom:1px solid var(--line); overflow-x:auto; scrollbar-width:none;
  }
  .wsrail::-webkit-scrollbar{display:none}
  /* The drawing tools are a column on a desktop and have to become part of
     the same row on a phone. Left as a column they were one very tall item
     inside a horizontal rail, which took most of the screen and pushed the
     chart off the bottom. */
  .drawrail{flex-direction:row; flex:none}
  .raildiv{height:24px; width:1px; margin:0 4px; flex:none}
  .railgap{display:none}
  .wsmain{flex:none}
  .wsstage{height:46vh; min-height:260px}
  .wspanel{
    flex:none; border-left:none; border-top:1px solid var(--line);
    overflow:visible;
  }
  /* The working tabs scroll on a phone. There is no room to hold a chart, an
     order ticket and an account list on one screen, and pretending otherwise
     is how a control ends up off the edge where nobody can reach it. */
  .tabpane{overflow-y:auto}

  /* Controls wrap rather than scroll sideways. A row that scrolls hides its
     last control, and the last control here is Start: unreachable without
     knowing to swipe a bar that gives no sign it moves. */
  .wstop{height:auto; padding:8px 10px; gap:7px; flex-wrap:wrap; overflow:visible}
  .wstop > *{flex:0 1 auto}
  .psel, .pbtn{flex:1 1 auto; min-width:0}
  #rdate{flex:2 1 130px}
  .pgrow{flex:1 1 100%; overflow:visible}
  /* The status line is information, so it wraps instead of being clipped. */
  .wsfoot{height:auto; padding:8px 12px; white-space:normal; line-height:1.5}

  /* Two rows in the bar: identity and count, then the tabs, scrolling. */
  .appbar{
    height:auto; flex-wrap:wrap; padding:10px 14px 0; gap:0 12px;
    overflow:visible;
  }
  /* Readable rather than merely present. At 12px in a bar squeezed under a
     status bar the name was neither. */
  .brand{font-size:14px; letter-spacing:.02em; order:1}
  .appmeta{order:2; margin-left:auto; font-size:12px}
  .appbar .tabs2{
    order:3; flex:1 0 100%; margin:8px -14px 0; padding:0 14px;
    border-bottom:none;
  }
  /* 46px of target, and the text sitting in the middle of it rather than at
     the top where a thumb has to stretch for it. */
  .tb{padding:13px 14px; font-size:12px; min-height:46px}
}


/* the watchlist */
.wlist{display:flex; flex-direction:column; gap:2px}
.wl{
  display:grid; grid-template-columns:auto 1fr auto; gap:2px 9px;
  align-items:baseline; text-align:left; cursor:pointer; padding:7px 8px;
  background:none; border:1px solid transparent; border-left:2px solid transparent;
  color:var(--muted); font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;
}
.wl:hover{background:var(--lift); color:var(--text)}
.wl.on{border-left-color:var(--accent); background:var(--lift); color:var(--text)}
.wl:focus-visible{outline:2px solid var(--accent); outline-offset:-1px}
.wls{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:11.5px;
  letter-spacing:.02em; color:var(--text);
}
.wln{font-size:11px; color:var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.wlp{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:12px; color:var(--text);
  font-variant-numeric:tabular-nums;
}
.wlc{
  grid-column:3; font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:10.5px;
  font-variant-numeric:tabular-nums; text-align:right;
}

/* the trade browser */
.dstrip{
  display:flex; gap:5px; overflow-x:auto; scrollbar-width:none;
  background:var(--raised); border:1px solid var(--line);
  border-top:none; border-bottom:none; padding:8px;
}
.dstrip::-webkit-scrollbar{display:none}
.dtab{
  flex:none; display:flex; flex-direction:column; gap:1px; cursor:pointer;
  background:var(--lift); border:1px solid var(--line); padding:7px 11px;
  color:var(--muted); font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; min-height:52px;
  border-left-width:2px; text-align:left;
}
.dtab.win{border-left-color:var(--win)}
.dtab.loss{border-left-color:var(--loss)}
.dtab.on{background:var(--raised); border-color:var(--accent); color:var(--text)}
.dtab:hover{color:var(--text)}
.dtab:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.dtn{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:10px; color:var(--faint)}
.dts{font-size:12px; white-space:nowrap}
.dtr{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:11px}
.dtab.win .dtr{color:var(--win)}
.dtab.loss .dtr{color:var(--loss)}
.dfn{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; color:var(--accent); margin-left:5px}
.nobars{
  position:absolute; left:10%; right:10%; top:42%; text-align:center;
  color:var(--muted); font-size:13px; line-height:1.6;
}
#tradeview .values{
  display:flex; flex-wrap:wrap; background:var(--raised);
  border:1px solid var(--line); border-top:none; margin:0;
}
.dval{
  display:flex; flex-direction:column; gap:2px; padding:10px 16px;
  border-right:1px solid var(--line); flex:1 1 130px;
}
.dvk{
  color:var(--muted); font-size:10px; text-transform:uppercase;
  letter-spacing:.02em;
}
.dvv{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:15px}
.dvv small{display:block; color:var(--faint); font-size:10.5px; margin-top:1px}
.dvv.win{color:var(--win)} .dvv.loss{color:var(--loss)}
#tradeview .chead{
  background:var(--raised); border:1px solid var(--line); border-top:none;
}
.tstep{
  display:flex; gap:12px; align-items:baseline; padding:6px 0;
  border-bottom:1px solid var(--line-soft); font-size:12.5px;
}
.tstep .tt{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; color:var(--muted)}
.tstep .tp{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; color:var(--text)}
.tstep .tk{color:var(--accent); font-size:11px; text-transform:uppercase}
.tstep .tf{margin-left:auto; color:var(--faint); font-size:11px}

/* The platform surface. A chart people work on wants to be the biggest thing
   on screen with its controls floating over it, not a small box under three
   paragraphs. Everything here exists to get out of the chart's way. */
.platform{margin-bottom:34px}
.pbar{
  display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  background:var(--raised); border:1px solid var(--line); border-bottom:none;
  padding:9px 12px;
}
.pgroup{display:flex; align-items:center; gap:8px; min-width:0}
.pgrow{flex:1 1 auto; overflow:hidden}
.psel{
  background:var(--lift); color:var(--text); border:1px solid var(--line);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:12.5px; padding:8px 10px;
  min-height:38px;
}
.psel:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.pbtn{
  background:var(--lift); border:1px solid var(--line); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:600; font-size:12px;
  text-transform:uppercase; letter-spacing:.02em; padding:9px 14px;
  min-height:38px; cursor:pointer;
}
/* The one solid button on the screen, so it is obvious which control
   starts the thing you came here to do. */
.pbtn{border-radius:4px}
.pbtn.go{background:var(--accent); border-color:var(--accent); color:#FFF}
.pbtn.go:hover{background:#1E53E5; border-color:#1E53E5}
.pbtn:hover{background:var(--lift)}

/* The cut tool. It used to be a scissors glyph in the left rail with no label,
   which is the same as not having it: nobody found it. It sits in the toolbar
   now, named, and lights up while it is armed.

   Called cuttool and not cut: the template already owns .cut for the video
   clip buttons, and those reset each other's pressed state on click, which
   would have reached in and un-armed this one. */
/* flex:none because the toolbar is a nowrap flex row that will happily
   squeeze a button below its content and stack the icon over the word. */
.pbtn.cuttool{
  display:inline-flex; flex-direction:row; align-items:center; gap:7px;
  white-space:nowrap; flex:none; min-width:max-content; padding:9px 15px;
  line-height:1;
}
.pbtn.go{flex:none}
/* The zone the times on screen are in, said once beside them rather than
   assumed. EDT and EST are not the same clock. */
.chead .when i{
  font-style:normal; color:var(--accent); font-size:10px;
  letter-spacing:.02em; margin-left:7px; opacity:.85;
}
.pbtn.cuttool svg{
  flex:none; width:15px; height:15px; fill:none; stroke:currentColor;
  stroke-width:1.8; stroke-linecap:round;
}
.pbtn.cuttool[aria-pressed="true"]{
  background:var(--accent); border-color:var(--accent); color:#04121A;
}
.cuthint{
  position:absolute; top:12px; left:50%; transform:translateX(-50%); z-index:3;
  background:var(--accent); color:#04121A; padding:8px 15px; max-width:88%;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:600; font-size:12px;
  letter-spacing:.02em; text-transform:uppercase; text-align:center;
  pointer-events:none;
}

/* The OHLC readout that follows the crosshair, the way a chart names what is
   under the cursor instead of making you guess. */
.pohlc{
  display:flex; gap:12px; font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;
  font-size:11.5px; color:var(--muted); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;
}
.pohlc b{color:var(--text); font-weight:500}
.pohlc .up{color:var(--candle-up)} .pohlc .dn{color:var(--candle-dn)}
.pstale{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:11.5px; color:var(--muted);
  white-space:nowrap;
}
.pstale .old{color:var(--loss)}

.pstage{
  position:relative; background:var(--ground);
  border:1px solid var(--line); overflow:hidden;
}
.pstage canvas{
  display:block; width:100%; height:clamp(340px, 56vh, 620px);
  touch-action:none;
}

.ptools{
  position:absolute; top:10px; left:10px; display:flex; gap:5px; z-index:2;
}
.ptransport{
  position:absolute; bottom:10px; left:10px; right:10px;
  display:flex; gap:5px; align-items:center; z-index:2;
}
.pspacer{flex:1}
.ptool{
  background:var(--raised); border:1px solid var(--line); border-radius:4px;
  box-shadow:var(--shadow);
  color:var(--muted); font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:600;
  font-size:11.5px; letter-spacing:.02em; padding:0 11px; min-width:38px;
  min-height:38px; cursor:pointer;
}
.ptool:hover{color:var(--text); border-color:var(--accent); background:var(--lift)}
.ptool[aria-pressed="true"]{color:var(--accent); border-color:var(--accent)}
.ptool:focus-visible{outline:2px solid var(--accent); outline-offset:1px}

/* The order ticket, floating on the chart like a platform's. The two big
   coloured buttons carry the price, so what you would get is on the button
   you are about to press. */
.pticket{
  position:absolute; top:10px; right:10px; width:206px; z-index:2;
  background:var(--raised); border:1px solid var(--line); padding:11px;
  border-radius:6px; box-shadow:var(--shadow);
}
.tq{display:grid; grid-template-columns:auto 1fr; gap:6px 8px; align-items:center}
.tq label{
  color:var(--muted); font-size:10px; text-transform:uppercase;
  letter-spacing:.02em;
}
.tq input{
  background:var(--ground); border:1px solid var(--line); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:12.5px; padding:6px 7px;
  width:100%; min-height:34px;
}
.tq input:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.tbtns{display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:9px}
.tbuy,.tsell{
  border:none; cursor:pointer; padding:9px 4px; min-height:50px;
  display:flex; flex-direction:column; align-items:center; gap:1px;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; color:#04120B;
}
.tbuy{background:var(--win)} .tsell{background:var(--loss); color:#1A0407}
.tbuy b,.tsell b{font-size:12.5px; text-transform:uppercase; letter-spacing:.02em}
.tbuy span,.tsell span{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:11px; opacity:.82}
.tbuy:hover{filter:brightness(1.12)} .tsell:hover{filter:brightness(1.12)}
.tbuy:disabled,.tsell:disabled{opacity:.3; cursor:not-allowed; filter:none}
.tbuy:focus-visible,.tsell:focus-visible{outline:2px solid var(--text); outline-offset:2px}
.tflat{
  width:100%; margin-top:6px; background:var(--lift); border:1px solid var(--line);
  color:var(--text); font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:11.5px;
  text-transform:uppercase; letter-spacing:.02em; padding:9px; min-height:38px;
  cursor:pointer;
}
.tflat:hover{border-color:var(--accent)}
.trisk{
  margin:9px 0 0; font-size:11px; line-height:1.5; color:var(--muted);
}
.trisk b{font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif}
.rrwarn{display:block; margin-top:4px; color:var(--loss); font-weight:600}
.okmove{display:block; margin-top:4px; color:var(--win); font-weight:600}
.pstatus{
  margin:0; background:var(--raised); border:1px solid var(--line);
  border-top:none; padding:9px 12px; color:var(--muted); font-size:12.5px;
}

@media (max-width:760px){
  /* On a phone the ticket cannot float over the chart without covering it. */
  .pticket{
    position:static; width:auto; margin-top:0; border-top:none; background:var(--raised);
  }
  .pstage{overflow:visible}
  .pstage canvas{height:clamp(280px, 46vh, 420px)}
  .ptransport{position:static; margin:10px; flex-wrap:wrap}
  .tbtns{grid-template-columns:1fr 1fr}
  .pbar{gap:9px}
}

/* The dashboard: one face, four figures, six doors, one line of what is on.

   The old version had fourteen tiles all the same size, which is the same as
   having none: nothing led, so nothing was read. */
.hero{margin-bottom:6px}
.hpanel{
  border-radius:8px; position:relative; overflow:hidden; isolation:isolate;
  min-height:clamp(178px, 24vh, 236px);
  background:var(--raised);
  border:1px solid var(--line); padding:24px 26px;
  display:flex; flex-direction:column; justify-content:flex-start;
}
/* The curve runs the full width behind the number rather than sitting in a box
   beside it. isolation on the panel keeps z-index:-1 above the panel's own
   background instead of dropping it behind the page. */
.hpanel canvas{
  position:absolute; inset:0; width:100%; height:100%; display:block; z-index:-1;
}
.hpanel::before{
  content:none;
}
.hpanel::after{
  content:none;
}
.hface{display:flex; flex-direction:column; gap:7px; max-width:min(100%, 620px)}
.hk{
  color:var(--muted); font-size:10px; text-transform:uppercase;
  letter-spacing:.04em; font-weight:600;
}
.hv{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-variant-numeric:tabular-nums;
  font-size:clamp(34px, 5.4vw, 54px); line-height:1.02; letter-spacing:-.01em;
}
.hv.win{color:var(--win); text-shadow:0 0 34px rgba(43,224,138,.3)}
.hv.loss{color:var(--loss); text-shadow:0 0 34px rgba(255,92,110,.28)}
.hsub{color:var(--faint); font-size:12.5px; line-height:1.5}
/* The one action an empty journal has, on the panel that is otherwise
   telling you it is empty. */
.hact{display:block; margin-top:14px}
/* Up in the corner rather than along the bottom, because the bottom is where
   the curve lives and a line of text laid over a rising equity curve is
   unreadable exactly when the curve is doing something worth looking at. */
.hfoot{
  position:absolute; top:17px; right:21px; display:flex; gap:9px;
  align-items:baseline; pointer-events:none;
  color:var(--muted); font-size:9.5px; text-transform:uppercase;
  letter-spacing:.04em; font-weight:600;
}
.hfoot span:last-child{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; color:var(--faint);
  text-transform:none; letter-spacing:0; font-size:11px;
}

/* Four figures, small on purpose. The big number above is the headline; these
   are the footnotes to it, and footnotes do not get headline type. */
.figs{
  display:grid; gap:10px; margin-top:10px;
  grid-template-columns:repeat(auto-fit, minmax(158px, 1fr));
}
.fig{
  border-radius:6px; background:var(--raised); border:1px solid var(--line);
  border-left:2px solid var(--line); padding:12px 14px;
  display:flex; flex-direction:column; gap:3px;
}
.fk{
  color:var(--muted); font-size:9.5px; text-transform:uppercase;
  letter-spacing:.04em; font-weight:600;
}
.fv{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-variant-numeric:tabular-nums;
  font-size:20px; line-height:1.2; letter-spacing:-.01em;
}
.fv.win{color:var(--win)}
.fv.loss{color:var(--loss)}
.fn{color:var(--faint); font-size:11.5px; line-height:1.4}

.dleak{
  margin-top:12px; background:var(--line-soft); border:1px solid var(--line);
  border-left:2px solid var(--loss); padding:15px 18px;
}
.dlt{
  color:var(--loss); font-size:10px; text-transform:uppercase;
  letter-spacing:.04em; font-weight:700;
}
.dleak p{margin:6px 0 0; color:var(--text); font-size:14px; line-height:1.65}
.dleak b{color:var(--loss)}
/* A tested finding is not a warning, so it does not wear the warning
   colour. It sits in the accent, as a fact rather than a telling off. */
.dleak.tested{border-left-color:var(--accent)}
.dleak.tested .dlt{color:var(--accent)}
.dleak.tested b{color:var(--text)}

/* Six doors into the rest of the app, because the tab strip is a row of words
   and a row of words is not somewhere you want to go. */
.jumps{
  display:grid; gap:10px; margin-top:14px;
  grid-template-columns:repeat(auto-fit, minmax(172px, 1fr));
}
.jump{
  border-radius:6px; position:relative; overflow:hidden; display:flex; flex-direction:column;
  gap:7px; text-align:left; cursor:pointer; min-height:126px;
  justify-content:flex-end; padding:16px 17px; color:var(--text);
  background:var(--raised); border:1px solid var(--line);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;
  transition:border-color .16s, background .16s;
}
.jump::after{
  content:""; position:absolute; right:-28%; top:-42%; width:100%; height:100%;
  background:radial-gradient(circle, rgba(41,98,255,.10), transparent 68%);
  opacity:0; transition:opacity .18s; pointer-events:none;
}
.jump svg{
  width:25px; height:25px; margin-bottom:auto; stroke:var(--accent); fill:none;
  stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round;
  transition:transform .16s;
}
.jump b{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:12px;
  letter-spacing:.02em; text-transform:uppercase;
}
.jump span{color:var(--muted); font-size:12px; line-height:1.4}
.jump:hover{border-color:var(--accent); background:var(--lift)}
.jump:hover::after{opacity:1}
.jump:hover svg{transform:translateY(-2px)}
.jump:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
/* Six cards want two rows of three. Left to auto-fit, a wide window puts five
   across and leaves the sixth stranded on a row of its own. */
@media (min-width:860px){
  .jumps{grid-template-columns:repeat(3, minmax(0,1fr))}
}

/* What the market is doing, as lines rather than as tiles. Three facts do not
   need three cards. */
.nowstrip{
  display:grid; gap:1px; margin-top:14px;
  background:var(--line); border:1px solid var(--line);
}
.nrow{
  display:grid; grid-template-columns:92px auto 1fr; align-items:baseline;
  gap:14px; background:var(--raised); padding:12px 16px;
}
.nk{
  color:var(--muted); font-size:9.5px; text-transform:uppercase;
  letter-spacing:.04em; font-weight:600;
}
.nv{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-variant-numeric:tabular-nums;
  font-size:16px; line-height:1.3;
}
.nv.win{color:var(--win)}
.nv.loss{color:var(--loss)}
.nn{color:var(--faint); font-size:12px; line-height:1.4; text-align:right}
@media (max-width:640px){
  .figs{grid-template-columns:repeat(2, minmax(0,1fr))}
  .jumps{grid-template-columns:repeat(2, minmax(0,1fr))}
  .jump{min-height:110px; padding:14px}
  .jump span{font-size:11.5px}
  .nrow{grid-template-columns:auto 1fr; row-gap:3px}
  .nk{grid-column:1 / -1}
}
.more{margin-top:28px; border-top:1px solid var(--line)}
.more>summary{
  cursor:pointer; list-style:none; padding:16px 2px;
  display:flex; align-items:center; gap:11px; color:var(--muted);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:11.5px;
  letter-spacing:.03em; text-transform:uppercase;
}
.more>summary::-webkit-details-marker{display:none}
.more>summary::before{
  content:"+"; display:grid; place-items:center; width:20px; height:20px;
  border:1px solid var(--line); color:var(--accent);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:14px; line-height:1;
}
.more[open]>summary::before{content:"-"}
.more>summary:hover{color:var(--text)}
.more>summary:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.more>summary+*{margin-top:4px}

.install{
  display:flex; align-items:center; gap:18px; flex-wrap:wrap;
  padding:20px 22px; margin-bottom:34px;
}
.insticon{
  flex:none; width:38px; height:38px; border:2px solid var(--accent);
  border-radius:9px; position:relative; box-shadow:var(--shadow);
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
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-weight:800; font-size:14px;
  letter-spacing:.07em; text-transform:uppercase; margin:0 0 5px;
}
.instsub{margin:0; color:var(--muted); font-size:13.5px; line-height:1.6}
.instsub b{color:var(--text)}
.instx{
  background:none; border:none; color:var(--faint); cursor:pointer;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:12px; padding:12px;
  text-transform:uppercase; letter-spacing:.02em; min-height:44px;
}
.instx:hover{color:var(--muted)}
.instx:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
#lockgate{
  position:fixed; inset:0; z-index:60; background:var(--ground);
  display:flex; overflow-y:auto;
  padding:calc(22px + env(safe-area-inset-top, 0px)) 22px
          calc(22px + env(safe-area-inset-bottom, 0px));
}
/* margin:auto rather than align-items:center. Centring a flex item that is
   taller than the box pushes its top off the edge and there is no scrolling
   back to it: on a short screen the title and the button were simply gone.
   An auto margin centres when there is room and gives up when there is not. */
.lockcard{
  background:var(--raised); border:1px solid var(--line); padding:30px 28px;
  border-radius:8px; box-shadow:var(--shadow);
  max-width:420px; width:100%; margin:auto; text-align:center;
}
.lockcard .lockhelp{font-size:12.5px; line-height:1.5; margin:10px 0 0}
.lockcard h2{margin:0 0 10px}
.lockcard h2::before{display:none}
.lockmark{
  width:34px; height:26px; margin:0 auto 18px; border:2px solid var(--accent);
  border-radius:4px; position:relative; box-shadow:var(--shadow);
}
.lockmark::before{
  content:""; position:absolute; left:50%; top:-15px; width:18px; height:16px;
  border:2px solid var(--accent); border-bottom:none;
  border-radius:9px 9px 0 0; transform:translateX(-50%);
}
#lockform{display:flex; flex-direction:column; gap:10px; margin:20px 0 4px}
#lockpin{
  background:var(--lift); border:1px solid var(--line); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:17px; letter-spacing:.2em;
  padding:14px; text-align:center; min-height:50px;
}
#lockpin:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.lockmsg{color:var(--loss); font-size:13.5px; margin:12px 0 0}
.lockhelp{font-size:12.5px; color:var(--faint); margin-top:20px}
.setcard{
  background:var(--raised); border:1px solid var(--line);
  padding:22px; margin-top:16px;
}
.setcard h3{margin:0 0 8px}
#setform{display:flex; flex-direction:column; gap:14px; margin-top:16px}
#setform input[type=password]{
  background:var(--lift); border:1px solid var(--line); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:16px; letter-spacing:.04em;
  padding:13px; min-height:48px;
}
#setform input[type=password]:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px;
}
.strength{
  margin:-4px 0 0; font-size:12.5px; line-height:1.6; color:var(--muted);
  border-left:2px solid var(--line); padding-left:11px;
}
.strength.weak{border-left-color:var(--loss)}
.strength.fair{border-left-color:#E8A33D}
.strength.good{border-left-color:var(--win)}
.strength b{color:var(--text)}
.ack{
  display:flex; gap:11px; align-items:flex-start; color:var(--muted);
  font-size:13px; line-height:1.6; cursor:pointer;
}
.ack input{width:20px; height:20px; margin:2px 0 0; flex:none; accent-color:var(--accent)}
.ack b{color:var(--loss)}
.toolrow{display:flex; flex-wrap:wrap; gap:10px; margin:18px 0 12px}
/* The primary button, solid, the way a light UI marks the one thing it wants
   you to press. It was a pale tint on a white ground, which read as disabled
   next to a ghost button that read as normal. */
.bigbtn{
  background:var(--accent); border-color:var(--accent); color:#FFF;
  border-radius:4px;
}
.bigbtn:hover{background:#1E53E5; border-color:#1E53E5; color:#FFF}
.bigbtn:disabled{opacity:.45; cursor:default}
.bigbtn:disabled:hover{background:var(--accent); border-color:var(--accent)}
.bigbtn.ghost{
  background:transparent; border-color:var(--line); color:var(--muted);
  box-shadow:none;
}
.bigbtn.ghost:hover{color:var(--text)}
.bigbtn.ghost:hover{border-color:var(--accent); color:var(--text); background:var(--raised)}
#wipe:hover{border-color:var(--loss); color:var(--loss)}
.setrow{
  display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:18px;
  background:var(--raised); border:1px solid var(--line); padding:14px 16px;
}
.setrow label{color:var(--muted); font-size:13px}
.setrow select{
  background:var(--lift); color:var(--text); border:1px solid var(--line);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; font-size:14px; padding:9px 12px;
  min-height:44px;
}
.setrow select:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

/* A phone has no pointer to hover with and no room to waste. Every control is
   at least the 44px Apple asks for, and the two-column panes stack. */
@media (max-width:640px){
  .wrap{padding-left:16px; padding-right:16px}
  h1{font-size:32px; letter-spacing:.04em}
  .deck{grid-template-columns:1fr}
  .rpbar{gap:11px}
  .rpgroup{flex:1 1 100%}
  /* 44px is the smallest thing a thumb reliably hits, and .bigbtn's padding
     alone lands just under it. */
  .bigbtn{min-height:48px; display:flex; align-items:center; justify-content:center}
  .rpbar .bigbtn{width:100%}
  .rbtn{flex:1 1 auto}
  .rbtn.ghostb{margin-left:0; flex-basis:100%}
  .rpi{grid-template-columns:1fr auto auto}
  .rpi .rpt{display:none}
  .tb{padding:12px 13px; font-size:11px; letter-spacing:.02em}
  .steps li{padding-left:56px}
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

/* Every control a thumb has to hit clears 44px, the smallest thing a finger
   reliably lands on. Keyed off width rather than (hover:none), because a
   phone-sized window is the case that matters and hover detection is not
   dependable enough to hang a tap target on. */
@media (max-width:900px){
  .rbtn2,.ptool,.pbtn,.psel,.tb,.tq input,.tfb{min-height:44px}
  .rbtn2{min-width:44px}
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

    # The template's static trade browser is replaced wholesale rather than
    # patched, so there is one of it and not two, and it moves to the top of
    # the tab because it is the reason to open the tab at all.
    src, n = re.subn(r'<section>\s*<h2>Trade by trade</h2>.*?</section>',
                     "", src, flags=re.S)
    if n != 1:
        raise SystemExit("the Trade by trade section moved; check the template")
    src = src.replace('<section id="importer">',
                      TRADEVIEW + '<section id="importer">', 1)

    # The shared page script still owns the equity curve and the source picker,
    # but the trade browser is this build's own. pick() becomes pure delegation
    # rather than keeping the old body as a fallback: the classic script runs
    # BEFORE the module, so on first load that fallback ran against markup this
    # build had already replaced and threw on every missing element.
    body = re.compile(r"function pick\(i\)\{.*?\n\}", re.S)
    stub = ("function pick(i){\n"
            "  // The trade browser is a module in this build, and it registers\n"
            "  // itself after this script has run. An early call has nothing to\n"
            "  // do rather than something to break on.\n"
            "  cur = i;\n"
            "  if (window.__diaryPick) window.__diaryPick(i);\n"
            "}")
    src, n = body.subn(stub, src, count=1)
    if n != 1:
        raise SystemExit("pick() moved; check the template")

    # head(), details() and draw() drew the markup this build replaced. They
    # are unreachable through pick() now, but the template's resize handler
    # still calls draw(), so they are emptied rather than left to throw.
    for fn in ("head", "details", "draw", "tabs"):
        dead = re.compile(r"function " + fn + r"\(\)\{.*?\n\}", re.S)
        src, hit = dead.subn(
            "function " + fn + "(){ /* the trade browser is a module here */ }",
            src, count=1)
        if not hit:
            raise SystemExit(f"{fn}() moved; check the template")

    # The page becomes an app shell. The big header and the centred column go:
    # a working chart wants the frame, not a title and 44 pixels of padding
    # above it. What the template carried inside <div class="wrap"> is split,
    # the chart becoming the Diary and the reading material moving to Home.
    head_block = re.search(r"<header>.*?</header>\s*", src, re.S)
    if not head_block:
        raise SystemExit("the header moved; check the template")
    src = src.replace(head_block.group(0), "", 1)

    # The source picker went with the header. It belongs on Home beside the
    # figures it switches, not in a title bar above a chart it does not touch.
    # Emitted rather than cut out of the header: the picker is two sibling
    # divs, and a non-greedy match for the wrapper took only the first.
    source_block = (
        '<section id="sourcepick">\n'
        '  <h2>Your figures</h2>\n'
        '  <p class="lead">Practice and the automated system are kept apart '
        'from what you actually traded, on purpose. Folded together they would '
        'flatter or wreck the one number worth checking before you fund '
        'anything.</p>\n'
        '  <div class="sources"><div class="srcrow" id="srcrow"></div>'
        '<div id="srcpanes"></div></div>\n'
        "</section>\n")

    # A lookahead, so the match stops BEFORE the footer rather than eating it:
    # swallowing the opening tag left the footer text orphaned and nothing
    # afterwards could find it.
    body = re.search(r'<div class="wrap">(.*?)(?=<footer>)', src, re.S)
    if not body:
        raise SystemExit("the wrap or footer moved; check the template")
    inner = body.group(1)
    if TRADEVIEW not in inner:
        raise SystemExit("the trade view was not placed; check the build")
    reading = inner.replace(TRADEVIEW, "")
    # The import box now lives in the Diary panel, where the trades it creates
    # appear. Leaving the old section here as well would put two elements with
    # the same id on the page, and getElementById would only ever find one.
    reading, n = re.subn(r'<section id="importer">.*?</section>\s*',
                         "", reading, count=1, flags=re.S)
    if n != 1:
        raise SystemExit("the import section moved; check the template")

    extra = io.open(os.path.join(DOCS, "sections.html"), encoding="utf-8").read()
    home_open = ('<div class="tabpane reading" data-tab="home" hidden>\n'
                 '<div class="col">')
    if home_open not in extra:
        raise SystemExit("the Home pane moved; check sections.html")
    # The install bar stays at the top, because on a fresh phone it is the
    # only thing on this page that matters. Everything else the template
    # carried is reading material, and reading material below a dashboard
    # is reference; above it, it is a wall.
    extra = extra.replace(home_open, home_open + "\n" + INSTALL, 1)
    if "<!--READING-->" not in extra:
        raise SystemExit("the reading marker moved; check sections.html")
    extra = extra.replace("<!--READING-->", source_block + reading, 1)

    shell = (APPBAR.replace("__NAV__", NAV)
             + '<div class="appbody">\n'
             + '<div class="tabpane" data-tab="diary" hidden>'
             + TRADEVIEW + "</div>\n"
             + extra + "</div>\n")
    src = src.replace(body.group(0), '<div class="app">\n' + shell, 1)

    # The footer is reading material and the shell is a fixed frame, so left
    # where it was it hung below the viewport and gave the app a scrollbar it
    # is not meant to have. It moves to the end of the Home column instead.
    tail = re.search(r"<footer>.*?</footer>\s*", src, re.S)
    if not tail:
        raise SystemExit("the footer moved; check the template")
    src = src.replace(tail.group(0), "", 1)
    # A marker inside the column, not the tag that follows it. Anchoring on the
    # next pane put the footer between two panes rather than inside Home, where
    # it sat over the top of the page as a sibling of the panes themselves.
    if "<!--FOOTER-->" not in src:
        raise SystemExit("the footer marker moved; check sections.html")
    src = src.replace("<!--FOOTER-->", tail.group(0), 1)

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
    version = stamp_worker(src)
    src = version_modules(src, version)
    io.open(OUT, "w", encoding="utf-8").write(src)
    print(f"{len(src):,} chars -> {os.path.abspath(OUT)}")


# Every module the page loads. Listed rather than discovered, because a name
# that quietly stops being versioned is exactly the bug this exists to catch,
# and it would not show up until a deploy went out half old and half new.
MODULES = [
    "engine.js", "chart.js", "levels.js", "revisit.js", "series.js",
    "clock.js", "vault.js", "draw.js", "profile.js", "whatif.js",
    "watchlist.js", "lock.js",
    "replay.js", "demo.js", "diary.js", "videos.js", "system.js",
    "dashboard.js",
]


def version_modules(page, version):
    """Pin every module to this build, with an import map.

    A browser keeps a module it has already fetched and is not fussy about
    it: same URL, same module, whatever the server now says. So after a
    rebuild the page would load the new shell and then satisfy half its
    imports from copies it already had, giving an app assembled out of two
    different versions. It does not fail cleanly. It fails as a missing
    function somewhere unrelated, which is how an afternoon disappears.

    The URL carries the build now, so a new build is a new URL and there is
    nothing to reuse. On a phone that also means the app updates all at once
    or not at all.
    """
    imports = {}
    for m in MODULES:
        if not os.path.exists(os.path.join(DOCS, m)):
            raise SystemExit(m + " is in MODULES but not in docs/")
        imports["./" + m] = "./" + m + "?v=" + version
    tag = ('<script type="importmap">'
           + json.dumps({"imports": imports}, separators=(",", ":"))
           + "</script>" + chr(10))
    # It has to come before the first module script. Once one has run, a
    # browser ignores the map entirely rather than complaining about it.
    at = page.index('<script type="module">')
    return page[:at] + tag + page[at:]


def stamp_worker(page):
    """Give the service worker a version that changes when the app does.

    A fixed version with a cache-first shell is a trap: the first visit caches
    the page and every visit after that is served from cache, so no update ever
    arrives. The version is the content, so a build that changes nothing
    changes nothing here either.
    """
    import hashlib
    parts = [page]
    for name in ("engine.js", "chart.js", "levels.js", "revisit.js",
                 "replay.js", "demo.js", "diary.js", "videos.js",
                 "system.js", "dashboard.js", "lock.js", "watchlist.js",
                 "series.js", "clock.js", "vault.js", "draw.js",
                 "profile.js", "whatif.js"):
        f = os.path.join(DOCS, name)
        if os.path.exists(f):
            parts.append(io.open(f, encoding="utf-8").read())

    p = os.path.join(DOCS, "sw.js")
    sw = io.open(p, encoding="utf-8").read()
    # The worker's own rules are part of the app. Hashing it with its version
    # line blanked keeps this from chasing its own tail on every build.
    parts.append(re.sub(r'const VERSION = "[^"]*";', "", sw))
    build = hashlib.sha256("".join(parts).encode("utf-8")).hexdigest()[:12]
    new = re.sub(r'const VERSION = "[^"]*";',
                 f'const VERSION = "{build}";', sw, count=1)
    # The same list the import map uses, so the worker caches exactly the
    # URLs the page will ask for rather than something that looks like them.
    new = re.sub(r"const MODULES = .*?;",
                 "const MODULES = " + json.dumps(MODULES) + ";",
                 new, count=1, flags=re.S)
    if new == sw and f'"{build}"' not in sw:
        raise SystemExit("could not stamp sw.js; the VERSION line moved")
    io.open(p, "w", encoding="utf-8").write(new)
    print(f"service worker version {build}")
    return build


if __name__ == "__main__":
    main()
