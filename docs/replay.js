/* Bar replay: step a past session forward without seeing what comes next.
 *
 * Two things make it worth doing rather than scrolling a chart.
 *
 * Fills are resolved exactly the way the backtester resolves them. Both
 * levels touched inside one bar counts as the loss, and a bar that opens past
 * your stop fills at the open rather than at the stop. Practice that fills
 * optimistically teaches a strategy that does not exist.
 *
 * And nothing past the playhead exists. The chart pans and zooms freely, but
 * the data simply stops there, so there is no way to see the answer early.
 */
import * as E from "./engine.js";
import * as C from "./clock.js";
import {levelsAt, FAMILY_COLOUR} from "./levels.js";
import * as RV from "./revisit.js";
import {createChart} from "./chart.js";
import * as WL from "./watchlist.js";
import * as SER from "./series.js";
import * as PC from "./precheck.js";
import * as DRAW from "./draw.js";
import * as P from "./profile.js";

const $ = id => document.getElementById(id);
// Practice trades live under whichever journal is open.

export const TF = SER.TIMEFRAMES.map(t => [t.key, t.label]);
const SYMS = ["NQ", "ES", "YM", "RTY"];

// Loading and any resampling live in series.js, so the replay and the demo
// build 15m and 4h the same way rather than each having its own idea of where
// a bar starts.
const load = SER.load;

/* --------------------------------------------------------------- state */

/* The replay keeps time in the finest bars it has for the chart on screen:
 * five minutes under a fifteen minute chart, the hour under four hours. The
 * candle on the right is built from what has been played so far, the way
 * TradingView forms it during a replay, and every fill, entry and readout is
 * taken from the latest fine bar, which is the market as it stands.
 *
 *   base    the fine bars, the ones the replay steps through
 *   j       the latest fine bar played
 *   full    the chart's own bars, finished, never altered
 *   bars    what the chart draws: full, with the candle at i still forming
 *   i       the candle that fine bar j belongs to
 *   k       for each fine bar, its candle
 *   clock   the moment the replay has reached, kept through a timeframe
 *           change so a coarser chart does not wind it back
 *
 * On five minutes and one minute the fine bars and the chart's bars are the
 * same series, and i and j are the same number. The hour and four hours step
 * in five minutes wherever five minute bars exist, and in hours before that;
 * see stitchHours in series.js. */
const S = {
  sym: "NQ", tf: "5m", bars: [], i: 0, mode: "browse",
  base: [], full: [], k: null, grouped: false, j: 0, touched: null,
  split: -Infinity,
  clock: null, seq: 0,
  pos: null, done: [], timer: null, levels: true,
  speed: 1,              // bars a second while it plays, TradingView's 1x
  model: null, modelKey: null,
};

let chart = null;

const money = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
const px = v => v.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});

let tzHours = () => 2;
export const setClock = fn => { tzHours = fn; };

const stamp = ms => {
  const d = new Date(ms + tzHours() * 3600e3);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
};
// Shown in New York, because that is what the session is measured in and
// what your TradingView charts print. Stored stamps stay in export time.
const clock = ms => C.hhmm(ms);

/* --------------------------------------------------------------- fills */

// Exactly the backtester's resolution. Both levels inside one bar is the loss,
// and a bar that opens past the level fills at the open.
const fillPrice = (b, level, worseIsBelow) =>
  worseIsBelow ? (b.o < level ? b.o : level) : (b.o > level ? b.o : level);

function checkFills(b) {
  const p = S.pos;
  if (!p) return;
  const long = p.side === "Long";
  const hitStop = long ? b.l <= p.stop : b.h >= p.stop;
  const hitTgt = long ? b.h >= p.target : b.l <= p.target;
  if (hitStop) { closeAt(fillPrice(b, p.stop, long), b.ms, "Stop"); return; }
  if (hitTgt) { closeAt(fillPrice(b, p.target, !long), b.ms, "Take Profit"); }
}

/* Judge a practice trade exactly as a real one is judged.
 *
 * Practice that is scored more kindly than the real thing teaches the wrong
 * lesson twice: it flatters the result and it hides the habit. The bars the
 * trade lived through are handed to the same excursion analysis the imported
 * trades go through, so the same stop habits get the same names.
 */
function judge(t, entryIdx, exitIdx) {
  // The fine bars, so a trade on a fifteen minute chart is judged on the
  // five minute bars it actually lived through.
  const run = S.base.slice(entryIdx, exitIdx + 1);
  if (run.length) {
    t.bars = run.map(b => ({t: stamp(b.ms).slice(11, 16),
                            o: b.o, h: b.h, l: b.l, c: b.c}));
    t.entry_i = 0;
    t.exit_i = t.bars.length - 1;
    E.analyseExcursion(t);
  }
  // The two that do not need bars, worded and thresholded as the engine does.
  if (t.planned_rr >= 3.5) t.flags.push("target far out");
  if (t.held_min <= 1 && t.got_r !== null && t.got_r < 0)
    t.flags.push("stopped fast");
  // Closed by hand, and the target came anyway before the bars ran out.
  if (t.exit_type === "Market") {
    const long = t.side === "Long";
    const after = S.base.slice(exitIdx + 1);
    if (after.some(b => long ? b.h >= t.target : b.l <= t.target))
      t.flags.push("cut short");
  }
  return t;
}

