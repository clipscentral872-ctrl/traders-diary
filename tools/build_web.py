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
  <h2>Lock it with a passcode</h2>
  <p class="lead">A passcode does not just hide the diary behind a screen, it
  <b>encrypts</b> the record. What is left in this browser afterwards is a blob
  that means nothing without the passcode, so someone holding your unlocked
  phone gets nothing out of it.</p>
  <p class="lead">The cost of that is real and there is no way around it:
  <b>there is no reset.</b> No account, no recovery email, nobody with a spare
  key. Forget the passcode and the record is gone. Save a backup file first,
  and keep it somewhere you trust, because the backup stays unencrypted on
  purpose so that it is a way back in rather than a second thing to lose.</p>
  <div class="toolrow" id="lockrow">
    <button class="bigbtn" id="setlock">Set a passcode</button>
    <button class="bigbtn ghost" id="unsetlock" hidden>Remove the passcode</button>
  </div>
  <p class="lead" id="lockstate"></p>

  <!-- A real form rather than the browser's popups. A home-screen app on an
       iPhone can swallow prompt() entirely, and a passcode you tap Set on and
       nothing happens is worse than no passcode at all. -->
  <div class="setcard hud" id="setpanel" hidden>
    <h3 id="settitle">Set a passcode</h3>
    <p class="lead">Longer beats clever. A short phrase you will not forget is
    stronger than a word with symbols in it.</p>
    <form id="setform" autocomplete="off">
      <label class="rpl" for="pin1">Passcode
        <input type="password" id="pin1" autocomplete="new-password"
               minlength="4" required></label>
      <p class="strength" id="strength" hidden></p>
      <label class="rpl" for="pin2">Type it again
        <input type="password" id="pin2" autocomplete="new-password"
               minlength="4" required></label>
      <label class="ack"><input type="checkbox" id="ack">
        I understand there is <b>no reset</b>. If I forget this, the record on
        this device is gone and only a backup file can bring it back.</label>
      <div class="toolrow">
        <button class="bigbtn" type="submit" id="setgo">Lock it</button>
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
  font-family:"Orbitron",sans-serif; font-weight:700; font-size:12px;
  letter-spacing:.13em; text-transform:uppercase;
  transition:color .14s, border-color .14s;
}
.tb:hover{color:var(--text)}
.tb[aria-selected="true"]{
  color:var(--accent); border-bottom-color:var(--accent);
  text-shadow:0 0 18px var(--accent-dim);
}
.tb:focus-visible{outline:2px solid var(--accent); outline-offset:-2px}

/* replay */
.rp{padding:16px}
.rpbar{display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; margin-bottom:14px}
.rpgroup{display:flex; flex-direction:column; gap:6px}
.rpl{
  color:var(--muted); font-size:11px; text-transform:uppercase;
  letter-spacing:.09em; display:flex; flex-direction:column; gap:6px;
}
.rpbar select, .rpbar input, .ticket input{
  background:var(--lift); color:var(--text); border:1px solid var(--line);
  font-family:"JetBrains Mono",monospace; font-size:14px; padding:10px 12px;
  min-height:44px; width:100%;
}
.rpbar select:focus-visible, .rpbar input:focus-visible, .ticket input:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px
}
.tfrow{display:flex; gap:4px}
.tfb{
  background:var(--raised); border:1px solid var(--line); color:var(--muted);
  font-family:"Chakra Petch",sans-serif; font-weight:600; font-size:12px;
  padding:0 13px; min-height:44px; cursor:pointer;
}
.tfb[aria-pressed="true"]{border-color:var(--accent); color:var(--text); background:var(--lift)}
.rpread{
  display:flex; flex-wrap:wrap; gap:16px; padding:10px 0 12px;
  border-top:1px solid var(--line-soft); border-bottom:1px solid var(--line-soft);
  margin-bottom:12px; font-size:12.5px; color:var(--muted);
}
.rv b{color:var(--text); font-family:"JetBrains Mono",monospace}
#rc{width:100%; display:block}
.rpctl{display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-top:12px}
.rbtn{
  background:var(--raised); border:1px solid var(--line); color:var(--text);
  font-family:"JetBrains Mono",monospace; font-size:13px; padding:0 15px;
  min-height:44px; cursor:pointer;
}
.rbtn:hover{border-color:var(--accent)}
.rbtn.ghostb{color:var(--muted); margin-left:auto}
.rpsp{flex:1}
.deck{display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px}
.deck h3{
  font-family:"Orbitron",sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.09em; text-transform:uppercase; margin:0 0 14px;
}
.sides{display:flex; gap:9px; margin-bottom:14px}
.sbtn{
  flex:1; min-height:48px; cursor:pointer; border:1px solid;
  font-family:"Orbitron",sans-serif; font-weight:700; font-size:13px;
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
.rpr,.rpm{font-family:"JetBrains Mono",monospace}
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
  font-family:"Orbitron",sans-serif; font-weight:900; font-size:20px;
  color:var(--accent); text-shadow:0 0 16px var(--accent-dim);
}
.steps h3{
  font-family:"Orbitron",sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.08em; text-transform:uppercase; margin:0 0 7px;
}
.steps p{margin:0; color:var(--muted); font-size:14px; line-height:1.65}
.lessons{list-style:none; padding:0; margin:0; display:grid; gap:10px}
.lessons li{
  display:grid; grid-template-columns:auto 1fr; gap:15px; align-items:baseline;
  padding:15px 18px; background:var(--raised);
  border-left:2px solid var(--loss-faded);
}
.lessons .ln{
  font-family:"JetBrains Mono",monospace; font-size:20px; color:var(--accent);
  font-variant-numeric:tabular-nums;
}
.lessons .lt{font-size:14px; line-height:1.65}
.lessons .lt b{display:block; margin-bottom:4px; color:var(--text)}
.lessons .lt span{color:var(--muted)}

