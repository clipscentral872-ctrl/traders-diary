/* The app around the diary: storage, the six-file import, and the panels the
 * desktop version renders on the server.
 *
 * Everything here runs in your browser. Your exports are never uploaded, and
 * the record is kept in this browser's own storage, so the diary works with
 * no signal and no account.
 */
import * as E from "./engine.js";
import * as RP from "./replay.js";
import * as SYS from "./system.js";

const $ = id => document.getElementById(id);
const KEY = "tradersdiary.v1";
const TZ_KEY = "tradersdiary.tz";

/* ------------------------------------------------------------- storage */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {trades: [], start: null};
    const o = JSON.parse(raw);
    return {trades: o.trades || [], start: o.start ?? null};
  } catch {
    // A corrupt or unreadable store must not leave a blank screen with no
    // explanation, and must not be silently overwritten either.
    return {trades: [], start: null, broken: true};
  }
}

function save(trades, start) {
  try {
    localStorage.setItem(KEY, JSON.stringify({trades, start, saved: Date.now()}));
    return null;
  } catch (e) {
    return "This browser would not store the record, most likely because it is "
         + "full or because private browsing blocks storage. Your trades are on "
         + "screen but will be gone when you close the tab. Save a backup file.";
  }
}

let STATE = load();
window.TRADES = STATE.trades;
window.START = STATE.start;

const tzOffset = () => {
  const v = parseFloat(localStorage.getItem(TZ_KEY));
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

const SOURCES = [["live", "Live"], ["replay", "Replay"], ["all", "All"]];
const SOURCE_NOTE = {
  live: "Trades you actually placed.",
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
  $("ntrades").textContent = all.length;

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
    save(window.TRADES, window.START);
    renderPanels();
    storeLine();
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
  localStorage.removeItem(KEY);
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
  localStorage.setItem(TZ_KEY, tzSel.value);
  E.setLocalOffset(parseFloat(tzSel.value));
  say("Saved. Re-import a session for the New York clock check to use it.");
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

/* ---------------------------------------------------------------- tabs */

/* Four tabs, one app. The tab is kept in the URL hash so the back button
   works and so a tab can be linked to, which matters once this is on a home
   screen and reopening should land where it was left. */
const TABNAMES = ["diary", "replay", "system", "learn"];

function goTab(name, push) {
  if (!TABNAMES.includes(name)) name = "diary";
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
  if (name === "diary") { try { window.drawEq(); window.draw(); } catch { /* nothing loaded */ } }
  if (name === "replay") RP.redraw();
  if (name === "system") SYS.show();
}

document.querySelector(".tabs2").addEventListener("click", e => {
  const b = e.target.closest(".tb");
  if (b) goTab(b.dataset.go, true);
});
addEventListener("hashchange", () => goTab(location.hash.slice(1), false));

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
renderPanels();
storeLine();
loadBars(feedsFor(window.TRADES)).then(() => {
  // Trades imported before the bars were published can still get their chart.
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
});

RP.setClock(tzOffset);
RP.init(practice => {
  const byKey = new Map(window.TRADES.map(t => [t.source + "|" + t.symbol + "|" + t.open_t, t]));
  let added = 0;
  for (const t of practice) {
    const k = "replay|" + t.symbol + "|" + t.open_t;
    if (byKey.has(k)) continue;
    byKey.set(k, t);
    added++;
  }
  window.TRADES = [...byKey.values()].sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
  save(window.TRADES, window.START);
  renderPanels();
  storeLine();
  return added;
});

goTab(location.hash.slice(1) || "diary", false);

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
  const el = document.activeElement;
  if (el && /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) return "typing";
  const box = $("mynotebox");
  if (box && !box.disabled) {
    const t = window.TRADES.find(x =>
      x.symbol + "|" + x.open_t === box.dataset.key);
    if (box.value.trim() !== ((t && t.mine) || "").trim()) return "an unsaved note";
  }
  if (RP.inTrade()) return "a replay position still open";
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
  el.innerHTML = `<span>A new version is ready. It will install by itself once `
    + `you are done, because right now there is ${held}.</span>`
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