/* A trade taken here needs an identity of its own.
 *
 * The Diary de-duplicates on source, symbol and open time, and open time is
 * the BAR's time rather than the clock's. Published bars refresh about every
 * half hour, so every trade opened between two refreshes carries the same
 * open_t: close one, open another, and the second was dropped on the way to
 * the Diary as a duplicate of the first. A winning short disappeared that
 * way while the screen said three trades had been sent and four existed. */
let seq = 0;
const newId = () => `replay:${Date.now().toString(36)}:${++seq}`;

function closeAt(price, ms, how) {
  const p = S.pos;
  const pts = p.side === "Long" ? price - p.entry : p.entry - price;
  const pv = E.POINT[S.sym] ?? 1;
  const entryIdx = p.j ?? 0;
  S.done.push(judge({
    id: newId(),
    source: "replay",
    symbol: S.sym, side: p.side, qty: p.qty,
    open_t: p.open_t, close_t: stamp(ms),
    entry: p.entry, exit: Math.round(price * 100) / 100,
    stop: p.stop0 ?? p.stop, target: p.target,
    final_stop: p.stop,
    stop_moved: p.stop0 != null && Math.abs(p.stop - p.stop0) > 0.01,
    risk_pts: Math.round((p.risk0 ?? Math.abs(p.entry - p.stop)) * 100) / 100,
    reward_pts: Math.round(Math.abs(p.target - p.entry) * 100) / 100,
    planned_rr: Math.round(Math.abs(p.target - p.entry)
                         / (p.risk0 ?? Math.abs(p.entry - p.stop)) * 100) / 100,
    got_r: Math.round(pts / (p.risk0 ?? Math.abs(p.entry - p.stop)) * 100) / 100,
    got_pts: Math.round(pts * 100) / 100,
    pnl: Math.round(pts * pv * p.qty * 100) / 100,
    held_min: Math.max(0, Math.round((ms - p.ms) / 60000)),
    exit_type: how, flags: [], trail: p.trail || [],
    note: "Practice on replayed bars. Not part of your live record.",
    note_base: "Practice on replayed bars. Not part of your live record.",
    flags_base: [],
  }, entryIdx, S.j));
  S.pos = null;
  saveDraft();
}

/* -------------------------------------------------------------- overlay */

function modelFor() {
  // The revisit model is about daily levels, so it is always built on the
  // five-minute series whatever timeframe is being drawn.
  if (S.modelKey !== S.sym) {
    S.modelKey = S.sym;
    S.model = null;
    load(S.sym, "5m").then(b => { S.model = RV.build(b); paint(); }).catch(() => {});
  }
  return S.model;
}

function overlayLevels() {
  if (!S.levels || !S.base.length) return [];
  // From the fine bars up to the moment. The chart's own bars would count
  // the whole of the candle still forming, which has not all happened.
  const now = cur();
  const atMs = now ? now.ms : null;
  const marks = levelsAt(S.base, atMs)
    .map(m => ({...m, colour: FAMILY_COLOUR[m.family]}));
  const odds = RV.untappedNow(S.base, atMs, modelFor());
  for (const m of marks) {
    const o = m.label.includes("High") ? odds.get("above") : odds.get("below");
    if (m.family === "day" && o && Math.abs(o.price - m.price) < 1e-6)
      m.label += "  " + RV.pct(o.p) + " revisit" + (o.thin ? " ?" : "");
  }
  return marks;
}

/* What the two orders are worth, for the labels on their lines.
 *
 * The chart draws them; it does not know what a point of NQ is worth, and it
 * should not. This is worked out fresh on every repaint so the numbers move
 * with the line while it is being dragged. */
function withWorth(p) {
  if (!p) return null;
  const pv = E.POINT[S.sym] ?? 1;
  const open = openPnl();
  return {...p,
    stopMoney: money(-Math.abs(p.entry - p.stop) * pv * p.qty),
    targetMoney: money(Math.abs(p.target - p.entry) * pv * p.qty),
    openMoney: open == null ? null : money(open)};
}

/** What the open trade is making at the close of the bar you are on. */
function openPnl() {
  const p = S.pos, b = cur();
  if (!p || !b) return null;
  const pts = p.side === "Long" ? b.c - p.entry : p.entry - b.c;
  return pts * (E.POINT[S.sym] ?? 1) * p.qty;
}

/* Beside the play buttons, as TradingView keeps it: the open trade while
   there is one, and the practice so far once you are flat again. */
function pnlStrip() {
  const el = $("rpnl");
  const open = openPnl();
  const net = S.done.length ? E.summarise(S.done).pnl : null;
  const v = open != null ? open : net;
  el.textContent = v == null ? "" : (open != null ? "Open " : "Net ") + money(v);
  el.className = "ppnl" + (v == null ? "" : v >= 0 ? " win" : " loss");
}

function paint() {
  if (!chart) return;
  chart.setLevels(overlayLevels());
  chart.setPosition(withWorth(S.pos));
  // While choosing a new cut the whole series stays in view; see armCut.
  if (!chart.picking) chart.setLimit(S.mode === "replay" ? S.i + 1 : null);
  chart.setWatermark(S.mode === "replay" ? "Replay" : null);
}

/* -------------------------------------------------------------- render */

/* Volume the way a chart legend writes it: exact while it is small, then
   in thousands and millions, so the readout keeps its width. */
const vol = n => n >= 1e6 ? (n / 1e6).toFixed(2) + "M"
  : n >= 1e4 ? (n / 1e3).toFixed(1) + "K" : String(n);

