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
import * as IND from "./inds.js";
import * as SYS from "./system.js";
import * as LOCK from "./lock.js";
import * as RV from "./revisit.js";
import * as DASH from "./dashboard.js";
import * as VID from "./videos.js";
import * as DIARY from "./diary.js";
import * as DRAW from "./draw.js";
import * as W from "./whatif.js";
import * as FS from "./folder.js";
import * as FUND from "./funded.js";
import * as JD from "./jdun.js";
import * as Q from "./quests.js";
import * as COACH from "./coach.js";

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
/* The five minute series, kept beside the minute one. The minute history has
   holes and a trade inside one can still be drawn at five. */
const SLOW = {};
const pending = new Map();

/** Load the published bars for these contracts only.
 *
 *  Each file is around 300 KB, so pulling all four on a phone to draw one NQ
 *  trade is most of a megabyte wasted. Only what the record actually contains
 *  is fetched, and each file only once. */
async function loadBars(symbols) {
  const want = [...new Set(symbols.filter(Boolean))];
  await Promise.all(want.map(sym => {
    if (BARS[sym] || SLOW[sym]) return null;
    if (pending.has(sym)) return pending.get(sym);
    const p = (async () => {
      /* A flat array on a fixed grid: a bar's time is where it sits, and a
         minute the market did not trade is a null that is dropped here. */
      const read = async tf => {
        const r = await fetch(`bars/${sym}_${tf}.json`, {cache: "no-cache"});
        if (!r.ok) return null;
        const j = await r.json();
        const out = [];
        j.bars.forEach((b, i) => {
          if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                           o: b[0], h: b[1], l: b[2], c: b[3]});
        });
        return out;
      };
      try {
        // Both, because the minute history has holes and a trade inside one
        // of them can still be drawn at five minutes.
        const [m1, m5] = await Promise.all([
          read("1m").catch(() => null), read("5m").catch(() => null)]);
        if (m1) BARS[sym] = m1;
        if (m5) SLOW[sym] = m5;
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
  renderAccounts();
  const all = window.ofAccount(window.TRADES);
  // One trade is not "1 trades". The whole phrase is written here rather
  // than a number beside a fixed word, which cannot be made to agree.
  /* The corner of the bar says what is in the journal. With balances and no
     fills it used to say "no trades", which is true and reads as "empty". */
  const sessions = balancesNow().filter(b => window.ACCOUNT === "all"
    || (b.account || "") === window.ACCOUNT).length;
  $("appmeta").textContent =
      all.length === 1 ? "1 trade"
    : all.length ? `${all.length} trades`
    : sessions ? `${sessions} session${sessions === 1 ? "" : "s"}`
    : "no trades";

  const present = SOURCES.filter(([k]) =>
    all.some(t => k === "all" || (t.source || "live") === k));
  const usable = present.length > 1 ? present : present.slice(0, 1);

  const buttons = usable.map(([k, label]) => {
    const n = all.filter(t => k === "all" || (t.source || "live") === k).length;
    return `<button class="src" data-src="${k}" onclick="pickSource('${k}')">`
         + `${label}<span class="sn">${n}</span></button>`;
  }).join("");
  $("srcrow").innerHTML = buttons;
  // The same choice, drawn again next to the trade browser. With one kind of
  // trade there is nothing to choose, so there it stays empty and hidden.
  const mini = $("srcrow2");
  if (mini) mini.innerHTML = usable.length > 1 ? buttons : "";

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
  renderQuests();
  renderCoach();
  renderOrphans();
  renderDays();
  renderGroups();
  renderHabits();
  renderLearn();
  DASH.refreshRecord();
  DIARY.pick(0);
  /* Whatever is being looked at stays being looked at.
   *
   * This snapped back to Live on every redraw, and a redraw happens whenever
   * anything is added. So sending demo trades to the Diary moved you off the
   * source that holds them, in the same breath as saying they had arrived. */
  const want = document.querySelector(`.src[data-src="${window.curSource}"]`)
            || document.querySelector('.src[data-src="live"]')
            || document.querySelector(".src");
  window.pickSource(want ? want.dataset.src : "live");
}

/** Where the record actually stands, worked out every time it is drawn. */
function renderStanding() {
  const rows = [];
  const row = (state, label, detail) => rows.push(
    `<li class="stand ${state}"><span class="sl2">${esc(label)}</span>`
    + `<span class="sd">${detail}</span></li>`);

  const mine = window.ofAccount(window.TRADES)
    .filter(t => (t.source || "live") === "live");
  const n = mine.length;

  if (!n) {
    /* Balances without fills is a real state, not an empty journal, and it is
       exactly where a broken Tradovate export leaves you. Saying "nothing
       imported" there is wrong and sends you back to re-import files that
       did arrive. */
    const days = balancesNow().filter(b => window.ACCOUNT === "all"
      || (b.account || "") === window.ACCOUNT).length;
    if (days)
      row("warn", `${days} session${days === 1 ? "" : "s"} of balances, no trades`,
        "The day by day record above is from your broker's own balance "
        + "history. The trades inside those days need the Fills export, and "
        + "the stops need the orders panel, exported at the end of a session. "
        + "Until both are in, there is no R to measure and no trade to grade.");
    else
      row("warn", "Nothing imported yet",
        "Drop your exports above and this fills in. Until then there "
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
    say("Those are not CSV files. Export from TradingView, or from Tradovate, "
      + "then drop the files it gives you.", true);
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
    const peek = E.pairTrades(E.fillsFrom(files)).trades;
    await loadBars(feedsFor([...window.TRADES, ...peek]));
    const out = E.ingest(files, window.TRADES, BARS, offset, SLOW);

    window.TRADES = out.trades;
    // The broker's own daily balances, which is what the firm's drawdown is
    // actually measured against.
    keepBalances(out.balances);
    if (out.startBalance !== null &&
        (window.START === null || out.startBalance < window.START))
      window.START = out.startBalance;

    const warn = save(window.TRADES, window.START);
    renderPanels();
    renderFunded();

    const lines = [];
    /* Said first, because it changes what the rest of these numbers mean: a
       broker export carries the stop that was on the position, so trades get
       an R that TradingView's hour-long activity log could never give them. */
    for (const s of out.sources || []) {
      if (s.days != null) {
        lines.push(`Read ${s.days} day${s.days === 1 ? "" : "s"} of the `
          + `account's own balance from your ${s.name} export.`);
        continue;
      }
      lines.push(`Read ${s.fills} fill${s.fills === 1 ? "" : "s"} from your `
        + `${s.name} export`
        + (s.stops
           ? `, with ${s.stops} stop or target order${s.stops === 1 ? "" : "s"} `
             + `on them, which is where R comes from.`
           : `. It carries no stop orders, so R still needs the orders export `
             + `from the trading screen.`));
    }
    lines.push(out.added
      ? `${out.added} new trade${out.added === 1 ? "" : "s"} added. `
        + `${out.trades.length} on record.`
      : `Nothing new. All ${out.trades.length} of those trades were already here.`);
    // Said out loud, because it changes numbers you have already seen.
    if (out.repaired)
      lines.push(`${out.repaired} earlier trade${out.repaired === 1 ? " now has its" : "s now have their"} `
        + `stop, from the fuller activity log in these files, so ${out.repaired === 1 ? "it has" : "they have"} `
        + `an R where before ${out.repaired === 1 ? "it" : "they"} had none.`);

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

/* --------------------------------------------------- the funded account */

/* The rules that close a funded account have nothing to do with whether the
   trading was good, and none of them are visible while you trade. The firm's
   numbers are kept with the journal so two accounts on one device never share
   them, and the broker's own daily balances are kept beside them because they
   are what the drawdown is really measured against. */
const PLAN_KEY = "funded.plan";
const BAL_KEY = "funded.balances";

const planNow = () => {
  try {
    const saved = JSON.parse(PROF.get(PLAN_KEY));
    if (saved && typeof saved === "object") return {...FUND.preset(saved.id), ...saved};
  } catch { /* nothing kept yet */ }
  return FUND.preset(FUND.DEFAULT_PLAN);
};

const balancesNow = () => {
  try { return JSON.parse(PROF.get(BAL_KEY)) || []; } catch { return []; }
};

/** Keep the broker's days, newest reading of a day winning. */
/* Keyed on the account AND the date.
 *
 * Keyed on the date alone, two accounts that both traded on 8 October kept
 * one row between them: whichever file was read last won, and the other
 * account quietly lost that session out of its drawdown, its day list and
 * its figures. On Chris's own import it cost account 4439 three sessions,
 * including the day it lost $455. */
function keepBalances(days) {
  if (!days || !days.length) return;
  const key = d => (d.account || "") + "|" + d.date;
  const by = new Map(balancesNow().map(d => [key(d), d]));
  for (const d of days) by.set(key(d), d);
  const all = [...by.values()].sort((a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1
      : (a.account || "") < (b.account || "") ? -1 : 1));
  PROF.set(BAL_KEY, JSON.stringify(all));
}

const FIELDS = [
  ["start", "Starting balance", 1],
  ["drawdown", "Max drawdown", 1],
  ["qualifyingDay", "A day counts at", 1],
  ["minDays", "Days needed", 1],
  ["consistencyPct", "Best day limit %", 1],
  ["target", "Profit target", 1],
  ["maxMicros", "Max contracts", 1],
];

/* How many contracts, worked out where the room is.
 *
 * Risk first, stop second, size last. The arithmetic is three numbers and a
 * rounding down, and it is still the thing most easily got wrong in a hurry,
 * because the budget on a funded account is not a share of the balance: it is
 * the room left before the firm closes the account. So the answer is shown
 * against that room rather than against the equity. */
const SIZE_KEY = "funded.size";
const CONTRACTS = ["MNQ", "MES", "MYM", "M2K", "NQ", "ES", "YM", "RTY"];

const sizeNow = () => {
  try {
    const s = JSON.parse(PROF.get(SIZE_KEY));
    if (s && typeof s === "object") return {sym: "MNQ", stop: 40, risk: 200, ...s};
  } catch { /* first time */ }
  return {sym: "MNQ", stop: 40, risk: 200};
};

function sizerHtml(st) {
  const opts = CONTRACTS.map(c =>
    `<option value="${c}"${c === st.sym ? " selected" : ""}>${c}</option>`).join("");
  return '<div class="planform sizer">'
    + `<label>Contract<select id="sizesym">${opts}</select></label>`
    + `<label>Stop in points<input id="sizestop" type="number" step="any" `
    + `min="0" value="${st.stop}"></label>`
    + `<label>Risk<input id="sizerisk" type="number" step="any" min="0" `
    + `value="${st.risk}"></label></div>`
    + '<p class="fundline" id="sizeout"></p>';
}

function renderSizer(room, plan) {
  const out = $("sizeout");
  if (!out) return;
  const st = sizeNow();
  const value = E.POINT[st.sym] ?? 2;
  const s = FUND.size({risk: st.risk, stop: st.stop, value,
                       max: plan.maxMicros || Infinity});
  if (!s.contracts) {
    out.innerHTML = s.per > 0
      ? `That budget does not reach one contract: one ${esc(st.sym)} on a `
        + `${st.stop} point stop risks ${dollars(-s.per).replace("-", "")}.`
      : "Put in a stop and a risk and this says how many contracts that is.";
    return;
  }
  const share = room > 0 ? Math.round(s.risk / room * 100) : null;
  out.innerHTML = `<b>${s.contracts} ${esc(st.sym)}</b>, risking `
    + `<b>${dollars(-s.risk).replace("-", "")}</b>`
    + (share === null ? "" : `, ${share}% of your room`)
    + (s.capped
       ? `. Your plan caps you at ${plan.maxMicros} contracts, so the budget `
         + `is not the thing stopping you here.`
       : s.unused >= 1
         ? `. Rounding down leaves ${dollars(-s.unused).replace("-", "")} of `
           + `the budget unused.`
         : ".");
}

function wireSizer(room, plan) {
  for (const id of ["sizesym", "sizestop", "sizerisk"]) {
    const el = $(id);
    if (!el) continue;
    el.oninput = () => {
      const st = {sym: $("sizesym").value,
                  stop: parseFloat($("sizestop").value) || 0,
                  risk: parseFloat($("sizerisk").value) || 0};
      PROF.set(SIZE_KEY, JSON.stringify(st));
      renderSizer(room, plan);
    };
    el.onchange = el.oninput;
  }
  renderSizer(room, plan);
}

function renderPlanForm(plan) {
  const box = $("planform");
  if (!box) return;
  /* The preset first, because changing account size is one choice and not
     seven numbers typed again. Picking one replaces the lot; the fields
     under it are still the final word. */
  const picker = `<label>Plan<select data-preset>`
    + Object.values(FUND.PLANS).map(pl =>
        `<option value="${pl.id}"${pl.id === plan.id ? " selected" : ""}>`
        + `${esc(pl.name)}</option>`).join("")
    + "</select></label>";
  box.innerHTML = picker + FIELDS.map(([key, label]) => {
    const value = key === "consistencyPct"
      ? Math.round((plan.consistency || 0) * 100) : (plan[key] ?? 0);
    return `<label>${esc(label)}<input type="number" step="any" `
      + `data-plan="${key}" value="${value}"></label>`;
  }).join("");
  box.onchange = e => {
    if (!e.target.matches("[data-preset]")) return;
    PROF.set(PLAN_KEY, JSON.stringify(FUND.preset(e.target.value)));
    renderFunded();
    renderPanels();
  };
  box.oninput = e => {
    const key = e.target.dataset.plan;
    if (!key) return;
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    const next = {...planNow()};
    if (key === "consistencyPct") next.consistency = v / 100;
    else next[key] = v;
    PROF.set(PLAN_KEY, JSON.stringify(next));
    renderFunded();
    renderHabits();
  };
}

/**
 * One account, drawn as the two things that decide whether it survives.
 *
 * The room before the floor is a health bar, because that is exactly what it
 * is: it only goes down on a bad day, it never comes back up on a good one
 * past the high water mark, and at zero the account is gone. The target is a
 * second bar going the other way. Seeing both at once is the whole picture,
 * and a number alone never gave it.
 */
function accountCard(name, plan, allBal) {
  const bal = allBal.filter(b => (b.account || "") === name);
  const st = FUND.state(plan, {
    balances: bal,
    trades: window.TRADES.filter(t => (t.account || "") === name),
  });
  const cap = JD.dailyCap(jdunPlan());
  const days = st.days;
  const clean = days.filter(d => d.pnl >= -cap).length;

  /* The streak that matters is sessions kept inside the daily cap, counted
     back from the most recent one. It is the one thing in here that is
     entirely his to control. */
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].pnl < -cap) break;
    streak++;
  }

  const pct = Math.max(0, Math.min(100, Math.round(st.roomPct * 100)));
  const level = st.breached ? "gone" : pct < 25 ? "low" : pct < 55 ? "mid" : "high";
  const target = plan.target || 0;
  const tpct = target ? Math.max(0, Math.min(100, Math.round(st.profit / target * 100))) : 0;

  return `<div class="acct ${level}">`
    + `<div class="acctop"><span class="acctname">${esc(window.accountName(name))}</span>`
    + `<span class="acctbal">$${Math.round(st.balance).toLocaleString("en-US")}</span></div>`

    + '<div class="meter health">'
    + `<span class="mlab">Account health</span>`
    + `<span class="mval">${dollars(st.room).replace("+", "")}`
    + `<small>of $${Math.round(plan.drawdown).toLocaleString("en-US")}</small></span>`
    + `<div class="track"><i data-w="${pct}"></i>`
    + '<em style="left:25%"></em><em style="left:50%"></em><em style="left:75%"></em>'
    + "</div></div>"

    + (target ? '<div class="meter goal">'
        + '<span class="mlab">Profit target</span>'
        + `<span class="mval">${dollars(st.profit)}`
        + `<small>of $${Math.round(target).toLocaleString("en-US")}</small></span>`
        + `<div class="track"><i data-w="${tpct}"></i></div></div>` : "")

    + '<div class="acctfoot">'
    + `<span class="pip ${streak ? "on" : ""}">${streak} session`
    + `${streak === 1 ? "" : "s"} inside the cap</span>`
    + `<span class="pip">${clean} of ${days.length} clean</span>`
    + (st.breached ? '<span class="pip bad">breached</span>' : "")
    + "</div></div>";
}

/* The frame after the bars land, so they animate from empty to where they
   actually are. Setting the width in the markup means the browser has
   nothing to transition from. */
function fillBars(root) {
  const bars = (root || document).querySelectorAll(".track i[data-w]");
  if (!bars.length) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const b of bars) b.style.width = b.dataset.w + "%";
  }));
}

