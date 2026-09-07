/* The app around the diary: storage, the six-file import, and the panels the
 * desktop version renders on the server.
 *
 * Everything here runs in your browser. Your exports are never uploaded, and
 * the record is kept in this browser's own storage, so the diary works with
 * no signal and no account.
 */
import * as E from "./engine.js";
import * as C from "./clock.js";
import * as PROF from "./profile.js";
import * as RP from "./replay.js";
import * as SYS from "./system.js";
import * as LOCK from "./lock.js";
import * as DEMO from "./demo.js";
import * as RV from "./revisit.js";
import * as DASH from "./dashboard.js";
import * as VID from "./videos.js";
import * as DIARY from "./diary.js";
import * as DRAW from "./draw.js";

const $ = id => document.getElementById(id);
// Names within a journal. The journal itself decides where they land, so
// two people on one device never touch each other's.
const KEY = "v1";
const TZ_KEY = "tz";
// Set the first time the seed is planted, and also by "Erase everything", so
// an app you have deliberately emptied stays empty instead of filling itself
// back up on the next reload.
const SHOW_TZ_KEY = "showtz";

/* ------------------------------------------------------------- storage */

// Held only in memory, only while the app is open, and never written down.
// Closing the tab forgets it, which is the whole point of it being a lock.
let PASSCODE = null;

function load() {
  try {
    const raw = PROF.get(KEY);
    if (!raw) return {trades: [], start: null};
    if (LOCK.isLocked(raw)) return {trades: [], start: null, sealed: true};
    const o = JSON.parse(raw);
    return {trades: o.trades || [], start: o.start ?? null};
  } catch {
    // A corrupt or unreadable store must not leave a blank screen with no
    // explanation, and must not be silently overwritten either.
    return {trades: [], start: null, broken: true};
  }
}

const CANT_STORE =
  "This browser would not store the record, most likely because it is full or "
  + "because private browsing blocks storage. Your trades are on screen but "
  + "will be gone when you close the tab. Save a backup file.";

const NO_JOURNAL =
  "No journal is open, so nothing was saved. Enter your PIN and try again.";

function save(trades, start) {
  // Refuse rather than write somewhere shared. This is the one place a
  // person's trades could land in a bucket that is not theirs.
  if (!PROF.isOpen()) return NO_JOURNAL;
  const body = {trades, start, saved: Date.now()};
  try {
    if (PASSCODE === null) {
      return PROF.set(KEY, JSON.stringify(body)) ? null : CANT_STORE;
    }
    // Locked. Encrypt first, and only overwrite once that has succeeded, so a
    // failure here can never replace a good record with a broken one.
    LOCK.lock(body, PASSCODE)
      .then(env => PROF.set(KEY, JSON.stringify(env)))
      .catch(() => say("The record could not be locked, so it was not saved. "
                     + "Save a backup file now.", true));
    return null;
  } catch (e) {
    return CANT_STORE;
  }
}

let STATE = load();
window.TRADES = STATE.trades;
window.START = STATE.start;

/* Nothing ships with the app any more.
 *
 * It used to carry a starting record so a fresh install had something to
 * look at. That record was one person's real trades sitting in a file on a
 * public site, and the moment the link went to a second person it was also
 * the first person's trades appearing in the second person's journal. A
 * backup file restored once per device does the same job and tells nobody
 * else anything.
 */

/** New York unless you have said otherwise. */
const displayZone = () => PROF.get(SHOW_TZ_KEY) || C.NY;

const tzOffset = () => {
  const v = parseFloat(PROF.get(TZ_KEY));
  // Falling back to the device's own offset is right far more often than any
  // fixed guess, because most people export on the machine they trade on.
  return Number.isFinite(v) ? v : -new Date().getTimezoneOffset() / 60;
};

/* --------------------------------------------------------------- bars */

// Browsers cannot fetch a market feed directly, so a daily job publishes the
// recent minute bars beside this page and they are loaded from here.
const BARS = {};
const pending = new Map();

/** Load the published bars for these contracts only.
 *
 *  Each file is around 300 KB, so pulling all four on a phone to draw one NQ
 *  trade is most of a megabyte wasted. Only what the record actually contains
 *  is fetched, and each file only once. */
async function loadBars(symbols) {
  const want = [...new Set(symbols.filter(Boolean))];
  await Promise.all(want.map(sym => {
    if (BARS[sym]) return null;
    if (pending.has(sym)) return pending.get(sym);
    const p = (async () => {
      try {
        const r = await fetch(`bars/${sym}_1m.json`, {cache: "no-cache"});
        if (!r.ok) return;
        const j = await r.json();
        // A flat array on a fixed one-minute grid: a bar's time is where it
        // sits, and a closed minute is a null that is dropped on the way in.
        const out = [];
        j.bars.forEach((b, i) => {
          if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                           o: b[0], h: b[1], l: b[2], c: b[3]});
        });
        BARS[sym] = out;
      } catch { /* offline, or never published: the diary still works */ }
      finally { pending.delete(sym); }
    })();
    pending.set(sym, p);
    return p;
  }));
  return BARS;
}

const feedsFor = trades => trades.map(t => E.FEED[t.symbol]);

/* ------------------------------------------------------------ panels */

const SOURCES = [["live", "Live"], ["demo", "Demo"],
                 ["replay", "Replay"], ["all", "All"]];
const SOURCE_NOTE = {
  live: "Trades you actually placed.",
  demo: "Placed on the Demo account at a delayed price. Kept out of your live figures.",
  replay: "Practice. Deliberately kept out of your live figures.",
  all: "Everything together. Useful for volume, misleading as a record.",
};
const GOOD = new Set(["target hit"]);
const BAD = new Set(["stop wrong side", "slipped", "cut short", "closed early",
                     "stopped into the news"]);
const FLAG_TEXT = window.FLAG_TEXT || {};

const esc = s => String(s).replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const dollars = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});

function stat(label, value, cls = "") {
  return `<div class="stat"><span class="sl">${label}</span>`
       + `<span class="sv ${cls}">${value}</span></div>`;
}