function ohlc(b, prev) {
  const box = $("rohlc");
  if (!b) { box.innerHTML = ""; return; }
  const up = b.c >= b.o;
  // The change on the bar before, the way a chart legend shows it.
  const ch = prev ? b.c - prev.c : null;
  box.innerHTML = '<span class="pohlc">'
    + `<span><b>${S.sym}</b> ${S.tf}</span>`
    + `<span>${clock(b.ms)}</span>`
    + `<span>O <b>${px(b.o)}</b></span><span>H <b>${px(b.h)}</b></span>`
    + `<span>L <b>${px(b.l)}</b></span>`
    + `<span class="${up ? "up" : "dn"}">C <b>${px(b.c)}</b></span>`
    + (ch == null ? "" : `<span class="${ch >= 0 ? "up" : "dn"}">`
        + `${ch >= 0 ? "+" : ""}${px(ch)} `
        + `(${ch >= 0 ? "+" : ""}${(ch / prev.c * 100).toFixed(2)}%)</span>`)
    // The bar's volume, when the bars carry it, as the legend shows it.
    + (b.v != null ? `<span>Vol <b>${vol(b.v)}</b></span>` : "")
    + '</span>';
}

function render() {
  const b = S.bars[S.i];
  const now = cur() || b;
  $("rpread").textContent = b
    ? `${S.sym} ${S.tf}   ${C.full(now.ms)} ${C.zoneName(now.ms)}   `
      + (S.mode === "browse"
         ? "the whole series. Press Cut and click the chart where you "
           + "want the future to stop, or press Random for a day you did "
           + "not choose."
         : `bar ${S.i + 1} of ${S.bars.length}`)
    // "Loading" was a lie whenever the bars were already here and the index
    // was not, which is a different problem and needs a different sentence.
    : S.bars.length
      ? `Bar ${S.i + 1} is outside the ${S.bars.length} loaded. `
        + `Press the cross on the left to start again.`
      : "Loading the market...";
  $("rpctl").hidden = S.mode !== "replay";
  $("rticket").hidden = S.mode !== "replay";

  const p = S.pos;
  $("rposline").textContent = p
    ? `In a ${p.side.toLowerCase()} of ${p.qty} from ${px(p.entry)}. `
      + `Stop ${px(p.stop)}, target ${px(p.target)}.`
    : S.mode === "replay" ? "Flat. Step forward, or take a side." : "";
  $("rflat").hidden = !p;
  $("rbuy").disabled = $("rsell").disabled = !!p || S.mode !== "replay";
  // Start before a replay; Play and Pause during one. See its handler.
  $("rgo").textContent = S.mode === "replay" && !S.dateEdited
    ? (S.timer ? "Pause" : "Play") : "Start";
  if (b) {
    $("rbuypx").textContent = px(now.c);
    $("rsellpx").textContent = px(now.c);
    ohlc(b, S.bars[S.i - 1]);
  }

  pnlStrip();
  if (p) dragNote(); else riskNote();
  results();
  paint();
}

/** What the list needs to know: the bar, the money, and today so far. */
function context() {
  const b = cur();
  const qty = Math.max(1, +$("rqty").value || 1);
  const risk = Math.max(0.25, +$("rrisk").value || 0);
  const rr = Math.max(0.1, +$("rrr").value || 0);
  const pv = E.POINT[S.sym] ?? 1;
  const day = b ? C.day(b.ms) : null;
  return {
    ms: b ? b.ms : null,
    risk: risk * pv * qty,
    reward: risk * rr * pv * qty,
    // Practice has no account behind it, so the size check has nothing to
    // measure against and says nothing rather than inventing a balance.
    balance: null,
    today: S.done.filter(t => C.day(C.msOf(t.open_t)) === day),
  };
}

function precheck() {
  const box = $("rpre");
  if (!box) return;
  /* In a trade, only the release slot is still worth saying.
   *
   * Size and session are entry decisions and there is nothing to do about
   * them now. A scheduled release is different: it is the one thing on this
   * list that has already taken money out of this account, on a trade that
   * was open and doing fine until the minute before 08:30. */
  const list = S.mode !== "replay" ? []
    : S.pos ? PC.check(context()).filter(x => /New York/.test(x.text))
    : PC.check(context());
  box.hidden = !list.length;
  box.innerHTML = list.map(x =>
    `<div class="pcitem ${x.level}">${x.text}</div>`).join("");
}

function riskNote() {
  precheck();
  const b = cur();
  const qty = Math.max(1, +$("rqty").value || 1);
  const risk = Math.max(0.25, +$("rrisk").value || 0);
  const rr = Math.max(0.1, +$("rrr").value || 0);
  const pv = E.POINT[S.sym] ?? 1;
  $("rrisknote").innerHTML = b
    ? `Risk <b class="loss">${money(-risk * pv * qty)}</b> to make `
      + `<b class="win">${money(risk * rr * pv * qty)}</b>`
      + (rr < 1 ? '<span class="rrwarn">Risking more than you stand to make</span>' : "")
    : "";
}

/* How far off a number that means anything.
 *
 * A win rate over nine trades is a story about nine trades. Somewhere around
 * a hundred it starts to describe what tends to happen instead, and the whole
 * point of the replay is that a hundred practice trades is an evening rather
 * than five months. So the count is shown against that, and the expectancy is
 * shown with the hedging its sample size earns rather than as a fact.
 */
const ENOUGH = 100;