function renderFunded() {
  const sec = $("fundedsec"), card = $("fundedcard");
  if (!sec || !card) return;
  const plan = planNow();
  const allBal = balancesNow();
  const live = window.ofAccount(window.TRADES)
    .filter(t => (t.source || "live") === "live");
  if (plan.id === "none" || (!allBal.length && !live.length)) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  renderPlanForm(plan);

  /* Each evaluation account has its own drawdown, and two of them cannot be
     added together: one account closing is not half an account closing. So
     with both showing, every account gets its own line, and the full card is
     what you get once you pick one. */
  const names = [...new Set([...allBal.map(b => b.account || ""),
    ...live.map(t => t.account || "")].filter(Boolean))].sort();
  if (window.ACCOUNT === "all" && names.length > 1) {
    card.innerHTML = names.map(name => accountCard(name, plan, allBal)).join("")
      + '<p class="fundnote">Pick one account above for its own card, the '
      + "rules it still has to meet, and the sizer.</p>";
    fillBars(card);
    return;
  }

  const balances = window.ACCOUNT === "all" ? allBal
    : allBal.filter(b => (b.account || "") === window.ACCOUNT);
  const s = FUND.state(plan, {balances, trades: window.ofAccount(window.TRADES)});
  const pct = Math.round(s.roomPct * 100);
  const tight = s.roomPct < 0.25;
  const rows = [
    stat("balance", "$" + Math.round(s.balance).toLocaleString("en-US")),
    stat("profit", dollars(s.profit), s.profit >= 0 ? "win" : "loss"),
    stat("drawdown floor", "$" + Math.round(s.floor).toLocaleString("en-US")),
    stat("best day", s.best ? dollars(s.best) : "&mdash;"),
    stat("days that count", `${s.qualifying} of ${s.minDays}`),
    stat("floor locked", s.locked ? "yes" : "not yet"),
  ].join("");

  const todo = [];
  if (s.breached)
    todo.push('<span class="fundwarn">This account is at or below its '
      + "drawdown floor.</span>");
  if (!s.consistencyOk && s.needMore > 0)
    todo.push(`Your best day is ${Math.round(s.bestPct * 100)}% of the profit. `
      + `A payout needs ${Math.round((plan.consistency || 0) * 100)}% or less, `
      + `so ${dollars(s.needMore)} more profit on other days.`);
  if (s.daysLeft)
    todo.push(`${s.daysLeft} more day${s.daysLeft === 1 ? "" : "s"} of `
      + `$${plan.qualifyingDay}+ to count.`);
  if (s.ready) todo.push("Every rule on this list is met.");

  /* The same two bars the all-accounts view shows, so switching between one
     account and both does not switch between two different designs. */
  const only = window.ACCOUNT !== "all" ? window.ACCOUNT
    : [...new Set(allBal.map(b => b.account || "").filter(Boolean))][0];
  card.innerHTML =
    (only ? accountCard(only, plan, allBal)
          : `<p class="fundline">Room before the account is closed: `
            + `<b>${dollars(s.room).replace("+", "")}</b> of `
            + `$${Math.round(plan.drawdown).toLocaleString("en-US")}</p>`
            + `<div class="fundbar${tight ? " warn" : ""}">`
            + `<i style="width:${pct}%"></i></div>`)
    + `<div class="stats hud">${rows}</div>`
    + sizerHtml(sizeNow())
    + todo.map(t => `<p class="fundnote">${t}</p>`).join("")
    + s.notes.map(n => `<p class="fundnote">${esc(n)}</p>`).join("");
  fillBars(card);
  wireSizer(s.room, plan);
}

