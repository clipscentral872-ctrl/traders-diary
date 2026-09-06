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
import {levelsAt, FAMILY_COLOUR} from "./levels.js";
import * as RV from "./revisit.js";
import {createChart} from "./chart.js";
import * as WL from "./watchlist.js";
import * as SER from "./series.js";

const $ = id => document.getElementById(id);
const PRACTICE_KEY = "tradersdiary.replay";

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
const clock = ms => stamp(ms).slice(11, 16);

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

function closeAt(price, ms, how) {
  const p = S.pos;
  const pts = p.side === "Long" ? price - p.entry : p.entry - price;
  const pv = E.POINT[S.sym] ?? 1;
  S.done.push({
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
  });
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
    ? `${S.sym} ${S.tf}   ${stamp(b.ms).slice(0, 16)}   `
      + (S.mode === "browse"
         ? "the whole series. Press Cut, then click the chart where you "
           + "want the future to stop."
         : `bar ${S.i + 1} of ${S.bars.length}`)
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
    side, qty, entry, ms: b.ms, open_t: stamp(b.ms),
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
  chart.setData(all);
  chart.setLimit(null);
  chart.fit(200);
  render();
  return all;
}

/** Cut the chart at this bar: everything after it stops existing. */
function cutAt(i) {
  // Enough history behind the cut to read structure from. Dropped in with
  // thirty bars of context there is nothing to have formed an opinion on.
  S.i = Math.max(30, Math.min(i, S.bars.length - 1));
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
  const want = Date.parse(d + "T00:00:00Z") - tzHours() * 3600e3;
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
  try { localStorage.setItem(PRACTICE_KEY, JSON.stringify(S.done)); } catch { /* fine */ }
}
function restoreDraft() {
  try {
    const raw = localStorage.getItem(PRACTICE_KEY);
    if (raw) S.done = JSON.parse(raw) || [];
  } catch { S.done = []; }
}

export function init(onSave) {
  chart = createChart($("rc"), {
    timeLabel: ms => stamp(ms).slice(5, 16),
    onHover: b => ohlc(b || S.bars[S.i]),
    onLevelMove: levelMoved,
    onLevelDrop: which => { recordMove(which); render(); },
    onPick: i => { armed(false); cutAt(i); },
  });

  $("rsym").innerHTML = SYMS.map(s => `<option value="${s}">${s}</option>`).join("");
  $("rtf").innerHTML = TF.map(([k, label]) =>
    `<button class="ptool tfb" data-tf="${k}" aria-pressed="${k === S.tf}">${label}</button>`)
    .join("");

  $("rsym").addEventListener("change", () => {
    S.sym = $("rsym").value;
    S.bars = [];
    reset();
  });
  $("rtf").addEventListener("click", e => {
    const b = e.target.closest(".tfb");
    if (!b) return;
    S.tf = b.dataset.tf;
    [...$("rtf").children].forEach(c =>
      c.setAttribute("aria-pressed", String(c.dataset.tf === S.tf)));
    S.bars = [];
    reset();
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