function book() {
  const bar = $("rbookfill"), note = $("rbook");
  if (!bar || !note) return;
  const saved = (window.TRADES || []).filter(t => t.source === "replay");
  const all = saved.concat(S.done);
  const n = all.length;
  bar.style.width = Math.min(100, n / ENOUGH * 100).toFixed(1) + "%";
  if (!n) {
    note.textContent = `No practice trades yet. Around ${ENOUGH} is where a `
      + `win rate starts to describe what tends to happen rather than what `
      + `happened.`;
    return;
  }
  const s = E.summarise(all);
  const unsaved = S.done.length
    ? `, ${S.done.length} of them not saved yet` : "";
  const edge = s.expectancy_r === null ? "no R yet"
    : `${s.expectancy_r >= 0 ? "+" : ""}${s.expectancy_r.toFixed(2)}R a trade`;
  note.innerHTML = `<b>${n} of ${ENOUGH}</b> practice trades${unsaved}. `
    + `${s.win_rate.toFixed(0)}% win rate, ${edge}. `
    + (n >= ENOUGH
       ? `Enough to read, though one market is one market.`
       : `Too few to read yet: ${ENOUGH - n} to go.`);
}

function results() {
  const s = E.summarise(S.done);
  // The three TradingView puts at the end of a replay: the money, the win
  // rate and the best trade. The rest is what R makes of them.
  const best = S.done.length ? Math.max(...S.done.map(t => t.pnl)) : 0;
  $("rstats").innerHTML = S.done.length ? [
    ["net", money(s.pnl), s.pnl >= 0 ? "win" : "loss"],
    ["record", `${s.wins}W / ${s.losses}L`, ""],
    ["win rate", `${s.win_rate.toFixed(0)}%`, ""],
    ["best trade", money(best), best >= 0 ? "win" : "loss"],
    ["expectancy", s.expectancy_r === null ? "&mdash;"
      : (s.expectancy_r >= 0 ? "+" : "") + s.expectancy_r.toFixed(2) + "R",
      (s.expectancy_r || 0) >= 0 ? "win" : "loss"],
    ["trades", String(s.trades), ""],
  ].map(([l, v, c]) => `<div class="stat"><span class="sl">${l}</span>`
    + `<span class="sv ${c}">${v}</span></div>`).join("")
    : '<div class="stat"><span class="sl">no practice trades yet</span>'
      + '<span class="sv">&mdash;</span></div>';

  $("rplist").innerHTML = S.done.slice().reverse().map(t =>
    `<li class="rpi"><span class="rpw">${t.symbol} ${t.side}</span>`
    + `<span class="rpr ${t.pnl >= 0 ? "win" : "loss"}">`
    + `${(t.got_r >= 0 ? "+" : "") + t.got_r.toFixed(2)}R</span>`
    + `<span class="rpm ${t.pnl >= 0 ? "win" : "loss"}">${money(t.pnl)}</span>`
    + `<span class="rpt">${t.exit_type}</span></li>`).join("");
  $("rsave").hidden = $("rclear").hidden = !S.done.length;
  book();
}


/* ------------------------------------------------------------ dragging */

/* Moving the stop on the chart is the single most consequential thing you do
 * in a trade, and it is the thing your own record says you get wrong most:
 * eleven of your stops were tightened before your rule said to. So the app
 * says so while your finger is still on it, rather than in a review a week
 * later. The move is never blocked. It is your trade. */
function levelMoved(which, price) {
  const p = S.pos, b = cur();
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
  const p = S.pos, b = cur();
  if (!p || !b) { riskNote(); return; }
  const long = p.side === "Long";
  const risk = Math.abs(p.entry - p.stop);
  const reward = Math.abs(p.target - p.entry);
  const pv = E.POINT[S.sym] ?? 1;
  const run = long ? b.c - p.entry : p.entry - b.c;
  // R here is the risk you took AT ENTRY, not the one you are dragging to.
  const openR = p.risk0 ? run / p.risk0 : 0;
  const tighter = p.risk0 && risk < p.risk0 - 1e-9;

  $("rrisknote").innerHTML =
    `Risk <b class="loss">${money(-risk * pv * p.qty)}</b> to make `
    + `<b class="win">${money(reward * pv * p.qty)}</b>`
    + `<br>${(reward / risk).toFixed(2)} times your risk`
    + (reward < risk ? '<span class="rrwarn">Risking more than you stand to make</span>' : "")
    + (tighter && openR < BE_AT_R
        ? `<span class="rrwarn">Price has run ${openR.toFixed(2)}R. `
          + `Your rule holds the stop until ${BE_AT_R}R.</span>` : "")
    + (tighter && openR >= BE_AT_R
        ? '<span class="okmove">Past 2R, so this is the move your rule allows.</span>' : "");
}

const BE_AT_R = 2;

/** Write a finished drag into the trail, once, the way an activity log would.
 *
 *  Recorded on release rather than on every frame of the drag, or one move of
 *  the mouse would land in the record as forty. */
function recordMove(which) {
  const p = S.pos, b = cur();
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
  const last = p.trail[p.trail.length - 1];
  if (last && Math.abs(last.sl - step.sl) < 1e-9) return;
  p.trail.push(step);
}

/* ------------------------------------------------------------ controls */