function renderPanels() {
  const all = window.TRADES;
  // One trade is not "1 trades". The whole phrase is written here rather
  // than a number beside a fixed word, which cannot be made to agree.
  $("appmeta").textContent = all.length === 0 ? "no trades"
    : all.length === 1 ? "1 trade" : `${all.length} trades`;

  const present = SOURCES.filter(([k]) =>
    all.some(t => k === "all" || (t.source || "live") === k));
  const usable = present.length > 1 ? present : present.slice(0, 1);

  $("srcrow").innerHTML = usable.map(([k, label]) => {
    const n = all.filter(t => k === "all" || (t.source || "live") === k).length;
    return `<button class="src" data-src="${k}" onclick="pickSource('${k}')">`
         + `${label}<span class="sn">${n}</span></button>`;
  }).join("");

  $("srcpanes").innerHTML = usable.map(([k]) => {
    const sel = all.filter(t => k === "all" || (t.source || "live") === k);
    const s = E.summarise(sel);
    const head = [
      stat("net", dollars(s.pnl), s.pnl >= 0 ? "win" : "loss"),
      stat("win rate", s.win_rate.toFixed(0) + "%"),
      stat("record", `${s.wins}W / ${s.losses}L`),
      stat("expectancy", s.expectancy_r === null ? "&mdash;"
           : (s.expectancy_r >= 0 ? "+" : "") + s.expectancy_r.toFixed(2) + "R",
           (s.expectancy_r || 0) >= 0 ? "win" : "loss"),
      stat("avg win", "$" + Math.round(s.avg_win).toLocaleString("en-US"), "win"),
      stat("avg loss", "$" + Math.round(Math.abs(s.avg_loss)).toLocaleString("en-US"), "loss"),
      stat("max drawdown", "$" + Math.round(s.max_dd).toLocaleString("en-US")),
      stat("trades", String(s.trades)),
    ].join("");
    return `<div class="pane-src" data-src="${k}" hidden>`
         + `<div class="stats hud">${head}</div>`
         + `<p class="srcnote">${SOURCE_NOTE[k]}</p></div>`;
  }).join("");

  $("patwrap").innerHTML = usable.map(([k]) => {
    const sel = all.filter(t => k === "all" || (t.source || "live") === k);
    const counts = new Map();
    for (const t of sel) for (const f of (t.flags || []))
      counts.set(f, (counts.get(f) || 0) + 1);
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) =>
      `<li class="pat ${GOOD.has(f) ? "good" : (BAD.has(f) ? "bad" : "")}">`
      + `<span class="pn">${n}</span>`
      + `<span class="pl">${esc(FLAG_TEXT[f] || f)}</span></li>`).join("");
    return `<ul class="pats pane-pat" data-src="${k}" hidden>`
         + (rows || '<li class="pat"><span class="pl">Nothing flagged yet.</span></li>')
         + "</ul>";
  }).join("");

  renderStanding();
  renderLearn();
  DASH.refreshRecord();
  DIARY.pick(0);
  const first = document.querySelector('.src[data-src="live"]')
             || document.querySelector(".src");
  window.pickSource(first ? first.dataset.src : "live");
}

/** Where the record actually stands, worked out every time it is drawn. */
function renderStanding() {
  const rows = [];
  const row = (state, label, detail) => rows.push(
    `<li class="stand ${state}"><span class="sl2">${esc(label)}</span>`
    + `<span class="sd">${detail}</span></li>`);

  const mine = window.TRADES.filter(t => (t.source || "live") === "live");
  const n = mine.length;

  if (!n) {
    row("warn", "Nothing imported yet",
      "Drop your TradingView exports above and this fills in. Until then there "
      + "is nothing here to be right or wrong about.");
    $("stands").innerHTML = rows.join("");
    return;
  }

  const need = 100;
  if (n < need)
    row("warn", `Your record is ${n} trade${n === 1 ? "" : "s"}`,
      `About ${need} are needed before a win rate or an expectancy means `
      + `anything. At ${n} the numbers on this page describe what happened, not `
      + `what tends to happen.`);
  else
    row("ok", `Your record is ${n} trades`,
      "Enough to read an expectancy from, though a single month is still one "
      + "market regime rather than a general result.");

  const noR = mine.filter(t => t.got_r === null || t.got_r === undefined);
  if (noR.length) {
    const lost = noR.filter(t => t.pnl < 0).length;
    row("warn", `${noR.length} of your ${n} trades have no R`,
      `TradingView caps the activity-log export, so the stop set at entry is `
      + `off the end of it on those. The money is exact either way, but the `
      + `expectancy is measured on the other ${n - noR.length} only, and `
      + `${lost} of the ${noR.length} left out `
      + (lost ? "were losses, so the R figure here reads better than the account did"
              : "were winners, so the R figure here reads worse than the account did")
      + ". Export the activity log at the end of every session and this closes.");
  }

  const noBars = mine.filter(t => !t.bars || !t.bars.length).length;
  if (noBars)
    row("warn", `${noBars} trade${noBars === 1 ? " has" : "s have"} no candles`,
      "The bars published with this app go back about ten days, so older trades "
      + "keep their numbers but cannot be drawn. Import each session while it is "
      + "recent and the chart is there for good.");

  const trailed = mine.filter(t => (t.flags || []).includes("trailed early")).length;
  if (trailed >= 3)
    row("warn", `${trailed} stops tightened before your own rule said to`,
      "Tightening a stop before price has run the distance you planned turns a "
      + "trade you were right about into a small loss. This is the most common "
      + "thing in your record, so it is the one worth changing first.");

  row("no", "This is a mirror, not a signal",
    "It tells you what you did. It does not know whether your strategy works, "
    + "and nothing here has been tested against out-of-sample data. Do not size "
    + "up because a page looks encouraging.");

  $("stands").innerHTML = rows.join("");
}

/* ------------------------------------------------------------- import */

const KINDS = [
  [/order-history/i, "every fill, so the trades themselves"],
  [/activity-log/i, "stop moves, so R"],
  [/balance-history/i, "the opening balance"],
  [/trade-history/i, "cross-check against the broker"],
  [/orders-all|^paper-trading-orders/i, "cross-check"],
  [/positions/i, "cross-check"],
];

const drop = $("drop"), pickEl = $("pick");
const fileList = $("dropfiles"), bar = $("dropbar"), msg = $("dropmsg");

function say(text, bad) {
  msg.textContent = text;
  msg.classList.toggle("bad", !!bad);
  msg.hidden = !text;
}

