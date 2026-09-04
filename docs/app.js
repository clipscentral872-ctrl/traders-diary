/* The app around the diary: storage, the six-file import, and the panels the
 * desktop version renders on the server.
 *
 * Everything here runs in your browser. Your exports are never uploaded, and
 * the record is kept in this browser's own storage, so the diary works with
 * no signal and no account.
 */
import * as E from "./engine.js";

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

if ("serviceWorker" in navigator)
  addEventListener("load", () => navigator.serviceWorker.register("sw.js")
    .catch(() => { /* offline support is a bonus, not a requirement */ }));
