/* The demo account: place a trade on today's market and let it run.
 *
 * The honest limitation, which is shown on screen rather than buried here: a
 * browser cannot hold a market feed, so the price is the last bar the site
 * published, and that is refreshed every fifteen minutes or so through the
 * session. It is a real price from a real market, some minutes ago.
 *
 * That makes this useful for sizing, for the risk-against-reward readout
 * before you commit, and for letting a trade run and seeing how it resolved.
 * It is not useful for practising the timing of an entry. The Replay tab is
 * the honest place for that, because there the delay does not matter: every
 * bar arrives in order and nothing after it is visible.
 *
 * Fills are resolved the same way the backtester resolves them, so a demo
 * result can sit beside a real one without flattering it.
 */
import * as E from "./engine.js";
import {levelsAt, FAMILY_COLOUR} from "./levels.js";
import {createChart} from "./chart.js";
import * as WL from "./watchlist.js";
import * as RV from "./revisit.js";

const $ = id => document.getElementById(id);
const KEY = "tradersdiary.demo";
const SYMS = ["NQ", "ES", "YM", "RTY"];
const START_BALANCE = 100000;

const D = {
  sym: "NQ", bars: [], pos: null, levels: true, model: null, modelKey: null,
  account: {balance: START_BALANCE, trades: []},
};

let tzHours = () => 2;
export const setClock = fn => { tzHours = fn; };
let onClosed = () => {};

const money = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
const plain = v => "$" + Math.round(v).toLocaleString("en-US");
const px = v => v.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});

const stamp = ms => {
  const d = new Date(ms + tzHours() * 3600e3);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
};

/* -------------------------------------------------------------- storage */

function loadAccount() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY));
    if (o && typeof o.balance === "number") {
      D.account = {balance: o.balance, trades: o.trades || []};
      D.pos = o.pos || null;
    }
  } catch { /* a fresh account is the right fallback */ }
}
function saveAccount() {
  try {
    localStorage.setItem(KEY, JSON.stringify(
      {balance: D.account.balance, trades: D.account.trades, pos: D.pos}));
  } catch { /* storage full or blocked; the screen is still right */ }
}

/* ---------------------------------------------------------------- data */

const last = () => D.bars.length ? D.bars[D.bars.length - 1] : null;

/** How old the price on screen is, in minutes. */
const delayMin = () => {
  const b = last();
  return b ? Math.max(0, Math.round((Date.now() - b.ms) / 60000)) : null;
};

/** The same age, said the way a person would say it.
 *
 *  "2251 min old" is technically right and tells you nothing. Over a weekend
 *  the number that matters is that the market has been shut for two days. */
function ageWords(m) {
  if (m == null) return "";
  if (m < 90) return `${m} min old`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} old`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} old`;
}

/** Bars for the revisit model, which is not the series being drawn.
 *
 *  The chart shows minute bars, and those only reach back about a week. Seven
 *  days is not a sample: built on it the base rate came out at 13% against the
 *  25% that sixty days gives, so the model would have been quietly wrong on
 *  the tab where a trade actually gets placed. The five-minute series covers
 *  sixty days and answers the same question, because the question is about
 *  daily levels rather than about minutes.
 */
async function loadModel(sym) {
  try {
    const r = await fetch(`bars/${sym}_5m.json`, {cache: "no-cache"});
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    j.bars.forEach((b, i) => {
      if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                       o: b[0], h: b[1], l: b[2], c: b[3]});
    });
    return RV.build(out);
  } catch { return null; }
}

async function loadSymbol(sym) {
  const r = await fetch(`bars/${sym}_1m.json`, {cache: "no-cache"});
  if (!r.ok) throw new Error("no published bars for " + sym);
  const j = await r.json();
  const out = [];
  j.bars.forEach((b, i) => {
    if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                     o: b[0], h: b[1], l: b[2], c: b[3]});
  });
  return out;
}

/* --------------------------------------------------------------- fills */