function preview(files) {
  fileList.innerHTML = "";
  for (const f of files) {
    const hit = KINDS.find(k => k[0].test(f.name));
    const li = document.createElement("li");
    li.className = hit ? "used" : "skip";
    const short = f.name.replace(/^paper-trading-/, "")
      .replace(/[-_]\d{4}-\d\d-\d\dT[\d_.]+Z?\.csv$/i, "").replace(/\.csv$/i, "");
    li.innerHTML = `<b>${esc(short)}</b>${esc(hit ? hit[1] : "not one the diary reads, ignored")}`;
    fileList.appendChild(li);
  }
}

const readFile = f => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res({name: f.name, text: String(r.result)});
  r.onerror = () => rej(new Error("could not read " + f.name));
  r.readAsText(f);
});

async function handle(fileHandles) {
  // Ask before doing the work, not after. Reading five exports, pairing the
  // round trips and reconciling them against the broker takes a few seconds,
  // and finishing all of that to then say it could not be saved is the wrong
  // order to find out in.
  if (!PROF.isOpen()) {
    say("No journal is open, so there is nowhere to put these. Enter your PIN "
      + "and drop them again.", true);
    return;
  }
  const csv = [...fileHandles].filter(f => /\.csv$/i.test(f.name));
  preview(fileHandles);
  if (!csv.length) {
    say("Those are not CSV files. Export from TradingView first, then drop the "
      + "files it gives you.", true);
    return;
  }

  drop.classList.add("busy");
  bar.hidden = false;
  say(`Reading ${csv.length} file${csv.length > 1 ? "s" : ""}...`);

  try {
    const files = await Promise.all(csv.map(readFile));
    const offset = tzOffset();
    E.setLocalOffset(offset);

    const before = window.TRADES.length;
    const peek = E.pairTrades(E.readExports(files)).trades;
    await loadBars(feedsFor([...window.TRADES, ...peek]));
    const out = E.ingest(files, window.TRADES, BARS, offset);

    window.TRADES = out.trades;
    if (out.startBalance !== null &&
        (window.START === null || out.startBalance < window.START))
      window.START = out.startBalance;

    const warn = save(window.TRADES, window.START);
    renderPanels();

    const lines = [];
    lines.push(out.added
      ? `${out.added} new trade${out.added === 1 ? "" : "s"} added. `
        + `${out.trades.length} on record.`
      : `Nothing new. All ${out.trades.length} of those trades were already here.`);

    const today = out.trades.filter(t => t.open_t.slice(0, 10)
      === out.trades[out.trades.length - 1]?.open_t.slice(0, 10));
    if (out.added && today.length) {
      const pnl = today.reduce((s, t) => s + t.pnl, 0);
      lines.push(`${today[0].open_t.slice(0, 10)}: ${today.length} trade`
        + `${today.length === 1 ? "" : "s"}, ${dollars(pnl)}.`);
    }
    if (out.withBars < out.trades.length)
      lines.push(`${out.trades.length - out.withBars} could not be drawn: the `
        + `published bars only reach back about ten days.`);
    if (out.stillOpen.length)
      lines.push(`Still open, so not counted: ${out.stillOpen.join(", ")}.`);
    if (out.gaps.length) {
      lines.push(`This does NOT match the broker's own export on `
        + `${out.gaps.length} point(s): ${out.gaps.join("; ")}. Trust the broker.`);
    } else if (out.brokerCount) {
      lines.push(`Matches the broker's own export on all ${out.brokerCount} round trips.`);
    }
    if (warn) lines.push(warn);

    bar.hidden = true;
    drop.classList.remove("busy");
    say(lines.join("\n"), out.gaps.length > 0 || !!warn);
    if (out.trades.length !== before) storeLine();
  } catch (e) {
    bar.hidden = true;
    drop.classList.remove("busy");
    say("Could not read those files: " + e.message
      + ". They should be the CSVs straight out of TradingView, unedited.", true);
  }
}

// On a phone there is nothing to drag, so the copy has to lead with tapping.
// Written from the device rather than the screen width, because a small window
// on a laptop still has a mouse.
if (matchMedia("(hover: none)").matches) {
  document.querySelector(".dropbig").textContent = "Tap to choose your exports";
  document.querySelector(".dropsub").innerHTML =
    "Pick all six at once from Files &nbsp;/&nbsp; CSVs from TradingView paper trading";
  const step = document.querySelector(".howsteps li:last-child");
  if (step) step.textContent = "Tap the box above and pick all six from Files.";
  const lead = document.querySelector("#importer .lead");
  if (lead) lead.textContent = "Pick all six TradingView exports at once. Anything "
    + "the diary cannot use is ignored, and the same file added twice changes "
    + "nothing, so there is no wrong way to do this.";
}

drop.addEventListener("click", () => pickEl.click());
drop.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickEl.click(); }
});
pickEl.addEventListener("change", () => pickEl.files.length && handle(pickEl.files));
["dragenter", "dragover"].forEach(n => drop.addEventListener(n, e => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach(n => drop.addEventListener(n, e => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", e => {
  if (e.dataTransfer?.files.length) handle(e.dataTransfer.files);
});
// Dropping anywhere else must not navigate the browser to the file, which
// looks exactly like the app crashing.
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => e.preventDefault());

/* ------------------------------------------------- backup and settings */

function storeLine() {
  const n = window.TRADES.length;
  let size = "";
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) size = ` (${Math.round(raw.length / 1024).toLocaleString()} KB)`;
  } catch { /* storage unreadable; the count still tells the story */ }
  $("storeline").textContent = n
    ? `${n} trade${n === 1 ? "" : "s"} held in this browser${size}.`
    : "Nothing stored yet.";
}

$("save").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(
    {trades: window.TRADES, start: window.START, saved: new Date().toISOString()},
    null, 1)], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "traders-diary-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$("load").addEventListener("click", () => $("loadpick").click());
$("loadpick").addEventListener("change", async () => {
  const f = $("loadpick").files[0];
  if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (!Array.isArray(o.trades)) throw new Error("no trades in that file");
    window.TRADES = o.trades;
    window.START = o.start ?? null;
    const warn = save(window.TRADES, window.START);
    renderPanels();
    storeLine();
    if (warn) { say(warn, true); return; }
    say(`Restored ${o.trades.length} trades from the backup.`);
    location.hash = "";
  } catch (e) {
    say("That is not a Traders Diary backup: " + e.message, true);
  }
});