function open_(side) {
  const b = cur();
  if (!b || S.pos || S.mode !== "replay") return;
  // The short list, before the entry rather than after it. Only the items
  // that have cost real money ask twice; the rest are already on screen.
  const list = PC.check(context());
  if (PC.holds(list) && !confirm(PC.ask(list))) return;
  const qty = Math.max(1, +$("rqty").value || 1);
  const risk = Math.max(0.25, +$("rrisk").value || 0);
  const rr = Math.max(0.1, +$("rrr").value || 0);
  const entry = b.c, long = side === "Long";
  S.pos = {
    side, qty, entry, ms: b.ms, open_t: stamp(b.ms), j: S.j,
    stop: Math.round((long ? entry - risk : entry + risk) * 100) / 100,
    target: Math.round((long ? entry + risk * rr : entry - risk * rr) * 100) / 100,
    // R is the risk taken AT ENTRY. Dragging the stop later must not quietly
    // change the denominator, so the original is kept, and so is the price it
    // sat at: the diary reads `stop` as the stop you SET, with the trail
    // holding where it went afterwards.
    risk0: risk,
    stop0: Math.round((long ? entry - risk : entry + risk) * 100) / 100,
  };
  render();
}

function step(n) {
  if (S.mode !== "replay") return;
  for (let k = 0; k < n; k++) {
    if (S.j >= S.base.length - 1) { stopAuto(); break; }
    S.j++;
    checkFills(S.base[S.j]);
  }
  S.clock = S.base[S.j].ms + durAt(S.j);
  sync();
  render();
}

/* ------------------------------------------------------------ the clock */

/** The latest bar played: the market as it stands now. */
function cur() { return S.base[S.j]; }

/** How long fine bar m lasts. The hourly chart's fine bars are hours before
 *  the five minute bars begin and five minutes after. */
function durAt(m) {
  if (S.base[m] && S.base[m].ms < S.split) return 60 * 60000;
  const spec = SER.TIMEFRAMES.find(t => t.key === S.tf) || SER.TIMEFRAMES[0];
  return spec.key === "1h" || spec.key === "4h" ? 5 * 60000
    : SER.STEP_MS[spec.from] || 5 * 60000;
}

/** The forming candle where the clock is, the finished one back where it
 *  was. */
function sync() {
  if (!S.grouped) { S.i = S.j; return; }
  if (S.touched != null && S.touched !== S.k[S.j])
    S.bars[S.touched] = S.full[S.touched];
  S.i = S.k[S.j];
  S.bars[S.i] = SER.formingBar(S.base, S.k, S.j, S.full[S.i].ms);
  S.touched = S.i;
}

/** The last index in an ascending run of numbers whose value passes. */
function lastWhere(n, ok) {
  let lo = 0, hi = n - 1, ans = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ok(m)) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

/** The last fine bar of candle i, which is where a cut at candle i lands. */
const lastFineOf = i => S.grouped ? lastWhere(S.k.length, m => S.k[m] <= i) : i;

/** The last fine bar that had closed by this moment. */
const fineClosedBy = ms =>
  lastWhere(S.base.length, m => S.base[m].ms + durAt(m) <= ms);

/** The fine bar a moment falls in. */
const fineAt = ms => lastWhere(S.base.length, m => S.base[m].ms <= ms);

/** Close an open trade at the market as it stands, so leaving the moment it
 *  was taken in never drops it from the record without a word. */
function flatten() {
  const b = cur();
  if (S.pos && b) closeAt(b.c, b.ms, "Market");
}

function stopAuto() {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  playButton();
}

/* The play button shows what pressing it will do, as TradingView's does: a
   triangle while stopped, two bars while playing. */
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>';
function playButton() {
  const b = $("rplay");
  const on = !!S.timer;
  b.innerHTML = on ? PAUSE : PLAY;
  b.title = on ? "Pause (Shift+Down)" : "Play (Shift+Down)";
  b.setAttribute("aria-label", on ? "Pause" : "Play");
}

/* Play and pause. Shared by the play button and by Start during a replay,
   so the two can never disagree about whether it is running. */
function toggleAuto() {
  if (S.mode !== "replay") return;
  if (S.timer) { stopAuto(); render(); return; }
  // At the last bar there is nothing to play, and a timer would only stop
  // itself on its first tick.
  if (S.j >= S.base.length - 1) return;
  S.timer = setInterval(() => step(1), 1000 / S.speed);
  playButton();
  render();
}

/* One bar and no more. It pauses a running replay first, because the point
   of stepping is to be the one deciding when the next candle comes. */
function forward() {
  stopAuto();
  step(1);
}

function setSpeed(v) {
  const n = Number(v);
  if (!(n > 0)) return;
  S.speed = n;
  P.set("replaySpeed", String(n));
  // A change while it plays takes effect at once, not after a pause.
  if (S.timer) {
    clearInterval(S.timer);
    S.timer = setInterval(() => step(1), 1000 / S.speed);
  }
}

/** Load the contract and show it whole, so there is something to cut into.
 *
 *  Browsing used to show an empty chart and a date box, which meant choosing
 *  a starting point blind. The whole series is on screen now, right up to the
 *  last bar published, and you scroll back to the bit you want. */
/* The bars the replay steps through, and the ones it draws. Built fresh on
   each load: stitching and indexing a couple of years of bars is a few
   milliseconds, and a copy kept here would miss newly published bars. */