const fillPrice = (b, level, worseIsBelow) =>
  worseIsBelow ? (b.o < level ? b.o : level) : (b.o > level ? b.o : level);

/** Walk any bars that arrived since the position was opened, in order.
 *
 *  Bars land in batches here rather than one at a time, so this has to check
 *  every bar it has not seen, not just the newest. Skipping to the latest
 *  would miss a stop that was hit and then recovered from, which is exactly
 *  the case that matters. */
function settle() {
  const p = D.pos;
  if (!p) return;
  const long = p.side === "Long";
  for (const b of D.bars) {
    if (b.ms <= p.seen) continue;
    p.seen = b.ms;
    const hitStop = long ? b.l <= p.stop : b.h >= p.stop;
    const hitTgt = long ? b.h >= p.target : b.l <= p.target;
    if (hitStop) { close(fillPrice(b, p.stop, long), b.ms, "Stop"); return; }
    if (hitTgt) { close(fillPrice(b, p.target, !long), b.ms, "Take Profit"); return; }
  }
}

function close(price, ms, how) {
  const p = D.pos;
  const pts = p.side === "Long" ? price - p.entry : p.entry - price;
  const pv = E.POINT[p.symbol] ?? 1;
  const pnl = Math.round(pts * pv * p.qty * 100) / 100;
  const risk = p.risk0 ?? Math.abs(p.entry - p.stop);

  const trade = {
    source: "demo",
    symbol: p.symbol, side: p.side, qty: p.qty,
    open_t: p.open_t, close_t: stamp(ms),
    entry: p.entry, exit: Math.round(price * 100) / 100,
    stop: p.stop0 ?? p.stop, target: p.target,
    final_stop: p.stop,
    stop_moved: p.stop0 != null && Math.abs(p.stop - p.stop0) > 0.01,
    risk_pts: Math.round(risk * 100) / 100,
    reward_pts: Math.round(Math.abs(p.target - p.entry) * 100) / 100,
    planned_rr: Math.round(Math.abs(p.target - p.entry) / risk * 100) / 100,
    got_r: Math.round(pts / risk * 100) / 100,
    got_pts: Math.round(pts * 100) / 100,
    pnl,
    held_min: Math.max(0, Math.round((ms - p.ms) / 60000)),
    exit_type: how, flags: [], trail: p.trail || [],
    note: "Placed on the Demo account at a delayed price. Kept out of your "
        + "live figures.",
    note_base: "Placed on the Demo account at a delayed price. Kept out of "
             + "your live figures.",
    flags_base: [],
  };
  D.account.balance = Math.round((D.account.balance + pnl) * 100) / 100;
  D.account.trades.push(trade);
  D.pos = null;
  saveAccount();
  onClosed(trade);
}

/* ---------------------------------------------------------------- draw */

let chart = null;

function overlayLevels() {
  if (!D.levels || !D.bars.length) return [];
  const atMs = last() ? last().ms : null;
  const marks = levelsAt(D.bars, atMs)
    .map(m => ({...m, colour: FAMILY_COLOUR[m.family]}));
  // Measured on the five-minute history; whether a level has been tapped TODAY
  // is read off the minute bars on screen.
  const odds = RV.untappedNow(D.bars, atMs, D.model);
  for (const m of marks) {
    const o = m.label.includes("High") ? odds.get("above") : odds.get("below");
    if (m.family === "day" && o && Math.abs(o.price - m.price) < 1e-6)
      m.label += "  " + RV.pct(o.p) + " revisit" + (o.thin ? " ?" : "");
  }
  return marks;
}

function paint() {
  if (!chart) return;
  chart.setLevels(overlayLevels());
  chart.setPosition(D.pos);
}