$("wipe").addEventListener("click", () => {
  if (!window.TRADES.length) { say("There is nothing stored to erase."); return; }
  if (!confirm(`Erase all ${window.TRADES.length} trades from this browser? `
             + `This cannot be undone unless you saved a backup.`)) return;
  PROF.remove(KEY);
  window.TRADES = [];
  window.START = null;
  renderPanels();
  storeLine();
  say("Erased. Drop your exports in again whenever you want to start over.");
});

// Whole and half-hour offsets cover every zone anyone actually trades from.
const ZONES = [];
for (let h = -12; h <= 14; h += 0.5) ZONES.push(h);
const tzSel = $("tz");
tzSel.innerHTML = ZONES.map(h => {
  const sign = h < 0 ? "-" : "+";
  const a = Math.floor(Math.abs(h)), b = Math.abs(h) % 1 ? "30" : "00";
  return `<option value="${h}">UTC${sign}${String(a).padStart(2, "0")}:${b}</option>`;
}).join("");
tzSel.value = String(tzOffset());
tzSel.addEventListener("change", () => {
  PROF.set(TZ_KEY, tzSel.value);
  E.setLocalOffset(parseFloat(tzSel.value));
  say("Saved. Re-import a session for the New York clock check to use it.");
});

/* Which clock the screen is read in, which is a different question from which
   clock the export was written in. New York by default: it is what the
   session is measured in and what TradingView prints. */
const showSel = $("showtz");
showSel.value = displayZone();
showSel.addEventListener("change", () => {
  PROF.set(SHOW_TZ_KEY, showSel.value);
  C.setZone(showSel.value);
  C.reset();
  renderPanels();
  DIARY.redraw();
  DEMO.redraw();
  RP.redraw();
  say(showSel.value === "device"
      ? "Times now follow this device."
      : "Times now match your TradingView charts.");
});

/* --------------------------------------------------------------- learn */

/* The lessons are ranked by what these mistakes actually cost, in money, in
   this record. A generic list of trading mistakes is worth nothing; the one
   you keep paying for is worth reading. */
const LESSON = {
  "trailed early": ["Tightening the stop before your own rule says to",
    "Your rule holds the stop until price has run about twice what you risked. "
    + "Moving it in earlier turns a trade you were right about into a small loss, "
    + "and it is the single most common thing in this record."],
  "stopped into the news": ["Leaving a stop where a data release can reach it",
    "US data lands at 08:30 and 10:00 New York, and the Fed at 14:00. In the "
    + "minute before, the market reaches for resting stops. A stop just past the "
    + "last few highs or lows is the easiest one to take."],
  "cut short": ["Coming out before the target price then reached anyway",
    "The read was right and the exit was early. Worth separating from the times "
    + "leaving early saved you, which the diary marks differently."],
  "closed early": ["Closing by hand well short of the target",
    "Banking a winner is fine. Doing it at a third of the planned move, every "
    + "time, means the target was never the trade you were actually managing."],
  "right, stopped early": ["Right direction, stop inside the noise",
    "Price went your way after stopping you out. The read was not the problem; "
    + "the stop was closer than the market's normal wobble."],
  "slipped": ["Stops filling worse than they were set",
    "A stop is a market order. Once touched it takes whatever price is there, "
    + "so the loss comes out bigger than the one you chose. Size for that."],
  "stop wrong side": ["A stop moved past the entry",
    "Placed the wrong side of the market it is already triggered, so it fills "
    + "the instant it lands."],
  "target far out": ["Targets set beyond what the trade was managed for",
    "A target far enough away that you were never going to hold for it makes "
    + "every exit look premature and every R figure meaningless."],
  "no R": ["Trades with no stop on record",
    "R is defined by the risk you take. No stop means no R, and no position "
    + "size that could have been worked out in advance."],
  "stopped fast": ["Stopped inside a minute",
    "Entering where the stop is one wobble away. Usually a sign of entering "
    + "before the setup finished rather than of a bad read."],
};

function renderLearn() {
  const mine = window.TRADES.filter(t => (t.source || "live") === "live");
  const cost = new Map();
  for (const t of mine)
    for (const f of (t.flags || [])) {
      const c = cost.get(f) || {n: 0, lost: 0};
      c.n++;
      if (t.pnl < 0) c.lost += -t.pnl;
      cost.set(f, c);
    }

  const ranked = [...cost.entries()]
    .filter(([f]) => LESSON[f])
    .sort((a, b) => (b[1].lost - a[1].lost) || (b[1].n - a[1].n))
    .slice(0, 6);

  $("lessons").innerHTML = mine.length
    ? (ranked.map(([f, c]) => {
        const [title, body] = LESSON[f];
        const bill = c.lost
          ? ` It appears on losses totalling ${dollars(-c.lost)}.`
          : " It has not cost you money yet.";
        return `<li><span class="ln">${c.n}</span><span class="lt">`
          + `<b>${esc(title)}</b><span>${esc(body + bill)}</span></span></li>`;
      }).join("")
      || '<li><span class="ln">0</span><span class="lt"><b>Nothing flagged yet'
         + '</b><span>Import a few more sessions and the pattern shows up '
         + 'here.</span></span></li>')
    : '<li><span class="ln">&mdash;</span><span class="lt"><b>Nothing imported '
      + 'yet</b><span>This list is built from your own trades, so it fills in '
      + 'once the Diary has some.</span></span></li>';

  const rows = [];
  const row = (state, label, detail) => rows.push(
    `<li class="stand ${state}"><span class="sl2">${esc(label)}</span>`
    + `<span class="sd">${detail}</span></li>`);

  row("no", "The strategy is not proven",
    "It fails walk-forward because the folds are too thin, and fails the "
    + "second-source check because no independent futures feed is free. One "
    + "configuration ever showed support, at about $500 a month on $50,000. "
    + "Everything else tested came out negative or indistinguishable from zero.");
  row("no", "Two filters were built, tested and rejected",
    "An exhaustion rule and a news blackout. Both sounded right. Measured "
    + "properly, the trades each one refused made more than the trades it kept, "
    + "so neither was kept. A filter that is not measured is a superstition.");
  row("warn", "This page can only tell you what you did",
    "It has no opinion on whether your strategy works, and a run of green "
    + "numbers over a handful of trades is not evidence. Do not size up because "
    + "a page looks encouraging.");

  const n = window.TRADES.filter(t => (t.source || "live") === "live").length;
  if (n)
    row(n >= 100 ? "ok" : "warn", `You have ${n} live trade${n === 1 ? "" : "s"}`,
      n >= 100
        ? "Enough to read an expectancy from, though one month is one market regime."
        : `About 100 are needed before a win rate means anything. At ${n}, this `
          + `describes what happened rather than what tends to happen.`);
  $("proof").innerHTML = rows.join("");
}

