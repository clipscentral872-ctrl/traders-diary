/* Bar replay: step a past session forward without seeing what comes next.
 *
 * The one thing that makes this worth doing rather than scrolling a chart is
 * that fills are resolved exactly the way the backtester resolves them. Both
 * levels touched inside one bar counts as the loss, and a bar that opens past
 * your stop fills at the open rather than at the stop. Practice that fills
 * optimistically teaches a strategy that does not exist.
 */
import * as E from "./engine.js";

const $ = id => document.getElementById(id);
const PRACTICE_KEY = "tradersdiary.replay";

export const TF = [["1m", "1 min"], ["5m", "5 min"], ["1h", "1 hour"]];
const SYMS = ["NQ", "ES", "YM", "RTY"];

const series = new Map();       // "NQ_5m" -> [{ms,o,h,l,c}]
const loading = new Map();

async function load(sym, tf) {
  const key = sym + "_" + tf;
  if (series.has(key)) return series.get(key);
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    const r = await fetch(`bars/${key}.json`, {cache: "no-cache"});
    if (!r.ok) throw new Error(`no published bars for ${sym} ${tf}`);
    const j = await r.json();
    const out = [];
    j.bars.forEach((b, i) => {
      if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                       o: b[0], h: b[1], l: b[2], c: b[3]});
    });
    series.set(key, out);
    loading.delete(key);
    return out;
  })();
  loading.set(key, p);
  return p;
}

/* --------------------------------------------------------------- state */

const S = {
  sym: "NQ", tf: "5m", bars: [], i: 0, mode: "browse",
  pos: null, done: [], timer: null,
};

const money = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
const px = v => v.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});

// A replay stamp is shown in the trader's own clock, the same one the diary
// reads exports in, so a session here and a session there line up.
const stamp = ms => {
  const d = new Date(ms + tzHours() * 3600e3);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
};
let tzHours = () => 2;
export const setClock = fn => { tzHours = fn; };

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
    stop: p.stop, target: p.target,
    risk_pts: Math.round(Math.abs(p.entry - p.stop) * 100) / 100,
    reward_pts: Math.round(Math.abs(p.target - p.entry) * 100) / 100,
    planned_rr: Math.round(Math.abs(p.target - p.entry)
                         / Math.abs(p.entry - p.stop) * 100) / 100,
    got_r: Math.round(pts / Math.abs(p.entry - p.stop) * 100) / 100,
    got_pts: Math.round(pts * 100) / 100,
    pnl: Math.round(pts * pv * p.qty * 100) / 100,
    held_min: Math.max(0, Math.round((ms - p.ms) / 60000)),
    exit_type: how, flags: [], trail: [],
    note: "Practice on replayed bars. Not part of your live record.",
    note_base: "Practice on replayed bars. Not part of your live record.",
    flags_base: [],
  });
  S.pos = null;
  saveDraft();
}

/* ---------------------------------------------------------------- draw */