async function loadSeries() {
  const spec = SER.TIMEFRAMES.find(t => t.key === S.tf) || SER.TIMEFRAMES[0];
  let got;
  if (spec.key === "1h" || spec.key === "4h") {
    const h1 = await load(S.sym, "1h");
    if (!h1 || !h1.length) return null;
    const m5 = await load(S.sym, "5m").catch(() => null);
    const st = SER.stitchHours(h1, m5);
    const full = spec.key === "1h" ? st.hours
      : SER.resample(st.hours, 60 * 60000, 4, true);
    got = {full, base: st.fine, k: SER.bucketIndex(st.fine, full), split: st.split};
  } else {
    const full = await load(S.sym, S.tf);
    if (!full || !full.length) return null;
    if (spec.group === 1) got = {full, base: full, k: null, split: -Infinity};
    else {
      const base = await load(S.sym, spec.from);
      if (!base || !base.length) return null;
      got = {full, base, k: SER.bucketIndex(base, full), split: -Infinity};
    }
  }
  return got;
}

async function browse() {
  const seq = ++S.seq;
  const got = await loadSeries().catch(() => null);
  // Another contract or timeframe was asked for while this one loaded, and
  // arriving second must not put this one back on screen over it.
  if (seq !== S.seq) return null;
  if (!got) {
    $("rpread").textContent = "No published bars for that contract yet.";
    return null;
  }
  S.full = got.full;
  S.base = got.base;
  S.k = got.k;
  S.split = got.split;
  S.grouped = !!got.k;
  // A copy to draw from when candles form in it, so the finished bars that
  // are held for everything else are never altered.
  S.bars = S.grouped ? got.full.slice() : got.full;
  S.touched = null;
  S.mode = "browse";
  S.pos = null;
  // Back to the start of the new series. Carrying the old index across a
  // timeframe change is how bar 13,664 ended up being asked for out of 4,600.
  S.i = 0;
  S.j = 0;
  S.clock = null;
  stopAuto();
  chart.setData(S.bars);
  chart.setLimit(null);
  chart.fit(200);
  render();
  return S.bars;
}

/**
 * Reload the current contract and timeframe, staying where you were.
 *
 * Changing timeframe mid-replay should not throw the replay away. What you
 * are looking at is a moment, not a bar number, so the moment is what is
 * kept: the same instant is found in the new series and cut there again.
 * Bar numbers do not survive the change and were never the thing that
 * mattered.
 */
async function reload() {
  const clock = S.mode === "replay" ? S.clock : null;
  // A trade survives the change. It was being dropped without a word, and
  // looking at the hour in the middle of a five minute trade is what you do.
  const keep = S.mode === "replay" ? S.pos : null;
  S.bars = [];
  const all = await browse();
  if (!all || clock == null) return;
  // The last fine bar that had closed by then, so nothing after the moment
  // you were at becomes visible just because the bars got bigger.
  enter(fineClosedBy(clock));
  // The hour cannot show 10:25, so it stops at 10:00. Going back to five
  // minutes should find 10:25 again rather than 10:00.
  S.clock = Math.max(S.clock, clock);
  if (keep) {
    keep.j = fineAt(keep.ms);
    S.pos = keep;
    render();
  }
}

/* Another contract at the same moment. TJR flips between NQ and ES at the
   open to see whether one has taken out a high the other has not, and a
   replay that started over on every switch made that impossible. An open
   trade is priced in its own contract, so the switch waits for it. */
async function switchTo(sym) {
  if (!sym || sym === S.sym) return;
  if (S.pos) {
    $("rsym").value = S.sym;
    $("rpread").textContent = `Close the ${S.sym} trade first. It is priced `
      + `in ${S.sym}, not ${sym}.`;
    return;
  }
  stopAuto();
  armed(false);
  S.sym = sym;
  $("rsym").value = sym;
  DRAW.setSymbol(sym);
  await reload();
  WL.render($("rwatch"), S.sym, () => {});
}

/** Cut the chart at this bar: everything after it stops existing. */
function cutAt(i) {
  // Nothing to cut. Without this the clamp below produced bar 30 of an empty
  // series, which left the replay showing "Loading the market" for good with
  // the transport and the order ticket sitting there over it.
  // A bar number that is not a number cannot be cut at. Belt as well as
  // braces: the chart guards its end of this too.
  if (!Number.isFinite(i)) return;
  if (!S.bars.length) {
    $("rpread").textContent = "The bars are still loading. Try that again in "
      + "a moment.";
    return;
  }
  // Enough history behind the cut to read structure from. Dropped in with
  // thirty bars of context there is nothing to have formed an opinion on.
  const k = Math.max(0, Math.min(Math.max(30, i), S.bars.length - 1));
  flatten();
  S.pos = null;
  // A cut at a candle is a cut at its close: its last fine bar.
  enter(lastFineOf(k));
}

/** Start replaying from fine bar j. */
function enter(j) {
  S.j = Math.max(0, Math.min(j, S.base.length - 1));
  S.mode = "replay";
  S.clock = S.base[S.j].ms + durAt(S.j);
  sync();
  // The date box follows the cut, so it never shows a day you are not on,
  // and Start plays on from here instead of jumping to a stale date.
  $("rdate").value = C.day(cur().ms);
  S.dateEdited = false;
  stopAuto();
  chart.setLimit(S.i + 1);
  chart.fit(160);
  render();
}

/** Show or clear the armed state, in the three places it has to agree. */
function armed(on) {
  $("rcut").setAttribute("aria-pressed", on ? "true" : "false");
  $("rcuthint").hidden = !on;
  chart.pick(on);
}

