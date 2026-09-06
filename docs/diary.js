/* Watching your own trades back.
 *
 * This is the reason the whole thing exists. A row in a table cannot show you
 * that the stop was moved to the wrong side of the market, or that you took
 * 13% of a move you had planned. You have to see the candles.
 *
 * So the chart is the first thing on the tab and the biggest thing on it, on
 * the same interactive surface as the demo and the replay: crosshair, pan,
 * zoom, stretch the price axis. Winners and losers can be filtered apart,
 * because reviewing five losses back to back shows the same mistake repeating
 * in a way that is invisible when wins are shuffled between them.
 */
import {createChart} from "./chart.js";
import * as C from "./clock.js";

const $ = id => document.getElementById(id);

const S = {list: [], i: 0, filter: "all", source: "live"};
let chart = null;
let tzHours = () => 2;
export const setClock = fn => { tzHours = fn; };

const px = v => v == null ? "—" : v.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});
const money = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
// A trade with no stop has no R, because R is the risk. Null is the honest
// value and must not be drawn as zero: null >= 0 is true in JavaScript, so it
// would otherwise be coloured as a win.
const rr = v => v == null ? "no R" : (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
const won = t => t.got_r == null ? t.pnl >= 0 : t.got_r >= 0;
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

/* The bars stored with a trade carry "HH:MM" rather than a timestamp, because
   that is what the renderer needed. The chart wants real times, so the day of
   the trade is put back onto them here. */
function barsOf(t) {
  if (!t.bars || !t.bars.length) return [];
  const day = t.open_t.slice(0, 10);
  let prev = -Infinity;
  let dayShift = 0;
  return t.bars.map(b => {
    let ms = Date.parse(`${day}T${b.t}:00Z`) - tzHours() * 3600e3
           + dayShift * 86400000;
    // A session that runs past midnight comes back as 23:58, 23:59, 00:00.
    // Without this the chart would fold the next day back onto the previous.
    if (ms < prev) { dayShift++; ms += 86400000; }
    prev = ms;
    return {ms, o: b.o, h: b.h, l: b.l, c: b.c};
  });
}

function matching() {
  const all = (window.TRADES || [])
    .filter(t => S.source === "all" || (t.source || "live") === S.source);
  if (S.filter === "won") return all.filter(t => t.pnl > 0);
  if (S.filter === "lost") return all.filter(t => t.pnl < 0);
  return all;
}

/* ---------------------------------------------------------------- list */

function strip() {
  $("dtabs").innerHTML = S.list.map((t, i) =>
    `<button class="dtab ${won(t) ? "win" : "loss"}${i === S.i ? " on" : ""}" `
    + `data-i="${i}" role="tab" aria-selected="${i === S.i}">`
    + `<span class="dtn">${i + 1}</span>`
    + `<span class="dts">${esc(t.symbol)} ${esc(t.side)}</span>`
    + `<span class="dtr">${rr(t.got_r)}</span></button>`).join("");
  const on = $("dtabs").querySelector(".on");
  if (on) on.scrollIntoView({block: "nearest", inline: "center"});
}

function counts() {
  const all = (window.TRADES || [])
    .filter(t => S.source === "all" || (t.source || "live") === S.source);
  const w = all.filter(t => t.pnl > 0).length;
  const l = all.filter(t => t.pnl < 0).length;
  for (const [k, n] of [["all", all.length], ["won", w], ["lost", l]]) {
    const b = $("dfilter").querySelector(`[data-f="${k}"] .dfn`);
    if (b) b.textContent = n;
  }
}

/* --------------------------------------------------------------- detail */

function values(t) {
  const row = (k, v, cls = "") =>
    `<div class="dval"><span class="dvk">${k}</span>`
    + `<span class="dvv ${cls}">${v}</span></div>`;
  const pts = t.risk_pts == null ? "" : `<small>${px(t.risk_pts)} pts</small>`;
  $("dvalues").innerHTML = [
    row("entry", px(t.entry)),
    row("stop", px(t.stop) + pts, "loss"),
    row("target", px(t.target)
        + (t.planned_rr == null ? "" : `<small>${t.planned_rr.toFixed(2)}R</small>`), "win"),
    row("exit", px(t.exit) + `<small>${esc((t.exit_type || "").toLowerCase())}</small>`),
    row("held", t.held_min == null ? "&mdash;" : t.held_min + " min"),
    row("result", rr(t.got_r) + `<small>${money(t.pnl)}</small>`,
        won(t) ? "win" : "loss"),
  ].join("");
}

function details(t) {
  const FL = window.FLAG_TEXT || {};
  $("dflags").innerHTML = (t.flags || []).map(f =>
    `<span class="flag">${esc(FL[f] || f)}</span>`).join("");
  $("dnote").textContent = t.note || "";

  const steps = t.trail || [];
  // The panel block already carries the heading; adding another printed
  // "Stop moves" twice, one under the other.
  $("dtrail").innerHTML = !steps.length ? "" :
    steps.map(s =>
      `<div class="tstep"><span class="tt">${esc(s.t)}</span>`
      + `<span class="tp">${px(s.sl)}</span>`
      + `<span class="tk">${esc(s.kind || "")}</span>`
      + `<span class="tf">${s.fav_r == null ? "" : s.fav_r.toFixed(2) + "R run"}</span>`
      + "</div>").join("");
}

/* --------------------------------------------------------------- render */

export function pick(i) {
  S.list = matching();
  S.i = Math.max(0, Math.min(i, S.list.length - 1));
  counts();

  if (!S.list.length) {
    $("dtabs").innerHTML = "";
    $("dhead").innerHTML = '<span class="who">No trades in this view</span>';
    $("dvalues").innerHTML = "";
    $("dflags").innerHTML = "";
    $("dnote").textContent = "";
    $("dtrail").innerHTML = "";
    if (window.showMyNote) window.showMyNote(null);
    if (chart) chart.setData([]).setTrade(null);
    $("dprev").disabled = $("dnext").disabled = true;
    return;
  }

  const t = S.list[S.i];
  strip();
  $("dhead").innerHTML =
    `<span class="who">${esc(t.symbol)} ${esc(t.side)} &times;${t.qty}</span>`
    + `<span class="when">${C.day(C.msOf(t.open_t))} &nbsp; `
    + `${C.hhmm(C.msOf(t.open_t))} &rarr; ${C.hhmm(C.msOf(t.close_t))}`
    + `<i>${C.zoneName(C.msOf(t.open_t))}</i></span>`
    + `<span class="res ${won(t) ? "win" : "loss"}">${rr(t.got_r)}`
    + ` &nbsp; ${money(t.pnl)}</span>`;
  values(t);
  details(t);
  // The note box is owned by the shared page script, which knows how to save
  // it. This just tells it which trade is on screen.
  if (window.showMyNote) window.showMyNote(t);

  const bars = barsOf(t);
  $("dprev").disabled = S.i === 0;
  $("dnext").disabled = S.i >= S.list.length - 1;

  if (!chart) return;
  if (!bars.length) {
    chart.setData([]).setTrade(null);
    $("dnobars").hidden = false;
    return;
  }
  $("dnobars").hidden = true;
  chart.setTrade({
    entry: t.entry, stop: t.stop, target: t.target, exit: t.exit,
    pnl: t.pnl, entryIndex: t.entry_i ?? 0,
    exitIndex: t.exit_i ?? bars.length - 1,
  });
  chart.setData(bars);
  chart.fit(bars.length + 4);
}

/** Called by the shared page script when the source picker changes. */
export function setSource(src) {
  S.source = src;
  pick(0);
}

export function init() {
  if (!$("dchart")) return;
  chart = createChart($("dchart"), {
    timeLabel: ms => C.hhmm(ms),
    onHover: b => {
      const box = $("dohlc2");
      if (!box) return;
      if (!b) { box.innerHTML = ""; return; }
      box.innerHTML = '<span class="pohlc">'
        + `<span>O <b>${px(b.o)}</b></span><span>H <b>${px(b.h)}</b></span>`
        + `<span>L <b>${px(b.l)}</b></span>`
        + `<span class="${b.c >= b.o ? "up" : "dn"}">C <b>${px(b.c)}</b></span></span>`;
    },
  });

  $("dtabs").addEventListener("click", e => {
    const b = e.target.closest(".dtab");
    if (b) pick(+b.dataset.i);
  });
  $("dfilter").addEventListener("click", e => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    S.filter = b.dataset.f;
    [...$("dfilter").children].forEach(c =>
      c.setAttribute("aria-pressed", String(c.dataset.f === S.filter)));
    pick(0);
  });
  $("dprev").addEventListener("click", () => pick(S.i - 1));
  $("dnext").addEventListener("click", () => pick(S.i + 1));
  $("dzin2").addEventListener("click", () => chart.zoomIn());
  $("dzout2").addEventListener("click", () => chart.zoomOut());
  $("dfit2").addEventListener("click", () => pick(S.i));

  // Arrow keys walk the trades, which is how you actually review a run.
  addEventListener("keydown", e => {
    const pane = document.querySelector('.tabpane[data-tab="diary"]');
    if (!pane || pane.hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); pick(S.i + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); pick(S.i - 1); }
  });

  pick(0);
}

export const redraw = () => { if (chart) chart.draw(); };
export const current = () => S.list[S.i] || null;