function draw() {
  const cv = $("rc");
  const W = cv.clientWidth, H = Math.max(260, Math.min(430, W * 0.52));
  const dpr = devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d");
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const css = n => getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim();

  const N = Math.max(30, Math.floor(W / 7));
  const hi = Math.min(S.bars.length, S.i + 1);
  const view = S.bars.slice(Math.max(0, hi - N), hi);
  if (!view.length) return;

  const L = 8, R = 74, T = 12, B = 22;
  const w = W - L - R, h = H - T - B;
  let lo = Infinity, up = -Infinity;
  for (const b of view) { lo = Math.min(lo, b.l); up = Math.max(up, b.h); }
  const p = S.pos;
  if (p) { lo = Math.min(lo, p.stop, p.target); up = Math.max(up, p.stop, p.target); }
  const pad = (up - lo) * 0.08 || 1;
  lo -= pad; up += pad;
  const Y = v => T + h - (v - lo) / (up - lo) * h;
  const cw = w / view.length;

  x.strokeStyle = css("--line-soft");
  x.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const yy = Math.round(T + h * g / 4) + 0.5;
    x.beginPath(); x.moveTo(L, yy); x.lineTo(L + w, yy); x.stroke();
  }

  if (p) {
    const long = p.side === "Long";
    x.fillStyle = css("--loss-zone");
    x.fillRect(L, Y(Math.max(p.entry, p.stop)), w,
               Math.abs(Y(p.stop) - Y(p.entry)));
    x.fillStyle = css("--win-zone");
    x.fillRect(L, Y(Math.max(p.entry, p.target)), w,
               Math.abs(Y(p.target) - Y(p.entry)));
    for (const [v, col] of [[p.stop, css("--loss-faded")],
                            [p.target, css("--win-faded")],
                            [p.entry, css("--text")]]) {
      x.strokeStyle = col;
      x.setLineDash(v === p.entry ? [] : [5, 4]);
      x.beginPath(); x.moveTo(L, Y(v) + 0.5); x.lineTo(L + w, Y(v) + 0.5); x.stroke();
    }
    x.setLineDash([]);
  }

  view.forEach((b, k) => {
    const cx = L + cw * (k + 0.5);
    const up_ = b.c >= b.o;
    x.strokeStyle = x.fillStyle = css(up_ ? "--candle-up" : "--candle-dn");
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(Math.round(cx) + 0.5, Y(b.h));
    x.lineTo(Math.round(cx) + 0.5, Y(b.l));
    x.stroke();
    const bw = Math.max(1.6, cw * 0.62);
    const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
    x.fillRect(cx - bw / 2, y1, bw, Math.max(1, y2 - y1));
  });

  x.font = '11px "JetBrains Mono", monospace';
  x.textBaseline = "middle";
  x.fillStyle = css("--muted");
  for (let g = 0; g <= 4; g++) {
    const v = up - (up - lo) * g / 4;
    x.fillText(px(v), L + w + 7, T + h * g / 4);
  }
  const last = view[view.length - 1];
  x.fillStyle = css("--accent");
  x.fillText(px(last.c), L + w + 7, Y(last.c));
  x.fillStyle = css("--faint");
  x.textBaseline = "alphabetic";
  x.fillText(stamp(view[0].ms).slice(0, 16), L, H - 6);
  const endLabel = stamp(last.ms).slice(0, 16);
  x.fillText(endLabel, L + w - x.measureText(endLabel).width, H - 6);
}

/* -------------------------------------------------------------- render */

function render() {
  const b = S.bars[S.i];
  $("rpread").innerHTML = b
    ? `<span class="rv"><b>${S.sym}</b> ${S.tf}</span>`
      + `<span class="rv">${stamp(b.ms).slice(0, 16)}</span>`
      + `<span class="rv">last <b>${px(b.c)}</b></span>`
      + `<span class="rv">${S.mode === "browse"
          ? "browsing: pick where to start"
          : `bar ${S.i + 1} of ${S.bars.length}`}</span>`
    : "";
  $("rpctl").hidden = S.mode !== "replay";

  const p = S.pos;
  $("rposline").textContent = p
    ? `In a ${p.side.toLowerCase()} of ${p.qty} from ${px(p.entry)}. `
      + `Stop ${px(p.stop)}, target ${px(p.target)}.`
    : S.mode === "replay" ? "Flat. Step forward, or take a side."
    : "Pick a date and press Start here.";
  $("rflat").hidden = !p;
  $("rbuy").disabled = $("rsell").disabled = !!p || S.mode !== "replay";

  riskNote();
  results();
  draw();
}