/** What the revisit model is actually built on, stated rather than implied. */
async function showRevisitFacts() {
  const el = $("rvstats");
  if (!el || el.dataset.done) return;
  el.dataset.done = "1";
  try {
    const r = await fetch("bars/NQ_5m.json", {cache: "no-cache"});
    if (!r.ok) throw new Error("no bars");
    const j = await r.json();
    const bars = [];
    j.bars.forEach((b, i) => {
      if (b) bars.push({ms: (j.t0 + i * j.step) * 1000,
                        o: b[0], h: b[1], l: b[2], c: b[3]});
    });
    const m = RV.build(bars);
    if (!m.obs) throw new Error("not enough history");
    el.innerHTML = [
      stat("days of history", String(m.days)),
      stat("observations", m.obs.toLocaleString("en-US")),
      stat("base rate", RV.pct(m.base)),
      stat("average daily range", Math.round(m.adr).toLocaleString("en-US")),
    ].join("");
    $("rvnote").textContent = `Measured on NQ five-minute bars. Across the whole `
      + `history, an untapped previous-day level was tapped before the close `
      + `${RV.pct(m.base)} of the time. That is the number every estimate is `
      + `pulled toward when its own bucket is thin.`;
  } catch (e) {
    el.innerHTML = stat("history", "not loaded");
    $("rvnote").textContent = "The published bars could not be read, so there "
      + "is nothing to measure this from yet.";
  }
}

/* ---------------------------------------------------------------- tabs */

/* One app, several tabs. The tab is kept in the URL hash so the back button
   works and so a tab can be linked to, which matters once this is on a home
   screen and reopening should land where it was left.

   Read from the buttons rather than written out here. A hand-kept list drifts:
   adding the Demo tab left it off, so clicking Demo silently fell back to the
   Diary and the pane never opened. */
const TABNAMES = [...document.querySelectorAll(".tb")].map(b => b.dataset.go);
// Where a fresh open lands, and what an unknown hash falls back to.
const HOME = TABNAMES[0] || "diary";

function goTab(name, push) {
  if (!TABNAMES.includes(name)) name = HOME;
  document.querySelectorAll(".tabpane").forEach(p => {
    p.hidden = p.dataset.tab !== name;
  });
  document.querySelectorAll(".tb").forEach(b => {
    b.setAttribute("aria-selected", String(b.dataset.go === name));
  });
  if (push && location.hash.slice(1) !== name) location.hash = name;
  scrollTo({top: 0, behavior: "instant"});

  // A canvas sized while its pane was hidden has no width, so both charts are
  // redrawn on the way in rather than on the way out.
  if (name === "diary") {
    try { window.drawEq(); } catch { /* nothing loaded yet */ }
    DIARY.redraw();
  }
  if (name === "replay") RP.redraw();
  if (name === "demo") DEMO.redraw();
  if (name === "system") SYS.show();
  if (name === "learn") showRevisitFacts();
  if (name === "home") DASH.show();
}

document.querySelector(".tabs2").addEventListener("click", e => {
  const b = e.target.closest(".tb");
  if (b) goTab(b.dataset.go, true);
});
// The dashboard's jump buttons carry the same data-go as the nav.
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-go]");
  if (!b || b.classList.contains("tb")) return;
  goTab(b.dataset.go, true);
  // Import goes one step further than the tab it lives on: it opens the file
  // picker too, so "import my trades" is one tap rather than a tab, a scroll
  // and a hunt for the right panel. Still inside the click, which is what
  // lets a browser open a file dialog at all.
  if (b.dataset.import) $("pick").click();
});
addEventListener("hashchange", () => goTab(location.hash.slice(1), false));

/* The equity curve measures its own width to draw. Folded inside a closed
   <details> that width is zero, so it has to be told when the fold opens. */
document.addEventListener("toggle", e => {
  if (e.target.classList && e.target.classList.contains("more") && e.target.open)
    try { window.drawEq(); } catch { /* nothing imported yet */ }
}, true);

/* --------------------------------------------------------- your own note */

/* "What was I thinking" is the one thing a journal cannot work out for you,
   and it is the thing worth most a month later. Kept against the trade rather
   than in a separate file, so a backup carries it too. */
const noteBox = $("mynotebox"), noteSaved = $("mynotesaved");
let noteTimer = null;

function keyOf(t) { return t.symbol + "|" + t.open_t; }

window.showMyNote = function (t) {
  if (!noteBox) return;
  noteBox.value = t && t.mine ? t.mine : "";
  noteBox.dataset.key = t ? keyOf(t) : "";
  noteBox.disabled = !t;
  noteSaved.textContent = "";
};

if (noteBox) {
  noteBox.addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteSaved.textContent = "typing...";
    // Saving on every keystroke rewrites the whole store each time, which on a
    // phone with a few hundred trades is felt. A short pause is enough.
    noteTimer = setTimeout(() => {
      const t = window.TRADES.find(x => keyOf(x) === noteBox.dataset.key);
      if (!t) return;
      const v = noteBox.value.trim();
      if (v) t.mine = v; else delete t.mine;
      const warn = save(window.TRADES, window.START);
      noteSaved.textContent = warn
        ? "Could not save: this browser is blocking storage."
        : "Saved to this device.";
    }, 600);
  });
}

/** Trades imported before the bars were published can still get their chart. */
function fillCandles() {
  let filled = 0;
  for (const t of window.TRADES)
    if (E.attachBars(t, BARS[E.FEED[t.symbol]], tzOffset())) {
      E.analyseExcursion(t);
      filled++;
    }
  if (filled) {
    save(window.TRADES, window.START);
    renderPanels();
  }
}

/* ---------------------------------------------------------- the lock */

