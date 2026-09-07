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

const S = {
  sym: "NQ", tf: "5m", bars: [], i: 0, mode: "browse",
  pos: null, done: [], timer: null, levels: true,
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
  const run = S.bars.slice(entryIdx, exitIdx + 1);
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
    const after = S.bars.slice(exitIdx + 1);
    if (after.some(b => long ? b.h >= t.target : b.l <= t.target))
      t.flags.push("cut short");
  }
  return t;
}

function closeAt(price, ms, how) {
  const p = S.pos;
  const pts = p.side === "Long" ? price - p.entry : p.entry - price;
  const pv = E.POINT[S.sym] ?? 1;
  const entryIdx = p.i ?? 0;
  S.done.push(judge({
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
  }, entryIdx, S.i));
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
  if (!S.levels || !S.bars.length) return [];
  const atMs = S.bars[S.i] ? S.bars[S.i].ms : null;
  const marks = levelsAt(S.bars, atMs)
    .map(m => ({...m, colour: FAMILY_COLOUR[m.family]}));
  const odds = RV.untappedNow(S.bars, atMs, modelFor());
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
  chart.setPosition(S.pos);
  chart.setLimit(S.mode === "replay" ? S.i + 1 : null);
}

/* -------------------------------------------------------------- render */

function ohlc(b) {
  const box = $("rohlc");
  if (!b) { box.innerHTML = ""; return; }
  const up = b.c >= b.o;
  box.innerHTML = '<span class="pohlc">'
    + `<span>${clock(b.ms)}</span>`
    + `<span>O <b>${px(b.o)}</b></span><span>H <b>${px(b.h)}</b></span>`
    + `<span>L <b>${px(b.l)}</b></span>`
    + `<span class="${up ? "up" : "dn"}">C <b>${px(b.c)}</b></span></span>`;
}

function render() {
  const b = S.bars[S.i];
  $("rpread").textContent = b
    ? `${S.sym} ${S.tf}   ${C.full(b.ms)} ${C.zoneName(b.ms)}   `
      + (S.mode === "browse"
         ? "the whole series. Press Cut, then click the chart where you "
           + "want the future to stop."
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
  if (b) {
    $("rbuypx").textContent = px(b.c);
    $("rsellpx").textContent = px(b.c);
    ohlc(b);
  }

  if (p) dragNote(); else riskNote();
  results();
  paint();
}

function riskNote() {
  const b = S.bars[S.i];
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
  $("rstats").innerHTML = S.done.length ? [
    ["net", money(s.pnl), s.pnl >= 0 ? "win" : "loss"],
    ["record", `${s.wins}W / ${s.losses}L`, ""],
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
  const p = S.pos, b = S.bars[S.i];
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
  const p = S.pos, b = S.bars[S.i];
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
  const p = S.pos, b = S.bars[S.i];
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
  const b = S.bars[S.i];
  if (!b || S.pos || S.mode !== "replay") return;
  const qty = Math.max(1, +$("rqty").value || 1);
  const risk = Math.max(0.25, +$("rrisk").value || 0);
  const rr = Math.max(0.1, +$("rrr").value || 0);
  const entry = b.c, long = side === "Long";
  S.pos = {
    side, qty, entry, ms: b.ms, open_t: stamp(b.ms), i: S.i,
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
    if (S.i >= S.bars.length - 1) { stopAuto(); break; }
    S.i++;
    checkFills(S.bars[S.i]);
  }
  render();
}

function stopAuto() {
  if (S.timer) { clearInterval(S.timer); S.timer = null; $("rplay").textContent = "Auto"; }
}

/** Load the contract and show it whole, so there is something to cut into.
 *
 *  Browsing used to show an empty chart and a date box, which meant choosing
 *  a starting point blind. The whole series is on screen now, right up to the
 *  last bar published, and you scroll back to the bit you want. */
async function browse() {
  const all = await load(S.sym, S.tf).catch(() => null);
  if (!all || !all.length) {
    $("rpread").textContent = "No published bars for that contract yet.";
    return null;
  }
  S.bars = all;
  S.mode = "browse";
  S.pos = null;
  // Back to the start of the new series. Carrying the old index across a
  // timeframe change is how bar 13,664 ended up being asked for out of 4,600.
  S.i = 0;
  stopAuto();
  chart.setData(all);
  chart.setLimit(null);
  chart.fit(200);
  render();
  return all;
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
  const wasReplaying = S.mode === "replay";
  const at = wasReplaying && S.bars[S.i] ? S.bars[S.i].ms : null;
  S.bars = [];
  const all = await browse();
  if (!all || at == null) return;
  // The last bar that had closed by then, so nothing after the moment you
  // were at becomes visible just because the bars got bigger.
  let i = 0;
  for (let k = 0; k < all.length; k++) {
    if (all[k].ms <= at) i = k; else break;
  }
  cutAt(i);
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
  S.i = Math.max(0, Math.min(Math.max(30, i), S.bars.length - 1));
  S.mode = "replay";
  S.pos = null;
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

function reset() {
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
    if (raw) S.done = JSON.parse(raw) || [];
  } catch { S.done = []; }
}

export function init(onSave) {
  chart = createChart($("rc"), {
    timeLabel: ms => C.label(ms),
    onHover: b => ohlc(b || S.bars[S.i]),
    onLevelMove: levelMoved,
    onLevelDrop: which => { recordMove(which); render(); },
    onPick: i => { armed(false); cutAt(i); },
    overlay: c => DRAW.paint(c),
    onPress: (px, py) => DRAW.down(px, py, chart),
    onDrag: (px, py) => DRAW.move(px, py, chart),
  });

  $("rsym").innerHTML = SYMS.map(s => `<option value="${s}">${s}</option>`).join("");
  $("rtf").innerHTML = TF.map(([k, label]) =>
    `<button class="ptool tfb" data-tf="${k}" aria-pressed="${k === S.tf}">${label}</button>`)
    .join("");

  $("rsym").addEventListener("change", () => {
    S.sym = $("rsym").value;
    DRAW.setSymbol(S.sym);
    // A different contract is a different market, so the replay starts over.
    S.mode = "browse";
    S.bars = [];
    reset();
  });
  $("rtf").addEventListener("click", e => {
    const b = e.target.closest(".tfb");
    if (!b) return;
    S.tf = b.dataset.tf;
    [...$("rtf").children].forEach(c =>
      c.setAttribute("aria-pressed", String(c.dataset.tf === S.tf)));
    reload();
  });

  $("rgo").addEventListener("click", startFromDate);
  $("rcut").addEventListener("click", armCut);
  $("rstep1").addEventListener("click", () => step(1));
  $("rstep5").addEventListener("click", () => step(5));
  $("rstep20").addEventListener("click", () => step(20));
  $("rplay").addEventListener("click", () => {
    if (S.timer) { stopAuto(); return; }
    S.timer = setInterval(() => step(1), 420);
    $("rplay").textContent = "Stop";
  });
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
    const b = S.bars[S.i];
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
  // studying a session and clicking three hundred times.
  addEventListener("keydown", e => {
    const pane = document.querySelector('.tabpane[data-tab="replay"]');
    if (!pane || pane.hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 5 : 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); chart.panBy(e.shiftKey ? -5 : -1); }
  });

  $("rdate").value = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  restoreDraft();
  WL.render($("rwatch"), S.sym, sym => {
    if (S.pos) return;          // never switch contract out from under a trade
    S.sym = sym;
    $("rsym").value = sym;
    S.bars = [];
    reset();
    WL.render($("rwatch"), S.sym, () => {});
  });
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