/** The scissors. Click the chart to choose where the future stops. */
async function armCut() {
  if (chart.picking) { armed(false); render(); return; }
  if (!S.bars.length && !(await browse())) return;
  stopAuto();
  // Choosing again in the middle of a replay shows the whole series, the
  // part after the cursor faded, as TradingView's Select bar does, so the
  // new start can be later than where you are as well as earlier. The chart
  // stays where it is rather than jumping to the far end. Cancelling puts
  // the limit back through render().
  if (S.mode === "replay") chart.setLimit(null, {keepView: true});
  armed(true);
  $("rpread").textContent = "Scroll back to the moment you want, then click "
    + "the chart. Everything after that point is hidden until you play it "
    + "forward.";
}

/** The other way in, which every platform also offers: pick a date. */
async function startFromDate() {
  const d = $("rdate").value;
  if (!d) { $("rpread").textContent = "Pick a date first."; return; }
  if (!S.bars.length && !(await browse())) return;
  // The date you type is a New York date, because that is the session you
  // are picking. Read as your own local midnight it landed hours off.
  const want = Date.parse(d + "T00:00:00Z") - C.zoneOffsetAt(
    Date.parse(d + "T12:00:00Z")) * 60000;
  let i = S.bars.findIndex(b => b.ms >= want);
  if (i < 0) i = S.bars.length - 1;
  cutAt(i);
}

/* New York's own clock, whatever zone the times on screen are shown in,
   because the open is at 09:30 in New York wherever you are sitting. */
const NYF = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", weekday: "short",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit"});
function nyAt(ms) {
  const o = {};
  for (const p of NYF.formatToParts(new Date(ms))) o[p.type] = p.value;
  return {day: `${o.year}-${o.month}-${o.day}`, wd: o.weekday,
          min: (+o.hour % 24) * 60 + +o.minute};
}

/**
 * A random weekday, cut just before the New York open.
 *
 * TradingView's Random bar, aimed at the moment TJR practises: the open is
 * the next thing to happen, with the night's highs and lows already on the
 * chart. A day you choose is a day you may remember, and knowing how it went
 * spoils the practice. The last two days are left out so there is always a
 * session ahead to play.
 *
 * The cut is the last bar that had closed by 09:30. On five minutes that is
 * the 09:25 bar; on the hour it is 08:00, because the 09:00 bar has the open
 * inside it.
 */
async function randomStart() {
  if (!S.bars.length && !(await browse())) return;
  armed(false);
  const bars = S.bars;
  const cuts = [];
  let seen = null;
  for (let k = 2; k < bars.length; k++) {
    const t = nyAt(bars[k].ms);
    if (t.day === seen || t.min < 570) continue;
    seen = t.day;
    if (t.wd === "Sat" || t.wd === "Sun") continue;
    const cut = t.min === 570 ? k - 1 : k - 2;
    if (cut >= 30) cuts.push(cut);
  }
  cuts.splice(-2);
  if (!cuts.length) {
    $("rpread").textContent = "Not enough days loaded to pick one at random.";
    return;
  }
  // Not the day you were just given, if there is any other.
  let pick;
  do pick = cuts[Math.floor(Math.random() * cuts.length)];
  while (cuts.length > 1 && pick === S.lastRandom);
  S.lastRandom = pick;
  cutAt(pick);
}

function reset() {
  flatten();
  stopAuto();
  armed(false);
  browse();
}

function saveDraft() {
  P.set("replay", JSON.stringify(S.done));
}
function restoreDraft() {
  try {
    const raw = P.get("replay");
    // Another journal's practice is not this one's, so none held is none.
    S.done = raw ? JSON.parse(raw) || [] : [];
  } catch { S.done = []; }
}