/* A passcode encrypts the record rather than hiding it behind a screen, so
 * the honest warnings matter more than the buttons: there is no reset, and
 * the backup file is the only way back. */

const gate = $("lockgate");

/* The PIN screen.
 *
 * Two jobs in one box, because from where you are standing they are the same
 * question. A PIN that opens a journal on this device opens it. A PIN that
 * opens none offers to start one. That is the whole of it: no sign up, no
 * account, no list of journals to pick from, and nothing that says whether
 * anyone else has one here.
 */
function showGate(msg, mode) {
  const first = !PROF.list().length;
  // Somebody who used this before PINs existed already has a journal and a
  // code for it. Telling them to "set" one reads like being asked to start
  // over, and the code they would then type is the one they already had.
  const carryOver = first && PROF.hasLegacy();
  gate.hidden = false;
  gate.dataset.mode = mode || (first && !carryOver ? "new" : "open");
  const isNew = gate.dataset.mode === "new";
  $("locktitle").textContent = isNew ? "Set your PIN"
    : carryOver ? "Enter your passcode" : "Enter your PIN";
  $("locklead").textContent = isNew
    ? "Four digits. This is what your journal is kept under, so everything "
      + "you import belongs to this PIN and nobody else's does."
    : carryOver
      ? "Your journal is already here. Enter the passcode you set for it and "
        + "it carries across to a PIN, with everything in it."
      : "This journal is encrypted. Your PIN opens it.";
  $("lockgo").textContent = isNew ? "Start my journal" : "Open";
  $("lockpin").value = "";
  $("lockmsg").hidden = !msg;
  $("lockmsg").textContent = msg || "";
  $("locknew").hidden = isNew || first;
  $("lockpin").focus();
}

/** Everything that has to happen once a journal is actually open. */
async function opened(pin) {
  PASSCODE = pin;
  // A journal left by the version before PINs is taken over rather than
  // stranded, so nobody has to export and import their own record to get
  // past a change they did not ask for.
  const moved = PROF.hasLegacy() ? PROF.adoptLegacy() : 0;

  STATE = load();
  if (STATE.sealed) {
    try {
      const body = await LOCK.unlock(JSON.parse(PROF.get(KEY)), pin);
      window.TRADES = body.trades || [];
      window.START = body.start ?? null;
    } catch {
      // The journal opened but its contents will not, which means the store
      // was written under a different PIN. Say so rather than showing an
      // empty diary that looks like lost data.
      showGate("This journal opened but its trades are locked with a "
             + "different code. Restore from a backup file.");
      return false;
    }
  } else {
    window.TRADES = STATE.trades;
    window.START = STATE.start;
  }

  gate.hidden = true;
  DRAW.reload();
  E.setLocalOffset(tzOffset());
  C.setExportOffset(tzOffset);
  C.setZone(displayZone());
  if (tzSel) tzSel.value = String(tzOffset());
  if ($("showtz")) $("showtz").value = displayZone();
  renderPanels();
  storeLine();
  lockState();
  DEMO.reload();
  // The video library belongs to the journal too, and init() ran before there
  // was one.
  // Re-ask whether the trade on screen has a video, now that the library has
  // actually been read. redraw() only repaints the chart; the offer beside it
  // is set when a trade is shown, and that already happened.
  VID.reload().then(() => {
    const block = $("dvidblock");
    if (block) block.hidden = !VID.forTrade(DIARY.current());
  });
  loadBars(feedsFor(window.TRADES)).then(fillCandles);
  if (moved) say(`Your existing journal has been moved onto this PIN. `
               + `${window.TRADES.length} trades came with it.`);
  return true;
}

$("lockform").addEventListener("submit", async e => {
  e.preventDefault();
  const pin = $("lockpin").value.trim();
  if (!/^\d{4,}$/.test(pin)) {
    showGate("Four digits or more.", gate.dataset.mode);
    return;
  }
  const btn = $("lockgo");
  btn.disabled = true;
  btn.textContent = "One moment...";
  try {
    if (gate.dataset.mode === "new") {
      const made = await PROF.create(pin, "My journal");
      if (!made) {
        showGate("A journal on this device already uses that PIN. Enter it "
               + "to open that one, or pick different digits.", "open");
      } else {
        await opened(pin);
      }
    } else {
      let got = await PROF.open(pin);
      // Nothing to match against yet on a carry-over: the journal is there
      // but it predates profiles, so the PIN typed becomes its PIN.
      if (!got && !PROF.list().length && PROF.hasLegacy())
        got = await PROF.create(pin, "My journal");
      if (got) await opened(pin);
      else showGate("No journal on this device uses that PIN.");
    }
  } catch {
    showGate("Something went wrong opening that. Try again.");
  }
  // showGate owns the wording, so restoring what the button said before would
  // undo it: after being told a PIN is already in use the screen said "Enter
  // your PIN" over a button that still said "Start my journal".
  btn.disabled = false;
  if (btn.textContent === "One moment...")
    btn.textContent = gate.dataset.mode === "new" ? "Start my journal" : "Open";
});

$("locknew").addEventListener("click", () => showGate("", "new"));

function lockState() {
  const n = PROF.list().length;
  $("lockstate").textContent = PROF.isOpen()
    ? `Open, and encrypted with your PIN, which is forgotten the moment you `
      + `close the app. ${n === 1 ? "This is the only journal on this device."
                                  : n + " journals on this device."}`
    : "No journal is open.";
  $("setlock").disabled = !LOCK.available() || !PROF.isOpen();
}

function setMsg(text, bad) {
  const el = $("setmsg");
  el.textContent = text || "";
  el.classList.toggle("bad", !!bad);
  el.hidden = !text;
}

function openSetPanel() {
  $("settitle").textContent = PASSCODE === null
    ? "Set a passcode" : "Change the passcode";
  // The acknowledgement is about losing the record, which only bites the
  // first time. Changing a passcode you already have is not that.
  $("ack").closest("label").hidden = PASSCODE !== null;
  $("ack").checked = PASSCODE !== null;
  $("pin1").value = $("pin2").value = "";
  $("strength").hidden = true;
  setMsg("");
  $("setpanel").hidden = false;
  $("pin1").focus();
}

$("setlock").addEventListener("click", () => {
  if (!LOCK.available()) return;
  if ($("setpanel").hidden) openSetPanel();
  else $("setpanel").hidden = true;
});