function ohlc(b) {
  const box = $("dohlc");
  if (!box) return;
  if (!b) { box.innerHTML = ""; return; }
  const up = b.c >= b.o;
  box.innerHTML = '<span class="pohlc">'
    + `<span>${stamp(b.ms).slice(11, 16)}</span>`
    + `<span>O <b>${px(b.o)}</b></span><span>H <b>${px(b.h)}</b></span>`
    + `<span>L <b>${px(b.l)}</b></span>`
    + `<span class="${up ? "up" : "dn"}">C <b>${px(b.c)}</b></span></span>`;
}

/* -------------------------------------------------------------- render */

function ticket() {
  const b = last();
  const qty = Math.max(1, +$("dqty").value || 1);
  const risk = Math.max(0.25, +$("drisk").value || 0);
  const rr = Math.max(0.1, +$("drr").value || 0);
  const pv = E.POINT[D.sym] ?? 1;
  const lose = risk * pv * qty, win = risk * rr * pv * qty;
  const acct = D.account.balance;
  $("drisknote").innerHTML = b
    ? `Risk <b class="loss">${money(-lose)}</b> to make `
      + `<b class="win">${money(win)}</b><br>`
      + `<b>${(lose / acct * 100).toFixed(1)}%</b> of the account`
      + (rr < 1 ? '<span class="rrwarn">Risking more than you stand to make</span>' : "")
      + (lose / acct > 0.02
          ? '<span class="rrwarn">Over 2% of the account on one trade</span>' : "")
    : "";
}

function render() {
  const b = last();
  const d = delayMin();
  $("dread").innerHTML = b
    ? `${stamp(b.ms).slice(0, 16)} &nbsp; `
      + `<span class="${d > 90 ? "old" : ""}">${ageWords(d)}</span>`
    : "Loading the market...";
  if (b) {
    $("dbuypx").textContent = px(b.c);
    $("dsellpx").textContent = px(b.c);
    ohlc(b);
  }

  const p = D.pos;
  const stats = [
    ["balance", plain(D.account.balance), ""],
    ["open", p ? `${p.side} ${p.qty} ${p.symbol}` : "flat", ""],
  ];
  if (p && b) {
    const pts = p.side === "Long" ? b.c - p.entry : p.entry - b.c;
    const pv = E.POINT[p.symbol] ?? 1;
    const open = pts * pv * p.qty;
    stats.push(["unrealised", money(open), open >= 0 ? "win" : "loss"]);
    stats.push(["at", (pts / Math.abs(p.entry - p.stop)).toFixed(2) + "R", ""]);
  } else {
    const s = E.summarise(D.account.trades);
    stats.push(["record", `${s.wins}W / ${s.losses}L`, ""]);
    stats.push(["net", money(D.account.balance - START_BALANCE),
                D.account.balance >= START_BALANCE ? "win" : "loss"]);
  }
  $("dstats").innerHTML = stats.map(([l, v, c]) =>
    `<div class="stat"><span class="sl">${l}</span>`
    + `<span class="sv ${c}">${v}</span></div>`).join("");

  $("dposline").textContent = p
    ? `In a ${p.side.toLowerCase()} of ${p.qty} from ${px(p.entry)}, opened `
      + `${p.open_t.slice(11, 16)}. Stop ${px(p.stop)}, target ${px(p.target)}. `
      + `It settles by itself as new bars arrive.`
    : b ? "Flat. Set your size and stop, then take a side."
        : "Waiting for the market data to load.";

  $("dflat").hidden = !p;
  // Opening on a price from before the weekend is not a demo trade, it is a
  // bet on the gap. Nothing good is learned from it.
  const stale = d != null && d > 240;
  $("dbuy").disabled = $("dsell").disabled = !!p || !b || stale;
  if (stale && !p)
    $("dposline").textContent = `The market is shut. The last price is `
      + `${ageWords(d)}, so taking a trade on it would be a bet on where it `
      + `opens again rather than a trade. Come back when it is running, or `
      + `use Replay, where the delay does not matter.`;

  $("dlist").innerHTML = D.account.trades.slice().reverse().slice(0, 12).map(t =>
    `<li class="rpi"><span class="rpw">${t.symbol} ${t.side}</span>`
    + `<span class="rpr ${t.pnl >= 0 ? "win" : "loss"}">`
    + `${(t.got_r >= 0 ? "+" : "") + t.got_r.toFixed(2)}R</span>`
    + `<span class="rpm ${t.pnl >= 0 ? "win" : "loss"}">${money(t.pnl)}</span>`
    + `<span class="rpt">${t.exit_type}</span></li>`).join("");
  $("dsend").hidden = !D.account.trades.length;

  if (D.pos) dragNote(); else ticket();
  paint();
}