/* your own note on a trade */
.mynote{margin-top:16px; border-top:1px solid var(--line-soft); padding-top:14px}
.mynote label{
  display:block; color:var(--muted); font-size:11px; text-transform:uppercase;
  letter-spacing:.09em; margin-bottom:7px;
}
.mynote textarea{
  width:100%; min-height:84px; resize:vertical; background:var(--lift);
  color:var(--text); border:1px solid var(--line); padding:11px 13px;
  font-family:"Chakra Petch",sans-serif; font-size:14px; line-height:1.6;
}
.mynote textarea:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.mysaved{color:var(--faint); font-size:11.5px; margin:7px 0 0; min-height:16px}

#updbar{
  position:fixed; left:16px; right:16px; bottom:16px; z-index:50;
  display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  background:var(--lift); border:1px solid var(--accent); padding:14px 18px;
  box-shadow:0 10px 40px rgba(0,0,0,.65), 0 0 30px var(--accent-dim);
}
#updbar span{flex:1 1 160px; font-size:14px}
@media (max-width:640px){ #updbar{flex-direction:column; align-items:stretch} }

/* the video library */
.vgroup{margin-top:24px}
.vgroup h3{
  font-family:"Orbitron",sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.1em; text-transform:uppercase; color:var(--accent);
  margin:0 0 10px;
}
.vlist{display:grid; gap:7px; grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.vcut{
  display:flex; align-items:center; gap:11px; text-align:left; cursor:pointer;
  background:var(--raised); border:1px solid var(--line); color:var(--text);
  font-family:"Chakra Petch",sans-serif; padding:12px 14px; min-height:52px;
}
.vcut:hover{border-color:var(--accent); background:var(--lift)}
.vcut:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.vcut .vplay{
  flex:none; width:0; height:0; border-left:11px solid var(--accent);
  border-top:7px solid transparent; border-bottom:7px solid transparent;
}
.vcut .vn{flex:1; font-size:13.5px; line-height:1.35}
.vcut .vs{
  font-family:"JetBrains Mono",monospace; font-size:11px; color:var(--faint);
}
.vcut.win{border-left:2px solid var(--win)}
.vcut.loss{border-left:2px solid var(--loss)}
.vplayer{
  position:fixed; inset:0; z-index:70; background:rgba(5,7,12,.96);
  display:flex; flex-direction:column; padding:18px; gap:12px;
}
.vhead{
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  font-family:"Orbitron",sans-serif; font-weight:800; font-size:13px;
  letter-spacing:.08em; text-transform:uppercase;
}
.vplayer video{
  flex:1; min-height:0; width:100%; background:#000; border:1px solid var(--line);
}

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
  font-family:"JetBrains Mono",monospace; font-size:12.5px; padding:8px 10px;
  min-height:38px;
}
.psel:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.pbtn{
  background:var(--lift); border:1px solid var(--line); color:var(--text);
  font-family:"Chakra Petch",sans-serif; font-weight:600; font-size:12px;
  text-transform:uppercase; letter-spacing:.09em; padding:9px 14px;
  min-height:38px; cursor:pointer;
}
.pbtn.go{border-color:var(--accent); color:var(--accent)}
.pbtn:hover{background:var(--raised)}

/* The OHLC readout that follows the crosshair, the way a chart names what is
   under the cursor instead of making you guess. */
.pohlc{
  display:flex; gap:12px; font-family:"JetBrains Mono",monospace;
  font-size:11.5px; color:var(--muted); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;
}
.pohlc b{color:var(--text); font-weight:500}
.pohlc .up{color:var(--candle-up)} .pohlc .dn{color:var(--candle-dn)}
.pstale{
  font-family:"JetBrains Mono",monospace; font-size:11.5px; color:var(--muted);
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
  background:rgba(10,15,23,.86); border:1px solid var(--line);
  color:var(--muted); font-family:"Chakra Petch",sans-serif; font-weight:600;
  font-size:11.5px; letter-spacing:.06em; padding:0 11px; min-width:38px;
  min-height:38px; cursor:pointer; backdrop-filter:blur(3px);
}
.ptool:hover{color:var(--text); border-color:var(--accent)}
.ptool[aria-pressed="true"]{color:var(--accent); border-color:var(--accent)}
.ptool:focus-visible{outline:2px solid var(--accent); outline-offset:1px}

/* The order ticket, floating on the chart like a platform's. The two big
   coloured buttons carry the price, so what you would get is on the button
   you are about to press. */
.pticket{
  position:absolute; top:10px; right:10px; width:206px; z-index:2;
  background:rgba(10,15,23,.9); border:1px solid var(--line); padding:11px;
  backdrop-filter:blur(4px);
}
.tq{display:grid; grid-template-columns:auto 1fr; gap:6px 8px; align-items:center}
.tq label{
  color:var(--muted); font-size:10px; text-transform:uppercase;
  letter-spacing:.08em;
}
.tq input{
  background:var(--ground); border:1px solid var(--line); color:var(--text);
  font-family:"JetBrains Mono",monospace; font-size:12.5px; padding:6px 7px;
  width:100%; min-height:34px;
}
.tq input:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.tbtns{display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:9px}
.tbuy,.tsell{
  border:none; cursor:pointer; padding:9px 4px; min-height:50px;
  display:flex; flex-direction:column; align-items:center; gap:1px;
  font-family:"Chakra Petch",sans-serif; color:#04120B;
}
.tbuy{background:var(--win)} .tsell{background:var(--loss); color:#1A0407}
.tbuy b,.tsell b{font-size:12.5px; text-transform:uppercase; letter-spacing:.09em}
.tbuy span,.tsell span{font-family:"JetBrains Mono",monospace; font-size:11px; opacity:.82}
.tbuy:hover{filter:brightness(1.12)} .tsell:hover{filter:brightness(1.12)}
.tbuy:disabled,.tsell:disabled{opacity:.3; cursor:not-allowed; filter:none}
.tbuy:focus-visible,.tsell:focus-visible{outline:2px solid var(--text); outline-offset:2px}
.tflat{
  width:100%; margin-top:6px; background:var(--lift); border:1px solid var(--line);
  color:var(--text); font-family:"Chakra Petch",sans-serif; font-size:11.5px;
  text-transform:uppercase; letter-spacing:.08em; padding:9px; min-height:38px;
  cursor:pointer;
}
.tflat:hover{border-color:var(--accent)}
.trisk{
  margin:9px 0 0; font-size:11px; line-height:1.5; color:var(--muted);
}
.trisk b{font-family:"JetBrains Mono",monospace}
.rrwarn{display:block; margin-top:4px; color:var(--loss); font-weight:600}
.pstatus{
  margin:0; background:var(--raised); border:1px solid var(--line);
  border-top:none; padding:9px 12px; color:var(--muted); font-size:12.5px;
}

@media (max-width:760px){
  /* On a phone the ticket cannot float over the chart without covering it. */
  .pticket{
    position:static; width:auto; margin-top:0; border-top:none;
    backdrop-filter:none; background:var(--raised);
  }
  .pstage{overflow:visible}
  .pstage canvas{height:clamp(280px, 46vh, 420px)}
  .ptransport{position:static; margin:10px; flex-wrap:wrap}
  .tbtns{grid-template-columns:1fr 1fr}
  .pbar{gap:9px}
}

/* dashboard */
.dashhead h2{margin-top:0}
.dgrid{
  display:grid; gap:12px; margin-top:20px;
  grid-template-columns:repeat(auto-fit, minmax(215px, 1fr));
}
.dtile{
  background:var(--raised); border:1px solid var(--line); padding:16px 18px;
  display:flex; flex-direction:column; gap:5px; position:relative;
  min-height:104px; justify-content:center;
}
.dtile::before{
  content:""; position:absolute; left:-1px; top:-1px; width:16px; height:16px;
  border-top:2px solid var(--accent); border-left:2px solid var(--accent);
}
.dl{
  color:var(--muted); font-size:10.5px; text-transform:uppercase;
  letter-spacing:.13em; font-weight:600;
}
.dv{
  font-family:"JetBrains Mono",monospace; font-variant-numeric:tabular-nums;
  font-size:27px; font-weight:500; line-height:1.15; letter-spacing:-.01em;
}
.dv.win{color:var(--win); text-shadow:0 0 22px rgba(43,224,138,.3)}
.dv.loss{color:var(--loss); text-shadow:0 0 22px rgba(255,92,110,.28)}
.dn{color:var(--faint); font-size:12px; line-height:1.45}
.dleak{
  margin-top:14px; background:var(--line-soft); border:1px solid var(--line);
  border-left:2px solid var(--loss); padding:15px 18px;
}
.dlt{
  color:var(--loss); font-size:10.5px; text-transform:uppercase;
  letter-spacing:.13em; font-weight:700;
}
.dleak p{margin:6px 0 0; color:var(--text); font-size:14px; line-height:1.65}
.dleak b{color:var(--loss)}
@media (max-width:640px){
  .dgrid{grid-template-columns:1fr}
  .dv{font-size:24px}
}

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
#lockgate{
  position:fixed; inset:0; z-index:60; background:var(--ground);
  display:flex; align-items:center; justify-content:center; padding:22px;
}
.lockcard{
  background:var(--raised); border:1px solid var(--line); padding:34px 30px;
  max-width:420px; width:100%; text-align:center;
}
.lockcard h2{margin:0 0 10px}
.lockcard h2::before{display:none}
.lockmark{
  width:34px; height:26px; margin:0 auto 18px; border:2px solid var(--accent);
  border-radius:4px; position:relative; box-shadow:0 0 18px var(--accent-dim);
}
.lockmark::before{
  content:""; position:absolute; left:50%; top:-15px; width:18px; height:16px;
  border:2px solid var(--accent); border-bottom:none;
  border-radius:9px 9px 0 0; transform:translateX(-50%);
}
#lockform{display:flex; flex-direction:column; gap:10px; margin:20px 0 4px}
#lockpin{
  background:var(--lift); border:1px solid var(--line); color:var(--text);
  font-family:"JetBrains Mono",monospace; font-size:17px; letter-spacing:.2em;
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
  font-family:"JetBrains Mono",monospace; font-size:16px; letter-spacing:.14em;
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
  .tb{padding:12px 13px; font-size:11px; letter-spacing:.09em}
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
    src = src.replace(marker, marker + NAV + INSTALL
                      + '<div class="tabpane" data-tab="diary">\n', 1)

    # Everything the template already had becomes the Diary tab. The other
    # three are appended after it, before the footer that closes the page.
    foot = "<footer>"
    if foot not in src:
        raise SystemExit("the footer moved; check the template")
    extra = io.open(os.path.join(DOCS, "sections.html"), encoding="utf-8").read()
    src = src.replace(foot, "</div>\n" + extra + "\n" + foot, 1)

    src = src.replace("__LEARN__", PRIVACY + SETTINGS)

    # A box for what you were actually thinking, which is the one thing the
    # diary cannot work out for you and the thing worth most a month later.
    note_anchor = '<p class="note" id="note"></p>'
    if note_anchor not in src:
        raise SystemExit("the note paragraph moved; check the template")
    src = src.replace(note_anchor, note_anchor + """
        <div class="mynote">
          <label for="mynotebox">What you were thinking</label>
          <textarea id="mynotebox" disabled
            placeholder="Why you took it, what you saw, what you would do differently. Saved on this device as you type."></textarea>
          <p class="mysaved" id="mynotesaved"></p>
        </div>""", 1)

    # pick() is in the shared script and has no hook, so the note box is
    # refreshed from the one place that already knows the trade changed.
    for before, after in (
        ("  head(); details(); draw();\n}",
         "  head(); details(); draw();\n"
         "  if (window.showMyNote) window.showMyNote(VIEW[cur]);\n}"),
        ('    cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);\n    return;',
         '    cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);\n'
         '    if (window.showMyNote) window.showMyNote(null);\n    return;'),
    ):
        if before not in src:
            raise SystemExit("pick() moved; check the template")
        src = src.replace(before, after, 1)

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
    stamp_worker(src)


def stamp_worker(page):
    """Give the service worker a version that changes when the app does.

    A fixed version with a cache-first shell is a trap: the first visit caches
    the page and every visit after that is served from cache, so no update ever
    arrives. The version is the content, so a build that changes nothing
    changes nothing here either.
    """
    import hashlib
    parts = [page]
    for name in ("engine.js", "replay.js", "system.js", "levels.js",
             "lock.js", "demo.js", "revisit.js",
             "dashboard.js", "chart.js",
             "videos.js"):
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
    if new == sw and f'"{build}"' not in sw:
        raise SystemExit("could not stamp sw.js; the VERSION line moved")
    io.open(p, "w", encoding="utf-8").write(new)
    print(f"service worker version {build}")


if __name__ == "__main__":
    main()