$("setcancel").addEventListener("click", () => { $("setpanel").hidden = true; });
$("setbackup").addEventListener("click", () => $("save").click());

/* How long this passcode would actually stand up.
 *
 * Not a scolding meter. The number that matters is how many guesses there
 * are, because someone who copies the encrypted record can try them offline
 * as fast as their hardware allows, with nothing to stop them.
 *
 * The stretching costs a phone about a quarter of a second per guess, which
 * is why a four-digit PIN is fine against someone tapping your app icon and
 * useless against someone who takes a copy away with them. Length is the only
 * thing that changes that: every extra character multiplies the work.
 */
function strengthOf(pin) {
  if (!pin) return null;
  const digits = /^[0-9]+$/.test(pin);
  const sets = (/[a-z]/.test(pin) ? 26 : 0) + (/[A-Z]/.test(pin) ? 26 : 0)
             + (/[0-9]/.test(pin) ? 10 : 0) + (/[^A-Za-z0-9]/.test(pin) ? 32 : 0);
  const combos = Math.pow(sets || 10, pin.length);

  if (digits && pin.length <= 6) {
    const n = Math.pow(10, pin.length).toLocaleString("en-US");
    return {level: "weak", text: `${pin.length} digits is <b>${n} `
      + `combinations</b>. That stops someone picking up your phone and tapping `
      + `the icon, which is the likely case. It does not stop anyone who copies `
      + `the locked record and works through every number offline. Adding a few `
      + `letters or words changes that completely.`};
  }
  if (combos < 1e14) {
    return {level: "fair", text: "Short enough to be worth guessing at. A "
      + "second word, or a few more characters, is worth more here than "
      + "swapping letters for symbols."};
  }
  return {level: "good", text: "Long enough that guessing it is not the way "
    + "in. Make sure you will remember it: there is no reset."};
}

$("pin1").addEventListener("input", () => {
  const s = strengthOf($("pin1").value);
  const el = $("strength");
  el.hidden = !s;
  if (!s) return;
  el.className = "strength " + s.level;
  el.innerHTML = s.text;
});

$("setform").addEventListener("submit", async e => {
  e.preventDefault();
  const pin = $("pin1").value, again = $("pin2").value;
  if (pin.length < 4) { setMsg("A passcode needs at least four characters.", true); return; }
  if (pin !== again) { setMsg("Those two do not match.", true); return; }
  if (!$("ack").checked) {
    setMsg("Tick the box first. This one really cannot be undone.", true);
    return;
  }

  const btn = $("setgo");
  btn.disabled = true;
  btn.textContent = "Locking...";
  try {
    // The record and the journal's own check blob both move to the new PIN,
    // and only after BOTH have been produced. Re-keying one and failing on
    // the other would leave a journal whose PIN opens it but whose trades it
    // cannot read, which is a worse place to be than not having changed it.
    const env = await LOCK.lock(
      {trades: window.TRADES, start: window.START, saved: Date.now()}, pin);
    const rekeyed = await PROF.rekey(pin);
    if (!rekeyed) throw new Error("the journal would not take the new PIN");
    PROF.set(KEY, JSON.stringify(env));
    PASSCODE = pin;
    $("setpanel").hidden = true;
    lockState();
    storeLine();
    say("Done. This journal opens with that PIN on this device from now on. "
      + "Your backup file is still unencrypted, so keep it somewhere you "
      + "trust. This does not change your other devices: do the same on each.");
  } catch (err) {
    // Nothing was written, so nothing was lost.
    setMsg("The record could not be locked, so nothing changed.", true);
  }
  btn.disabled = false;
  btn.textContent = "Lock it";
});

/* Lock, and let somebody else in.
 *
 * Reloading rather than just hiding things: half the app is holding this
 * journal's trades, drawings and account in memory, and the only way to be
 * certain none of it is still on screen for the next person is to start the
 * page again. It costs a second and it cannot leak.
 */
$("locknow").addEventListener("click", () => {
  PROF.close();
  PASSCODE = null;
  location.reload();
});

/* --------------------------------------------------------- installing */

/* Getting this onto a home screen is the whole point, and on an iPhone it
 * cannot be done for you: Safari has no install prompt and Apple allows no
 * other route, so the only thing that works is naming the exact button. Every
 * other browser can be asked directly, so it is.
 *
 * The banner takes itself away once the app is actually installed, which is
 * what `display-mode: standalone` means. */
const INSTALL_KEY = "tradersdiary.installed";
const instbar = $("installbar"), steps = $("inststeps");
const go = $("instgo"), no = $("instno");
let prompt_ = null;

const standalone = () => matchMedia("(display-mode: standalone)").matches
  || navigator.standalone === true;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  // An iPad on iPadOS 13+ reports itself as a Mac, and the touch points are
  // the only thing that gives it away.
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function showInstall() {
  if (standalone()) return;
  try { if (localStorage.getItem(INSTALL_KEY) === "no") return; } catch { /* fine */ }

  if (prompt_) {
    steps.innerHTML = "One tap and it lives on your device: full screen, your "
      + "record kept, and it still works with no signal.";
    go.hidden = false;
  } else if (isIOS()) {
    steps.innerHTML = "In <b>Safari</b>, tap the <b>share button</b> at the "
      + "bottom of the screen, scroll down, and choose "
      + "<b>Add to Home Screen</b>. There is no download: that is how an app "
      + "gets onto an iPhone from outside the App Store.";
  } else if (/Macintosh/.test(navigator.userAgent)) {
    steps.innerHTML = "In <b>Safari</b>, open the <b>share menu</b> and choose "
      + "<b>Add to Dock</b>. In <b>Chrome</b>, click the install icon at the "
      + "right of the address bar.";
  } else {
    steps.innerHTML = "In <b>Chrome</b> or <b>Edge</b>, open the browser menu "
      + "and choose <b>Install</b>, or click the install icon in the address bar.";
  }
  instbar.hidden = false;
}

addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  prompt_ = e;
  showInstall();
});

go.addEventListener("click", async () => {
  if (!prompt_) return;
  go.disabled = true;
  try {
    prompt_.prompt();
    const {outcome} = await prompt_.userChoice;
    if (outcome === "accepted") instbar.hidden = true;
  } catch { /* the prompt can only be used once */ }
  prompt_ = null;
  go.disabled = false;
  go.hidden = true;
});