/* ------------------------------------------------- the exports folder */

/* Importing is exporting: the journal is pointed at the folder the exports
   land in, and reads anything new when it is opened. What it has already read
   is kept with the journal, so the same file is not re-read every time, and so
   two journals on one device do not inherit each other's list. */
const FOLDER_SEEN = "folderseen";
const folderRow = $("folderrow"), folderBtn = $("folderbtn");
const folderLine = $("folderline");

const seenFiles = () => {
  try { return JSON.parse(PROF.get(FOLDER_SEEN)) || {}; } catch { return {}; }
};
function rememberFiles(files) {
  const seen = seenFiles();
  for (const f of files) seen[FS.fileKey(f)] = 1;
  // Only the recent ones: a key a year old cannot match a file any more.
  const keys = Object.keys(seen).slice(-400);
  const kept = {};
  for (const k of keys) kept[k] = 1;
  PROF.set(FOLDER_SEEN, JSON.stringify(kept));
}

function folderSay(text) {
  if (folderLine) folderLine.textContent = text;
}

/** Read whatever is new in the watched folder. `ask` may prompt, so it is
 *  only true when a click asked for it. */
async function scanFolder({ask = false} = {}) {
  if (!FS.supported() || !PROF.isOpen() || !folderRow) return;
  const dir = await FS.remembered();
  if (!dir) return;
  if (folderBtn) folderBtn.textContent = `Check ${dir.name} now`;
  const state = await FS.permission(dir, ask);
  if (state !== "granted") {
    folderSay(`Watching ${dir.name}. The browser needs one click to let it `
      + `read that folder again after a restart.`);
    return;
  }
  const files = await FS.newFiles(dir, seenFiles());
  if (!files.length) {
    folderSay(`Watching ${dir.name}. Nothing new in it.`);
    return;
  }
  folderSay(`Reading ${files.length} new file${files.length === 1 ? "" : "s"} `
    + `from ${dir.name}...`);
  await handle(files);
  rememberFiles(files);
  folderSay(`Watching ${dir.name}. Last read ${files.length} new `
    + `file${files.length === 1 ? "" : "s"}.`);
}