export function init(onSave) {
  chart = createChart($("rc"), {
    timeLabel: ms => C.label(ms),
    timeParts: ms => ({day: C.day(ms), min: C.minutes(ms)}),
    onHover: (b, i, prev) => ohlc(b || S.bars[S.i], b ? prev : S.bars[S.i - 1]),
    onLevelMove: levelMoved,
    onLevelDrop: which => { recordMove(which); render(); },
    onPick: i => { armed(false); cutAt(i); },
    overlay: c => DRAW.paint(c),
    onPress: (px, py) => DRAW.down(px, py, chart),
    onDrag: (px, py) => DRAW.move(px, py, chart),
    onRelease: moved => { if (DRAW.release(moved)) chart.repaint(); },
  });

  $("rsym").innerHTML = SYMS.map(s => `<option value="${s}">${s}</option>`).join("");
  $("rtf").innerHTML = TF.map(([k, label]) =>
    `<button class="ptool tfb" data-tf="${k}" aria-pressed="${k === S.tf}">${label}</button>`)
    .join("");

  $("rsym").addEventListener("change", () => switchTo($("rsym").value));
  $("rtf").addEventListener("click", e => {
    const b = e.target.closest(".tfb");
    if (!b) return;
    S.tf = b.dataset.tf;
    [...$("rtf").children].forEach(c =>
      c.setAttribute("aria-pressed", String(c.dataset.tf === S.tf)));
    reload();
  });

  /* Start means start. Before a replay it jumps to the date in the box.
     Once a replay was cut, with the scissors or by date, pressing it again
     re-cut at the date box, which the scissors never updated: it threw the
     cut away and jumped to midnight of whatever day the box still showed.
     Now it plays on from where you are, and only a date you have changed
     since sends it anywhere else. */
  $("rgo").addEventListener("click", () => {
    if (S.mode === "replay" && !S.dateEdited) { toggleAuto(); return; }
    startFromDate();
  });
  $("rdate").addEventListener("input", () => { S.dateEdited = true; render(); });
  $("rcut").addEventListener("click", armCut);
  $("rrandom").addEventListener("click", randomStart);
  $("rstep1").addEventListener("click", forward);
  $("rplay").addEventListener("click", toggleAuto);
  S.speed = Number(P.get("replaySpeed")) || 1;
  $("rspeed").value = String(S.speed);
  if ($("rspeed").value !== String(S.speed)) { S.speed = 1; $("rspeed").value = "1"; }
  $("rspeed").addEventListener("change", e => setSpeed(e.target.value));
  playButton();
  /* The drawing rail, the way a platform puts it: down the left, one icon a
     tool, the armed one lit. */
  $("rtools").innerHTML = DRAW.TOOLS.map(t =>
    `<button class="rtool" data-tool="${t.id}" title="${t.name}"`
    + ` aria-pressed="${t.id === "cursor"}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg>`
    + "</button>").join("");
  const litTools = () => {
    const on = DRAW.getTool();
    [...$("rtools").children].forEach(b =>
      b.setAttribute("aria-pressed", String(b.dataset.tool === on)));
    $("rwipe").disabled = !DRAW.count();
  };
  DRAW.setOnChange(litTools);
  $("rtools").addEventListener("click", e => {
    const b = e.target.closest(".rtool");
    if (!b) return;
    DRAW.setTool(b.dataset.tool);
    litTools();
    paint();
  });
  $("rwipe").addEventListener("click", () => {
    if (!DRAW.count()) return;
    if (!confirm(`Remove all ${DRAW.count()} drawings on ${S.sym}?`)) return;
    DRAW.clear();
    paint();
  });
  // Escape drops the tool, Delete removes what is selected. Both are what a
  // hand already trained on TradingView will reach for.
  addEventListener("keydown", e => {
    const pane = document.querySelector('.tabpane[data-tab="replay"]');
    if (!pane || pane.hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    // Alt+R puts the chart back the way it started, time and price together,
    // as TradingView's shortcut does. Matched on the key, not the character,
    // because Alt+R types something else on some keyboards.
    if (e.altKey && e.code === "KeyR") { e.preventDefault(); chart.fit(160); return; }
    if (e.key === "Escape" && chart.picking) { armed(false); render(); return; }
    if (e.key === "Escape" && DRAW.cancel()) { litTools(); paint(); }
    if ((e.key === "Delete" || e.key === "Backspace") && DRAW.hasSelection()) {
      e.preventDefault();
      DRAW.removeSelected();
      litTools();
      paint();
    }
  });
  litTools();

  $("rback").addEventListener("click", reset);
  $("rbuy").addEventListener("click", () => open_("Long"));
  $("rsell").addEventListener("click", () => open_("Short"));
  $("rflat").addEventListener("click", () => {
    const b = cur();
    if (S.pos && b) closeAt(b.c, b.ms, "Market");
    render();
  });
  $("rlevels").addEventListener("click", () => {
    S.levels = !S.levels;
    $("rlevels").setAttribute("aria-pressed", String(S.levels));
    paint();
  });
  $("rzin").addEventListener("click", () => chart.zoomIn());
  $("rzout").addEventListener("click", () => chart.zoomOut());
  $("rfit").addEventListener("click", () => chart.fit(160));
  for (const id of ["rqty", "rrisk", "rrr"])
    $(id).addEventListener("input", riskNote);

  // On a laptop, stepping with the arrow keys is the difference between
  // studying a session and clicking three hundred times. Shift+Right and
  // Shift+Down are TradingView's own replay keys, forward one bar and play
  // or pause, so the hand that learned them there works here.
  addEventListener("keydown", e => {
    const pane = document.querySelector('.tabpane[data-tab="replay"]');
    if (!pane || pane.hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowDown" && e.shiftKey) { e.preventDefault(); toggleAuto(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); forward(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); chart.panBy(e.shiftKey ? -5 : -1); }
  });

  $("rdate").value = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  restoreDraft();
  WL.render($("rwatch"), S.sym, sym => switchTo(sym));
  // Land on the live chart rather than an empty box.
  browse();

  $("rsave").addEventListener("click", () => {
    if (!S.done.length) return;
    const n = onSave(S.done);
    S.done = [];
    saveDraft();
    results();
    $("rposline").textContent = `${n} practice trade${n === 1 ? "" : "s"} sent `
      + `to the Diary, under Replay and out of your live figures.`;
  });
  $("rclear").addEventListener("click", () => {
    if (!confirm(`Discard ${S.done.length} practice trades?`)) return;
    S.done = [];
    saveDraft();
    results();
  });
  render();
}

export const redraw = () => { if (chart) chart.draw(); };
export const inTrade = () => !!S.pos;

/* What the journal keeps for the replay, read again once the journal is
 * open: the practice trades not yet sent to the Diary, and the speed.
 *
 * init() runs before the PIN is typed, when there is no journal to read, so
 * both came back empty after every reload. Worse, the next practice trade
 * then saved the empty list plus itself over the ones that were waiting. */
export function reopen() {
  restoreDraft();
  const sp = Number(P.get("replaySpeed")) || 1;
  $("rspeed").value = String(sp);
  S.speed = $("rspeed").value === String(sp) ? sp : 1;
  if (S.speed !== sp) $("rspeed").value = "1";
  render();
}