function riskNote() {
  const b = S.bars[S.i];
  const qty = Math.max(1, +$("rqty").value || 1);
  const risk = Math.max(0.25, +$("rrisk").value || 0);
  const rr = Math.max(0.1, +$("rrr").value || 0);
  const pv = E.POINT[S.sym] ?? 1;
  $("rrisknote").innerHTML = b
    ? `Risking <b class="loss">${money(-risk * pv * qty)}</b> to make `
      + `<b class="win">${money(risk * rr * pv * qty)}</b> `
      + `at ${rr.toFixed(1)} times your risk.`
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

/* ------------------------------------------------------------ controls */

function open_(side) {
  const b = S.bars[S.i];
  if (!b || S.pos || S.mode !== "replay") return;
  const qty = Math.max(1, +$("rqty").value || 1);
  const risk = Math.max(0.25, +$("rrisk").value || 0);
  const rr = Math.max(0.1, +$("rrr").value || 0);
  const entry = b.c;
  const long = side === "Long";
  S.pos = {
    side, qty, entry, ms: b.ms, open_t: stamp(b.ms),
    stop: Math.round((long ? entry - risk : entry + risk) * 100) / 100,
    target: Math.round((long ? entry + risk * rr : entry - risk * rr) * 100) / 100,
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

async function start() {
  const d = $("rdate").value;
  if (!d) { $("rposline").textContent = "Pick a date first."; return; }
  const all = await load(S.sym, S.tf).catch(() => null);
  if (!all || !all.length) {
    $("rposline").textContent = "No published bars for that contract yet.";
    return;
  }
  S.bars = all;
  const want = Date.parse(d + "T00:00:00Z") - tzHours() * 3600e3;
  let i = all.findIndex(b => b.ms >= want);
  if (i < 0) i = all.length - 1;
  // Enough history behind the cut to read structure from, which is the whole
  // point of choosing where to start rather than being dropped in cold.
  S.i = Math.max(30, i);
  S.mode = "replay";
  S.pos = null;
  render();
}

function bindOnce() {
  $("rsym").innerHTML = SYMS.map(s =>
    `<option value="${s}">${s}</option>`).join("");
  $("rtf").innerHTML = TF.map(([k, label]) =>
    `<button class="tfb" data-tf="${k}" aria-pressed="${k === S.tf}">${label}</button>`)
    .join("");

  $("rsym").addEventListener("change", () => { S.sym = $("rsym").value; reset(); });
  $("rtf").addEventListener("click", e => {
    const b = e.target.closest(".tfb");
    if (!b) return;
    S.tf = b.dataset.tf;
    [...$("rtf").children].forEach(c =>
      c.setAttribute("aria-pressed", c.dataset.tf === S.tf));
    reset();
  });

  $("rgo").addEventListener("click", start);
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
  for (const id of ["rqty", "rrisk", "rrr"])
    $(id).addEventListener("input", riskNote);

  // A phone has no keyboard, but on a laptop stepping with the arrow keys is
  // the difference between studying a session and clicking three hundred times.
  addEventListener("keydown", e => {
    const pane = document.querySelector('.tabpane[data-tab="replay"]');
    if (!pane || pane.hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 5 : 1); }
  });

  addEventListener("resize", () => {
    const pane = document.querySelector('.tabpane[data-tab="replay"]');
    if (pane && !pane.hidden) draw();
  });

  const today = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  $("rdate").value = today;
  restoreDraft();
}

function reset() {
  stopAuto();
  S.mode = "browse";
  S.pos = null;
  S.bars = [];
  S.i = 0;
  render();
}

/* Practice survives a reload, because a session studied properly takes longer
   than a phone stays awake. */
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
  bindOnce();
  $("rsave").addEventListener("click", () => {
    if (!S.done.length) return;
    const n = onSave(S.done);
    S.done = [];
    saveDraft();
    results();
    $("rposline").textContent = `${n} practice trade${n === 1 ? "" : "s"} sent `
      + `to the Diary. They sit under Replay and stay out of your live figures.`;
  });
  $("rclear").addEventListener("click", () => {
    if (!confirm(`Discard ${S.done.length} practice trades?`)) return;
    S.done = [];
    saveDraft();
    results();
  });
  render();
}

export const redraw = () => { if (S.bars.length) draw(); };