no.addEventListener("click", () => {
  instbar.hidden = true;
  try { localStorage.setItem(INSTALL_KEY, "no"); } catch { /* fine */ }
});

addEventListener("appinstalled", () => {
  instbar.hidden = true;
  try { localStorage.setItem(INSTALL_KEY, "yes"); } catch { /* fine */ }
});

showInstall();

/* ----------------------------------------------------------------- go */

if (STATE.broken)
  say("The stored record could not be read, so the diary started empty. Your "
    + "old data has not been deleted. Restore from a backup, or import again.", true);

E.setLocalOffset(tzOffset());
// The clock has to know both halves before anything is drawn: how to read a
// stored stamp, and which zone to print it in.
C.setExportOffset(tzOffset);
C.setZone(displayZone());

/* Nothing is shown before a PIN.
 *
 * Not for secrecy so much as for ownership: until a journal is open there is
 * no answer to whose trades these would be. Drawing an empty diary first and
 * asking afterwards is how the app used to look like it had lost everything.
 */
window.TRADES = [];
window.START = null;
renderPanels();
storeLine();
lockState();
showGate("");

/** Take trades from Replay or Demo into the Diary, ignoring any already there.
 *
 *  Keyed on source as well as symbol and time, so a demo trade and a replay
 *  trade on the same bar stay separate, and sending twice adds nothing. */
function intoDiary(incoming, source) {
  const key = t => (t.source || source) + "|" + t.symbol + "|" + t.open_t;
  const byKey = new Map(window.TRADES.map(t => [key(t), t]));
  let added = 0;
  for (const t of incoming) {
    if (byKey.has(key(t))) continue;
    byKey.set(key(t), t);
    added++;
  }
  window.TRADES = [...byKey.values()].sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
  save(window.TRADES, window.START);
  renderPanels();
  storeLine();
  return added;
}

RP.setClock(tzOffset);
RP.init(practice => intoDiary(practice, "replay"));

DIARY.setClock(tzOffset);
/* The video of the trade you are looking at, offered only when it is actually
   here. A button that does nothing is worse than no button. */
DIARY.setOnShow(t => {
  const block = $("dvidblock");
  if (block) block.hidden = !VID.forTrade(t);
});
const vidBtn = $("dvid");
if (vidBtn) vidBtn.addEventListener("click", () => {
  const t = DIARY.current();
  if (t && VID.playTrade(t)) goTab("videos", true);
});
// The shared page script calls pick(); this is what it hands over to.
window.__diaryPick = i => DIARY.pick(i);
DIARY.init();

VID.init();

DEMO.setClock(tzOffset);
DEMO.init(
  trades => intoDiary(trades, "demo"),
  // A demo trade that settles while you are looking at another tab should
  // still show up in the numbers when you come back to them.
  () => { renderPanels(); storeLine(); });

goTab(location.hash.slice(1) || HOME, false);

/* --------------------------------------------------------- new versions */

/* The shell is served from cache so the app works with no signal, which means
   a new version would otherwise never arrive: the cached page would be served
   forever. So an update is noticed and offered, rather than either forced on
   you mid-sentence or hidden from you completely. */
function apply(reg) {
  // Ask the waiting worker to take over, then reload once it has.
  if (reg.waiting) reg.waiting.postMessage("skip-waiting");
  setTimeout(() => location.reload(), 400);
}

/* Whether it is safe to update without asking.
 *
 * Updating is a reload, and a reload throws away anything not written down.
 * Almost everything here is saved the moment it happens, so almost always it
 * is safe. The exceptions are a note being typed, a replay position still
 * open, and an import mid-flight. */
function busy() {
  // An update is a reload, and a reload sends you back to the PIN screen.
  // That is safe but it is not something to do to somebody mid-session over
  // a change they did not ask for, so it waits for the app to be closed.
  if (PROF.isOpen()) return "a journal open";
  const el = document.activeElement;
  if (el && /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) return "typing";
  const box = $("mynotebox");
  if (box && !box.disabled) {
    const t = window.TRADES.find(x =>
      x.symbol + "|" + x.open_t === box.dataset.key);
    if (box.value.trim() !== ((t && t.mine) || "").trim()) return "an unsaved note";
  }
  if (RP.inTrade()) return "a replay position still open";
  if (DEMO.inTrade()) return "a demo position still open";
  if (document.getElementById("drop").classList.contains("busy")) return "an import";
  return null;
}

function offerUpdate(reg) {
  if (document.getElementById("updbar")) return;

  // Auto-update is the whole point of it being an app: nobody should have to
  // think about versions. It only holds back when a reload would lose work.
  const held = busy();
  if (!held) { apply(reg); return; }

  const el = document.createElement("div");
  el.id = "updbar";
  // The reason it is waiting was written for whoever built it. What matters
  // to whoever is holding the phone is that nothing needs doing.
  el.innerHTML = "<span>A new version is ready. It installs next time you "
    + "open the app.</span>"
    + '<button class="bigbtn" id="updgo">Update now</button>'
    + '<button class="instx" id="updno">Later</button>';
  document.body.appendChild(el);
  document.getElementById("updgo").addEventListener("click", () => apply(reg));
  let dismissed = false;
  document.getElementById("updno").addEventListener("click", () => {
    dismissed = true;
    el.remove();
  });

  // Keep checking, and take the first quiet moment.
  const t = setInterval(() => {
    if (dismissed || !document.body.contains(el)) { clearInterval(t); return; }
    if (!busy()) { clearInterval(t); apply(reg); }
  }, 4000);
}

if ("serviceWorker" in navigator) {
  addEventListener("load", async () => {
    let reg;
    try { reg = await navigator.serviceWorker.register("sw.js"); }
    catch { return; }               // offline support is a bonus, not a need

    // Already waiting when the page opened.
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg);

    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        // A worker that reaches "installed" with no controller is the very
        // first install, which is not an update and must not say it is.
        if (sw.state === "installed" && navigator.serviceWorker.controller)
          offerUpdate(reg);
      });
    });

    // A phone keeps the app alive for days, so a check on every foreground is
    // the difference between updating this week and updating next month.
    addEventListener("visibilitychange", () => {
      if (!document.hidden) reg.update().catch(() => { /* offline */ });
    });
  });
}