if (FS.supported() && folderRow) {
  folderRow.hidden = false;
  folderBtn.addEventListener("click", async () => {
    try {
      const had = await FS.remembered();
      if (!had) await FS.choose();
      await scanFolder({ask: true});
    } catch (e) {
      // Cancelling the picker is not an error worth shouting about.
      if (e && e.name !== "AbortError")
        folderSay("That folder could not be read: " + e.message);
    }
  });
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
    renderFunded();
    renderPanels();
    storeLine();
    if (warn) { say(warn, true); return; }
    /* And fetch the candles for what just arrived.
     *
     * A backup carries the trades, not the bars, because bars are published
     * and would double the file for nothing. Without this the restored
     * trades sat with no chart, saying no candles were stored, until the app
     * was closed and opened again: the only other place that fills them is
     * the unlock. Restoring and then looking is the obvious thing to do. */
    loadBars(feedsFor(window.TRADES)).then(fillCandles);
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
    "Your rule holds the stop until price has run about twice what you risked, "
    + "and this marks every time it moved in before that."],
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

/* The habits the Home tab can replay against the bars. Kept the same as its
   list, so the two tabs can never give different answers about one habit. */
const TESTED = new Set(["trailed early", "right, stopped early"]);

function renderLearn() {
  const mine = window.ofAccount(window.TRADES)
    .filter(t => (t.source || "live") === "live");
  const cost = new Map();
  for (const t of mine)
    for (const f of (t.flags || [])) {
      const c = cost.get(f) || {n: 0, lost: 0};
      c.n++;
      if (t.pnl < 0) c.lost += -t.pnl;
      cost.set(f, c);
    }

  /* Most frequent first, and a cost only where one was measured.
   *
   * This ranked the habits by the losses on the trades that carried them and
   * called that the cost, under the heading "where the money is actually
   * lost". That comparison is not one: they are different trades on
   * different days, and the habit is one of a hundred things separating
   * them. It put tightening the stop first, at -$1,470, while the Home tab,
   * which replays those same trades against the bars with the stop left
   * alone, found no detectable difference. Two tabs gave opposite advice
   * about the same habit, and the wrong one had the more confident heading.
   *
   * So a habit that can be replayed says what the replay found, in the same
   * sentence the Home tab uses. Everything else says what it is: how often it
   * happened, and what the losing trades with it lost between them, labelled
   * as where it showed up rather than as a bill. */
  const ranked = [...cost.entries()]
    .filter(([f]) => LESSON[f])
    .sort((a, b) => (b[1].n - a[1].n) || (b[1].lost - a[1].lost))
    .slice(0, 6);
  const barsOf = sym => BARS[E.FEED[sym]] || [];

  $("lessons").innerHTML = mine.length
    ? (ranked.map(([f, c]) => {
        const [title, body] = LESSON[f];
        let bill;
        if (TESTED.has(f)) {
          const res = W.compare(mine.filter(t => (t.flags || []).includes(f)), barsOf);
          bill = " Tested against the bars: " + W.verdict(res);
        } else {
          bill = c.lost
            ? ` The losing trades with it lost ${dollars(-c.lost)} between them. `
              + `That is where it showed up, not what it cost.`
            : " None of the trades with it lost money.";
        }
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
  // A button that only opens the picker is already on the right tab, which
  // is the case for the one the empty Diary offers.
  const b = e.target.closest("button[data-go],button[data-import]");
  if (!b || b.classList.contains("tb")) return;
  if (b.dataset.go) goTab(b.dataset.go, true);
  // Import goes one step further than the tab it lives on: it opens the file
  // picker too, so "import my trades" is one tap rather than a tab, a scroll
  // and a hunt for the right panel. Still inside the click, which is what
  // lets a browser open a file dialog at all.
  if (b.dataset.import) $("pick").click();
  // A button that names a tab can also name what to scroll to once there.
  if (b.dataset.scroll) {
    const el = $(b.dataset.scroll);
    if (el) requestAnimationFrame(() =>
      el.scrollIntoView({block: "center", behavior: "smooth"}));
  }
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

/* The account and the exit are both part of the key: the same contract at
   the same minute on two evaluation accounts is two trades, and so is one
   entry closed in two pieces. A note typed against one of them must not land
   on the other. */
function keyOf(t) {
  return (t.account || "") + "|" + t.symbol + "|" + t.open_t + "|" + t.close_t;
}
// The Diary needs the same key to find a trade the day cards asked for.
window.keyOfTrade = keyOf;

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

/* ------------------------------------------------------------ dark or light */

/* The theme is the device's, not the journal's: it is applied before a PIN
   has been typed, so it cannot live behind one. */
const THEME_KEY = "tradersdiary.theme";

function applyTheme(name) {
  const light = name === "light";
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#FFFFFF" : "#0A0E16");
  try { localStorage.setItem(THEME_KEY, light ? "light" : "dark"); } catch { /* fine */ }
  // Everything drawn on a canvas reads the CSS colours once, at draw time.
  try { DASH.refreshRecord(); } catch { /* nothing drawn yet */ }
  try { DIARY.redraw(); } catch { /* not open */ }
  try { RP.redraw(); } catch { /* not open */ }
}

const themeBtn = $("themebtn");
if (themeBtn) themeBtn.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

/* ------------------------------------------------ did you follow the plan */

/* The method is only worth anything if it was actually followed, and the
   record alone cannot see a chart. So the panel does two things: it says what
   the record can prove, and it asks Chris the six questions it cannot answer.
   His answers are kept against the trade, same as the note, so a backup
   carries them and the habits are counted from real answers. */

const askRow = (t, ask) => {
  const v = (t.jdun || {})[ask.id];
  const on = s => v === s ? " on" : "";
  return `<div class="jask"><span class="jq">${esc(ask.q)}</span>`
    + `<span class="jyn">`
    + `<button class="jbtn yes${on(true)}" data-ask="${ask.id}" data-v="1">Yes</button>`
    + `<button class="jbtn no${on(false)}" data-ask="${ask.id}" data-v="0">No</button>`
    + "</span></div>";
};

const VERDICT = {good: "good", open: "open", lucky: "lucky", broken: "broken"};

function renderReview(t) {
  const box = $("jblock");
  if (!box) return;
  if (!t) { box.hidden = true; return; }
  box.hidden = false;

  const list = window.ofAccount(window.TRADES)
    .filter(x => (x.source || "live") === (t.source || "live")
              && x.open_t.slice(0, 10) === t.open_t.slice(0, 10));
  const r = JD.review(t, jdunPlan(), {dayTrades: list});

  $("jverdict").innerHTML =
    `<span class="jv ${VERDICT[r.verdict]}">${esc(r.line)}</span>`
    + `<span class="jscore">${r.score.kept} of ${r.score.of} rules kept</span>`;

  $("jasks").innerHTML = JD.ASKS.map(a => askRow(t, a)).join("");

  /* Broken first, then the things worth watching, then what was done right.
     Nobody opens this panel to read what went well, but seeing it under the
     faults is what keeps a bad day from reading as a bad trader. */
  const order = {broke: 0, watch: 1, asked: 2, kept: 3};
  const rows = r.findings
    .filter(f => f.verdict !== "asked" || f.id === "stop")
    .sort((a, b) => order[a.verdict] - order[b.verdict])
    .map(f => `<li class="jf ${f.verdict}">`
      + `<span class="jfr">${esc(f.rule)}</span>`
      + `<span class="jfw">${esc(f.what)}</span>`
      + (f.instead ? `<span class="jfi">${esc(f.instead)}</span>` : "")
      + "</li>").join("");
  $("jfind").innerHTML = rows;
}

/** The plan, with his own account's drawdown in it. */
function jdunPlan() {
  const p = planNow();
  return JD.plan({drawdown: p.drawdown || JD.PLAN.drawdown});
}

document.addEventListener("click", e => {
  const b = e.target.closest(".jbtn");
  if (!b) return;
  const t = window.TRADES.find(x => keyOf(x) === (noteBox ? noteBox.dataset.key : ""));
  if (!t) return;
  const want = b.dataset.v === "1";
  t.jdun = {...(t.jdun || {})};
  // Pressing the answer that is already on takes it back to unanswered,
  // because a wrong tap should not need a different button to undo.
  if (t.jdun[b.dataset.ask] === want) delete t.jdun[b.dataset.ask];
  else t.jdun[b.dataset.ask] = want;
  save(window.TRADES, window.START);
  renderReview(t);
  renderHabits();
});

/* ------------------------------------------------------ the day by day */

/* A note against a whole session, not a trade. Tradeify's own journal has
   one and it is the right unit: most of what is worth saying at the end of
   a day is about the day. */
const DAYNOTE_KEY = "day.notes";
const dayNotes = () => {
  try { return JSON.parse(PROF.get(DAYNOTE_KEY)) || {}; } catch { return {}; }
};

window.saveDayNote = function (key, text) {
  const all = dayNotes();
  const v = String(text || "").trim();
  if (v) all[key] = v; else delete all[key];
  PROF.set(DAYNOTE_KEY, JSON.stringify(all));
};

window.toggleDay = function (id) {
  const el = $(id);
  if (!el) return;
  el.hidden = !el.hidden;
  const btn = document.querySelector('[data-expand="' + id + '"]');
  if (btn) btn.textContent = el.hidden ? "Expand" : "Collapse";
};

/* One handler for the day cards. Inline onclick attributes cannot survive
   the build, which decodes escaped quotes, and delegation is the better
   answer anyway: the markup carries data, not code. */
document.addEventListener("click", e => {
  const ex = e.target.closest("[data-expand]");
  if (ex) { window.toggleDay(ex.dataset.expand); return; }
  const op = e.target.closest("[data-open]");
  if (op) { window.openTrade(op.dataset.open); return; }
  const rn = e.target.closest("[data-rename]");
  if (rn) window.renameAccount(rn.dataset.rename);
});

document.addEventListener("input", e => {
  const n = e.target.closest("[data-daynote]");
  if (n) window.saveDayNote(n.dataset.daynote, n.value);
});

/** Jump to a trade in the Diary from anywhere. */
window.openTrade = function (key) {
  const t = window.TRADES.find(x => keyOf(x) === key);
  if (!t) return;
  if (window.ACCOUNT !== "all" && (t.account || "") !== window.ACCOUNT)
    window.pickAccount(t.account || "all");
  goTab("diary", true);
  DIARY.showKey(key);
};

/** A day's running total, drawn small, the way the dashboards do it. */
function daySpark(list) {
  if (list.length < 2) return "";
  let run = 0;
  const pts = [0, ...list.map(t => (run += t.pnl || 0))];
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const span = hi - lo || 1;
  const w = 78, h = 22;
  const d = pts.map((v, i) =>
    (i / (pts.length - 1) * w).toFixed(1) + ","
    + (h - (v - lo) / span * h).toFixed(1)).join(" ");
  const up = pts[pts.length - 1] >= 0;
  return '<svg class="dspark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">'
    + '<polyline points="' + d + '" fill="none" stroke="'
    + (up ? "var(--win)" : "var(--loss)") + '"'
    + ' stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
}

/**
 * The account day by day, as a card a session at a time.
 *
 * Laid out the way Tradeify's own journal lays it out, because that is what
 * Chris reads his account in: the date, what the session made, the shape of
 * it, and a row of figures underneath. Expanding a card lists the trades,
 * and a trade opens in the Diary with its chart and its video.
 *
 * The balance history is still the spine. It knows about sessions where
 * nothing was traded and it is net of every fee, which a pile of fills can
 * only estimate.
 */
function renderDays() {
  const sec = $("dayssec"), box = $("daysbox");
  if (!sec || !box) return;
  const all = balancesNow();
  const plan = planNow();
  const live = window.TRADES.filter(t => (t.source || "live") === "live");
  const names = [...new Set([...all.map(b => (b.account || "").trim()),
    ...live.map(t => (t.account || "").trim())].filter(Boolean))].sort();
  const show = window.ACCOUNT === "all" ? names
    : names.filter(n => n === window.ACCOUNT);
  if ((!all.length && !live.length) || !show.length) { sec.hidden = true; return; }
  sec.hidden = false;

  const cap = JD.dailyCap(jdunPlan());
  const notes = dayNotes();

  box.innerHTML = show.map(name => {
    const mine = live.filter(t => (t.account || "") === name);
    const bal = all.filter(b => (b.account || "") === name);
    const st = FUND.state(plan, bal.length ? {balances: bal} : {trades: mine});

    const cards = [...st.days].reverse().map(d => {
      const day = mine.filter(t => t.open_t.slice(0, 10) === d.date)
        .sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
      const wins = day.filter(t => (t.pnl || 0) > 0).length;
      const gross = day.reduce((n, t) => n + (t.pnl || 0), 0);
      const vol = day.reduce((n, t) => n + (t.qty || 0), 0);
      const won = day.filter(t => (t.pnl || 0) > 0).reduce((n, t) => n + t.pnl, 0);
      const lost = Math.abs(day.filter(t => (t.pnl || 0) < 0)
        .reduce((n, t) => n + t.pnl, 0));
      const pf = lost > 0 ? won / lost : (won > 0 ? Infinity : 0);
      /* The broker's own figure is net of every fee and the trades are
         gross, so the gap between them is what the day cost to trade. */
      const fees = day.length && bal.length
        ? Math.round((gross - d.pnl) * 100) / 100 : null;
      const over = cap > 0 && d.pnl < -cap;
      const id = "day-" + name.slice(-4) + "-" + d.date;
      const key = name + "|" + d.date;

      const fig = (k, v, cls) =>
        '<div class="dfig"><span class="dfk">' + k + "</span>"
        + '<span class="dfv ' + (cls || "") + '">' + v + "</span></div>";

      return '<article class="dcard' + (d.pnl < 0 ? " down" : d.pnl > 0 ? " up" : "")
        + '">'
        + '<header class="dchead">'
        + '<span class="dcdate">' + C.day(C.msOf(d.date + " 12:00:00")) + "</span>"
        + '<span class="dcpnl">' + (d.pnl === 0 ? "flat" : dollars(d.pnl)) + "</span>"
        + daySpark(day)
        + (day.length
            ? '<button class="dcbtn" data-expand="' + id + '">Expand</button>' : "")
        + "</header>"
        + '<div class="dfigs">'
        + fig("trades", String(day.length))
        + fig("win rate", day.length
            ? Math.round(wins / day.length * 100) + "%" : "&mdash;")
        + fig("gross", day.length ? dollars(gross) : "&mdash;",
              gross >= 0 ? "win" : "loss")
        + fig("volume", String(vol))
        + fig("fees", fees == null ? "&mdash;" : "$" + Math.abs(fees).toFixed(2))
        + fig("winners", String(wins))
        + fig("losers", String(day.length - wins))
        + fig("profit factor", !day.length ? "&mdash;"
              : pf === Infinity ? "all winners" : pf.toFixed(2))
        + fig("balance", "$" + Math.round(d.balance).toLocaleString("en-US"))
        + fig("room left", dollars(d.room).replace("+", ""),
              d.room < cap ? "loss" : "")
        + "</div>"
        + (over ? '<p class="dcover">' + (d.pnl / -cap).toFixed(1)
            + " times the $" + cap + " cap</p>" : "")
        + '<div class="dcnote"><textarea placeholder="What happened today, and '
        + 'what you would do differently" data-daynote="' + esc(key) + '">'
        + esc(notes[key] || "") + "</textarea></div>"
        + (day.length ? '<ul class="dctrades" id="' + id + '" hidden>'
            + day.map(t => {
              const r = t.got_r == null ? "no R"
                : (t.got_r >= 0 ? "+" : "") + t.got_r.toFixed(2) + "R";
              return '<li><button class="dctrade" data-open="'
                + esc(keyOf(t)) + '">'
                + '<span class="dtt">' + C.hhmm(C.msOf(t.open_t)) + "</span>"
                + '<span class="dts2">' + esc(t.symbol) + " " + esc(t.side)
                + " &times;" + t.qty + "</span>"
                + '<span class="dtr2 ' + ((t.pnl || 0) >= 0 ? "win" : "loss")
                + '">' + r + "</span>"
                + '<span class="dtm">' + dollars(t.pnl || 0) + "</span>"
                + "</button></li>";
            }).join("") + "</ul>" : "")
        + "</article>";
    }).join("");

    const red = st.days.filter(d => d.pnl < 0).length;
    const green = st.days.filter(d => d.pnl > 0).length;
    const flat = st.days.length - red - green;
    const worst = st.days.length ? Math.min(...st.days.map(d => d.pnl)) : 0;
    return (names.length > 1
      ? '<h3 class="dayacc">' + esc(window.accountName(name))
        + '<button class="renamebtn" data-rename="' + esc(name) + '">rename'
        + "</button></h3>" : "")
      + '<p class="srcnote">' + st.days.length + " session"
      + (st.days.length === 1 ? "" : "s") + ", " + green + " green and "
      + red + " red" + (flat ? ", " + flat + " with no trade" : "") + ", "
      + "worst day " + dollars(worst) + ". "
      + (cap > 0 && worst < -cap
          ? "The plan's cap is $" + cap + "."
          : "Every day inside the plan's cap.")
      + "</p>"
      + '<div class="dcards">' + cards + "</div>";
  }).join("");
}

/**
 * What to change, read off the whole record rather than one trade.
 *
 * Each lesson carries its evidence and the number of trades behind it, and
 * the ones that cannot speak yet are kept behind a fold rather than hidden,
 * because knowing what the journal is still waiting for is worth as much as
 * a finding when the record is nine sessions old.
 */
function renderCoach() {
  const sec = $("coachsec"), box = $("coachlist"), wait = $("coachwait");
  if (!sec || !box) return;
  const live = window.ofAccount(window.TRADES)
    .filter(t => (t.source || "live") === "live");
  if (!live.length) { sec.hidden = true; return; }
  const r = COACH.lessons(live, jdunPlan());
  sec.hidden = false;

  box.innerHTML = r.ready.map(l =>
    `<li class="lsn"><h3 class="lsnt">${esc(l.title)}`
    + `<span class="lsnn">${l.n} trade${l.n === 1 ? "" : "s"}</span></h3>`
    + `<p class="lsnf">${esc(l.finding)}</p>`
    + (l.suggestion ? `<p class="lsns">${esc(l.suggestion)}</p>` : "")
    + (l.evidence.length
        ? `<details class="lsne"><summary>The numbers</summary><ul>`
          + l.evidence.map(e => `<li>${esc(e)}</li>`).join("")
          + "</ul></details>"
        : "")
    + "</li>").join("")
    || '<li class="lsn"><p class="lsnf">Nothing to say yet. Import a few '
       + 'more sessions.</p></li>';

  if (wait) wait.innerHTML = r.waiting.map(l =>
    `<li><b>${esc(l.title)}</b> ${esc(l.finding)}</li>`).join("");
}

/** The one habit worth fixing this week, with what it has cost. */
function renderHabits() {
  const box = $("habits");
  if (!box) return;
  const live = window.ofAccount(window.TRADES)
    .filter(t => (t.source || "live") === "live");
  const list = JD.habits(live, jdunPlan());
  if (!live.length) {
    box.innerHTML = '<p class="srcnote">Import a session and this fills in.</p>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<p class="srcnote">Nothing in the record broke a rule. '
      + "Answer the six questions on each trade in the Diary and this will "
      + "take those in too.</p>";
    return;
  }
  box.innerHTML = list.slice(0, 6).map(h =>
    `<li class="hab"><span class="habn">${h.n}&times;</span>`
    + `<span class="habr">${esc(h.rule)}</span>`
    + `<span class="habc ${h.pnl < 0 ? "loss" : "win"}">${dollars(h.pnl)}`
    + "<small>on those trades</small></span>"
    + `<span class="habi">${esc(h.instead)}</span></li>`).join("");
}

/* -------------------------------------------------------------- accounts */

/* Two evaluation accounts, kept apart. Everything that shows the record
   reads through ofAccount, so one pick moves the whole app. */
const ACC_KEY = "jdun.account";
const NAMES_KEY = "accounts.names";
window.ACCOUNT = "all";

/* A broker's account id is not a name. "TDFYSL50154604439" tells you nothing
   at a glance and two of them side by side tell you less, so the app shows
   the last four digits until you give it something better, and lets you give
   it something better. */
const namesNow = () => {
  try { return JSON.parse(PROF.get(NAMES_KEY)) || {}; } catch { return {}; }
};

window.accountName = id => {
  const key = String(id || "");
  if (!key) return "";
  const own = namesNow()[key];
  if (own) return own;
  const tail = key.slice(-4);
  return /^[0-9]{4}$/.test(tail) ? "Account " + tail : key;
};

window.renameAccount = function (id) {
  const now = window.accountName(id);
  const want = prompt(`What do you want to call ${id}?`, now);
  if (want === null) return;
  const names = namesNow();
  const clean = want.trim().slice(0, 28);
  if (clean) names[id] = clean; else delete names[id];
  PROF.set(NAMES_KEY, JSON.stringify(names));
  renderPanels();
  renderFunded();
  renderDays();
  DASH.refreshRecord();
};

window.ofAccount = (list, acc = window.ACCOUNT) =>
  acc === "all" ? list : list.filter(t => (t.account || "") === acc);

const accountsIn = list =>
  [...new Set(list.map(t => (t.account || "").trim()).filter(Boolean))].sort();

window.pickAccount = function (acc) {
  window.ACCOUNT = acc;
  PROF.set(ACC_KEY, acc);
  for (const b of document.querySelectorAll(".acc"))
    b.setAttribute("aria-pressed", String(b.dataset.acc === acc));
  renderPanels();
  renderFunded();
  renderDays();
  try { VID.refilter(); } catch { /* library not loaded yet */ }
};

function renderAccounts() {
  /* Accounts come from the balance history as well as from trades. Tradovate
     hands those two files out separately, and the balance one carries the
     account name, so the picker has to work before a single fill is in. */
  const names = [...new Set([
    ...accountsIn(window.TRADES.filter(t => (t.source || "live") === "live")),
    ...balancesNow().map(b => (b.account || "").trim()).filter(Boolean),
  ])].sort();
  // One account is not a choice, and no account means the import has not
  // happened yet. Either way the row stays out of the way.
  const show = names.length > 1;
  if (!names.includes(window.ACCOUNT)) window.ACCOUNT = "all";
  const pairs = [["all", "Both"], ...names.map(n => [n, window.accountName(n)])];
  const shortHtml = !show ? "" : pairs.map(([k, label]) => {
    const tail = k === "all" ? label : label.replace(/^Account\s+/, "");
    return `<button class="acc" data-acc="${esc(k)}" `
      + `aria-pressed="${k === window.ACCOUNT}" `
      + `onclick="pickAccount('${esc(k)}')">${esc(tail)}</button>`;
  }).join("");
  /* One picker, in the bar, on every tab. It used to be drawn again on Home
     and again beside the chart, which is three of the same control on one
     screen and a question about which one is in charge. */
  const bar = $("accbar");
  if (bar) { bar.innerHTML = shortHtml; bar.hidden = !show; }
  for (const id of ["accrow", "accrow2"]) {
    const el = $(id);
    if (el) { el.innerHTML = ""; el.hidden = true; }
  }
}

/**
 * The rewards panel: the level, the streak, and today's missions.
 *
 * Modelled on the Rewards Center in Tradeify's own dashboard, which is what
 * Chris meant by wanting the app to feel like a game, and pointed at the one
 * thing worth making rewarding: the waiting, the sizing down, the stopping
 * after two losses, the note at the end.
 */
function renderQuests() {
  const sec = $("questsec");
  if (!sec) return;
  const live = window.ofAccount(window.TRADES)
    .filter(t => (t.source || "live") === "live");
  if (!live.length) { sec.hidden = true; return; }
  sec.hidden = false;

  const b = Q.board(live, jdunPlan());
  $("rwbadge").textContent = b.level;
  $("rwname").textContent = "Level " + b.level;
  $("rwnext").textContent = b.max
    ? `${b.xp.toLocaleString("en-US")} XP, the top of the ladder`
    : `${b.into.toLocaleString("en-US")} / ${b.need.toLocaleString("en-US")} XP`
      + `  ·  ${b.toNext.toLocaleString("en-US")} to level ${b.level + 1}`;
  $("rwgems").textContent = b.gems.toLocaleString("en-US");
  $("rwstreak").textContent = b.streak;
  $("rwdone").textContent = `${b.done} of ${b.possible}`;
  const fill = $("rwfill");
  fill.dataset.w = Math.round(b.pct * 100);
  fill.style.width = "0%";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.width = fill.dataset.w + "%";
  }));

  const list = (box, missions) => {
    box.innerHTML = missions.map(m =>
      `<li class="rwm ${m.done ? "got" : ""}">`
      + '<span class="rwtick" aria-hidden="true"></span>'
      + `<span class="rwmt">${esc(m.title)}</span>`
      + `<span class="rwmw">${esc(m.done ? m.what : (m.note || m.what))}</span>`
      + `<span class="rwmx">+${m.xp}<small>XP</small></span></li>`).join("");
  };
  const order = ms => [...ms].sort((a, c) => (a.done === c.done ? 0 : a.done ? 1 : -1));
  list($("rwday"), order(b.today));
  list($("rwweek"), order(b.thisWeek));
  $("rwdayon").textContent = b.day ? C.day(C.msOf(b.day + " 12:00:00")) : "";
  $("rwweekon").textContent = b.week
    ? "week of " + C.day(C.msOf(b.week + " 12:00:00")) : "";
}

/* Trades the journal cannot attribute, said on the page where they are doing
   the damage, with the button that fixes it right there. The same tool lives
   on the Learn tab, which is two taps away and might as well be nowhere:
   Chris asked twice why an old practice account was still driving his
   headline. */
const KEEP_LOOSE = "loose.keep";

function renderOrphans() {
  const sec = $("orphansec"), line = $("orphanbig");
  if (!sec || !line) return;
  const loose = window.TRADES.filter(t => (t.source || "live") === "live"
    && !(t.account || "").trim());
  /* This used to be shown only when there was a named account to compare
     against, which is exactly the case Chris was NOT in: his journal held
     those eighteen trades and nothing else, so the one notice that could
     have explained his home page was the one thing hidden from him. It
     shows whenever there are trades with no account, and anyone who wants
     to keep them can say so once. */
  let kept = false;
  try { kept = PROF.get(KEEP_LOOSE) === "1"; } catch { kept = false; }
  if (!loose.length || kept) { sec.hidden = true; return; }
  sec.hidden = false;
  const net = Math.round(loose.reduce((n, t) => n + (t.pnl || 0), 0));
  const from = loose.map(t => t.open_t).sort()[0].slice(0, 10);
  line.textContent = `${loose.length} trade${loose.length === 1 ? "" : "s"} `
    + `in here belong to no account, going back to ${from}, `
    + `${net >= 0 ? "+" : "-"}$${Math.abs(net).toLocaleString("en-US")} between them.`;
}

const orphanGo = $("orphango");
if (orphanGo) orphanGo.addEventListener("click", () => dropAccount(""));

const orphanKeep = $("orphankeep");
if (orphanKeep) orphanKeep.addEventListener("click", () => {
  PROF.set(KEEP_LOOSE, "1");
  renderOrphans();
  say("Kept. They stay in your figures and this notice will not come back.");
});

/**
 * What is actually in this journal, by account, and a way to take a group
 * out.
 *
 * Chris's installed app still held eighteen trades from a TradingView
 * practice account, tagged live because that is what they were at the time,
 * with no account on them because accounts did not exist yet. They were
 * driving the headline, the win rate and the drawdown guard, and nothing in
 * the app could tell him what they were or remove them without erasing
 * everything.
 */
function renderGroups() {
  const box = $("groups");
  if (!box) return;
  const live = window.TRADES.filter(t => (t.source || "live") === "live");
  const by = new Map();
  for (const t of live) {
    const k = (t.account || "").trim();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  const other = window.TRADES.length - live.length;
  if (!by.size) {
    box.innerHTML = '<p class="srcnote">No trades imported yet.</p>';
    return;
  }
  box.innerHTML = [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([acc, list]) => {
      const sorted = [...list].sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
      const net = Math.round(sorted.reduce((n, t) => n + (t.pnl || 0), 0));
      const from = sorted[0].open_t.slice(0, 10);
      const to = sorted[sorted.length - 1].open_t.slice(0, 10);
      const syms = [...new Set(sorted.map(t => t.symbol))].join(", ");
      return `<div class="grp"><span class="grpname">`
        + (acc ? esc(window.accountName(acc)) : "No account")
        + "</span>"
        + `<button class="grpbtn" data-drop="${esc(acc)}">Remove</button>`
        + `<span class="grpmeta">${sorted.length} trade`
        + `${sorted.length === 1 ? "" : "s"}, ${from} to ${to}, ${esc(syms)}, `
        + `${net >= 0 ? "+" : "-"}$${Math.abs(net).toLocaleString("en-US")}`
        + (acc ? "" : ". Imported before accounts existed, usually practice "
            + "from an older platform.")
        + "</span></div>";
    }).join("")
    + (other ? `<p class="srcnote">Also ${other} demo or replay trade`
        + `${other === 1 ? "" : "s"}, which are already kept out of your live `
        + "figures.</p>" : "");
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-drop]");
  if (b) dropAccount(b.dataset.drop);
});