/* ------------------------------------------------------------ dragging */

/* Moving the stop is the most consequential thing you do inside a trade, and
 * your own record says it is what you get wrong most. So the app says so while
 * your finger is still on the line, not in a review a week later. It never
 * blocks the move: it is your trade. */
const BE_AT_R = 2;

function levelMoved(which, price) {
  const p = D.pos, b = last();
  if (!p || !b) return;
  const long = p.side === "Long";
  const tick = 0.25;
  const v = Math.round(price / tick) * tick;
  if (which === "stop") {
    // A stop the wrong side of the market is not a stop, it is an exit.
    p.stop = long ? Math.min(v, b.c - tick) : Math.max(v, b.c + tick);
  } else {
    p.target = long ? Math.max(v, b.c + tick) : Math.min(v, b.c - tick);
  }
  dragNote();
  paint();
}

function dragNote() {
  const p = D.pos, b = last();
  if (!p || !b) { ticket(); return; }
  const long = p.side === "Long";
  const risk = Math.abs(p.entry - p.stop);
  const reward = Math.abs(p.target - p.entry);
  const pv = E.POINT[p.symbol] ?? 1;
  const run = long ? b.c - p.entry : p.entry - b.c;
  const openR = p.risk0 ? run / p.risk0 : 0;
  const tighter = p.risk0 && risk < p.risk0 - 1e-9;
  $("drisknote").innerHTML =
    `Risk <b class="loss">${money(-risk * pv * p.qty)}</b> to make `
    + `<b class="win">${money(reward * pv * p.qty)}</b><br>`
    + `${(reward / risk).toFixed(2)} times your risk`
    + (reward < risk ? '<span class="rrwarn">Risking more than you stand to make</span>' : "")
    + (tighter && openR < BE_AT_R
        ? `<span class="rrwarn">Price has run ${openR.toFixed(2)}R. `
          + `Your rule holds the stop until ${BE_AT_R}R.</span>` : "")
    + (tighter && openR >= BE_AT_R
        ? '<span class="okmove">Past 2R, so this is the move your rule allows.</span>' : "");
}

/** Write a finished drag into the trail, once, the way an activity log would. */
function recordMove(which) {
  const p = D.pos, b = last();
  if (!p || !b || which !== "stop") return;
  p.trail = p.trail || [];
  const long = p.side === "Long";
  const run = long ? b.c - p.entry : p.entry - b.c;
  const step = {
    t: stamp(b.ms).slice(11),
    sl: p.stop,
    fav_r: p.risk0 ? Math.round(run / p.risk0 * 100) / 100 : null,
    kind: !p.trail.length ? "initial"
        : (long ? p.stop > p.entry : p.stop < p.entry) ? "wrong side"
        : Math.abs(p.stop - p.entry) < 0.01 ? "breakeven" : "tighten",
  };
  const lastStep = p.trail[p.trail.length - 1];
  if (lastStep && Math.abs(lastStep.sl - step.sl) < 1e-9) return;
  p.trail.push(step);
}

/* ------------------------------------------------------------ controls */