/** Take one account's live trades out of the journal, for good. */
function dropAccount(acc) {
  const hit = window.TRADES.filter(t => (t.source || "live") === "live"
    && (t.account || "").trim() === acc);
  if (!hit.length) return;
  const who = acc ? window.accountName(acc) : "no account";
  if (!confirm(`Remove ${hit.length} trade${hit.length === 1 ? "" : "s"} from `
             + `${who}? Every figure in the journal changes. This cannot be `
             + "undone without a backup file.")) return;
  const gone = new Set(hit);
  window.TRADES = window.TRADES.filter(t => !gone.has(t));
  const warn = save(window.TRADES, window.START);
  /* The starting balance belonged to the record that just left. Keeping
     $100,000 from a practice account after removing it put the equity curve
     on a scale no remaining trade was ever measured against. */
  window.START = null;
  save(window.TRADES, window.START);
  renderPanels();
  renderFunded();
  renderDays();
  renderGroups();
  storeLine();
  say(warn || `Removed ${hit.length} trade${hit.length === 1 ? "" : "s"}. `
    + "Your home page is your own accounts now.", !!warn);
}

/* ------------------------------------------------------ which method, Learn */

/* Two methods are written up in the Learn tab. Chris trades Jdun's and the
   built-in detector looks for TJR's, so both stay and the page shows one at
   a time. The choice is remembered, and it is a reading choice only: the
   grading on every trade card follows Jdun's rules either way. */
const METHOD_KEY = "learn.method";

function showMethod(which) {
  const want = which === "tjr" ? "tjr" : "jdun";
  for (const box of document.querySelectorAll(".methodbox"))
    box.hidden = box.dataset.method !== want;
  for (const b of document.querySelectorAll(".msb"))
    b.setAttribute("aria-pressed", String(b.dataset.method === want));
  try { PROF.set(METHOD_KEY, want); } catch { /* not open yet */ }
}

document.addEventListener("click", e => {
  const b = e.target.closest(".msb");
  if (b) showMethod(b.dataset.method);
});

/** How many sessions of broker balances are in the journal, for the screens
 *  that need to explain what is and is not here yet. */
window.sessionCount = () => balancesNow().filter(b => window.ACCOUNT === "all"
  || (b.account || "") === window.ACCOUNT).length;

/** Trades imported before the bars were published can still get their chart. */
function fillCandles() {
  let filled = 0;
  for (const t of window.TRADES)
    if (E.attachBars(t, BARS[E.FEED[t.symbol]], tzOffset(),
                     SLOW[E.FEED[t.symbol]])) {
      E.analyseExcursion(t);
      filled++;
    }
  if (filled) {
    save(window.TRADES, window.START);
    renderPanels();
  } else {
    // The bars have arrived either way, and the Learn tab replays trades
    // against them, so it is drawn again now rather than left saying there
    // was nothing to replay.
    renderLearn();
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
  window.ACCOUNT = PROF.get(ACC_KEY) || "all";
  showMethod(PROF.get(METHOD_KEY) || "jdun");
  renderPanels();
  renderFunded();
  storeLine();
  lockState();
  RP.reopen();
  IND.reopen();
  // Anything new in the watched folder, now that there is a journal to put
  // it in. Silent when there is nothing, and it never prompts on its own.
  scanFolder().catch(() => {});
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
    // And check that it actually stored. This return value was ignored, and
    // ignoring it is how the comment above comes true anyway: storage refuses
    // the write, nothing throws, the journal has moved to the new PIN and the
    // record inside it is still locked with the old one. Put the PIN back
    // rather than say Done over a record that can no longer be opened.
    if (!PROF.set(KEY, JSON.stringify(env))) {
      rekeyed.undo();
      throw new Error("there was no room to store the re-locked record");
    }
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

/* The steps are a tap away. On a phone the four lines explaining where the
   browser menu is were the whole first screen, above the account. */
const instHow = document.getElementById("insthow");
if (instHow) instHow.addEventListener("click", () => {
  const card = instHow.closest(".install");
  const open = card.classList.toggle("open");
  instHow.setAttribute("aria-expanded", String(open));
});

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
  const key = t => E.tradeKey(t, source);
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

// The dashboard tests the stop habits against the bars rather than guessing
// from a comparison between different trades, so it needs them.
DASH.setBars(sym => BARS[E.FEED[sym]] || []);

DIARY.setClock(tzOffset);
/* The video of the trade you are looking at, offered only when it is actually
   here. A button that does nothing is worse than no button. */
DIARY.setOnShow(t => {
  const block = $("dvidblock");
  if (block) block.hidden = !VID.forTrade(t);
  renderReview(t);
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

/* The picker and the trade browser are one choice, not two.
 *
 * The reading tab owns the picker and the Diary tab owns the list, and each
 * kept its own idea of which source was showing. Choosing Demo moved the
 * figures and left the browser on Live, which is how five demo trades could
 * be sent to the Diary and then not be in it. */
const basePickSource = window.pickSource;
window.pickSource = src => { DIARY.setSource(src); basePickSource(src); };

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
    const t = window.TRADES.find(x => keyOf(x) === box.dataset.key);
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