function open_(side) {
  const b = last();
  if (!b || D.pos) return;
  const qty = Math.max(1, +$("dqty").value || 1);
  const risk = Math.max(0.25, +$("drisk").value || 0);
  const rr = Math.max(0.1, +$("drr").value || 0);
  const entry = b.c, long = side === "Long";
  D.pos = {
    symbol: D.sym, side, qty, entry, ms: b.ms, open_t: stamp(b.ms), seen: b.ms,
    stop: Math.round((long ? entry - risk : entry + risk) * 100) / 100,
    target: Math.round((long ? entry + risk * rr : entry - risk * rr) * 100) / 100,
    // R is the risk taken AT ENTRY. Dragging the stop must not change the
    // denominator, and the diary reads `stop` as the one you set.
    risk0: risk,
    stop0: Math.round((long ? entry - risk : entry + risk) * 100) / 100,
    trail: [],
  };
  saveAccount();
  render();
}

export async function refresh() {
  const sym = D.pos ? D.pos.symbol : D.sym;
  try {
    D.bars = await loadSymbol(sym);
    settle();
  } catch { /* offline: whatever was loaded stays on screen */ }
  if (D.modelKey !== sym) {
    D.model = await loadModel(sym);
    D.modelKey = sym;
  }
  if (chart) chart.setData(D.bars, {keepView: true});
  render();
}

export function init(onSaveToDiary, onTradeClosed) {
  loadAccount();
  onClosed = onTradeClosed || (() => {});

  chart = createChart($("dc"), {
    timeLabel: ms => stamp(ms).slice(5, 16),
    onHover: b => ohlc(b || last()),
    onLevelMove: levelMoved,
    onLevelDrop: which => { recordMove(which); saveAccount(); render(); },
  });
  $("dzin").addEventListener("click", () => chart.zoomIn());
  $("dzout").addEventListener("click", () => chart.zoomOut());
  $("dfit").addEventListener("click", () => chart.fit(160));

  $("dsym").innerHTML = SYMS.map(s => `<option value="${s}">${s}</option>`).join("");
  const paintWatch = () => WL.render($("dwatch"), D.sym, sym => {
    // Switching contract mid-trade would orphan the position on a chart it
    // does not belong to, so it is simply not offered.
    if (D.pos) return;
    D.sym = sym;
    $("dsym").value = sym;
    refresh().then(paintWatch);
  });
  paintWatch();
  $("dsym").addEventListener("change", async () => {
    // Switching contract while in a trade would leave the position orphaned
    // on a chart it does not belong to.
    if (D.pos) { $("dsym").value = D.pos.symbol; return; }
    D.sym = $("dsym").value;
    await refresh();
  });

  $("dbuy").addEventListener("click", () => open_("Long"));
  $("dsell").addEventListener("click", () => open_("Short"));
  $("dflat").addEventListener("click", () => {
    const b = last();
    if (D.pos && b) close(b.c, b.ms, "Market");
    render();
  });
  $("dlevels").addEventListener("click", () => {
    D.levels = !D.levels;
    $("dlevels").setAttribute("aria-pressed", String(D.levels));
    paint();
  });
  for (const id of ["dqty", "drisk", "drr"])
    $(id).addEventListener("input", ticket);

  $("dsend").addEventListener("click", () => {
    if (!D.account.trades.length) return;
    const n = onSaveToDiary(D.account.trades);
    $("dposline").textContent = `${n} demo trade${n === 1 ? "" : "s"} sent to `
      + `the Diary. They sit under Demo and stay out of your live figures.`;
  });

  $("dreset").addEventListener("click", () => {
    if (!confirm(`Reset the demo account to ${plain(START_BALANCE)} and clear `
               + `its ${D.account.trades.length} trades? Anything already sent `
               + `to the Diary stays there.`)) return;
    D.account = {balance: START_BALANCE, trades: []};
    D.pos = null;
    saveAccount();
    render();
  });

  render();
  refresh();
  // The site republishes bars through the session, so a tab left open picks
  // them up without being reloaded.
  setInterval(() => { WL.refresh(); refresh().then(paintWatch); }, 5 * 60000);
}

export const redraw = () => { if (chart) chart.draw(); };
export const inTrade = () => !!D.pos;
