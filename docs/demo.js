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
  const risk = Math.abs(p.entry - p.stop);

  const trade = {
    source: "demo",
    symbol: p.symbol, side: p.side, qty: p.qty,
    open_t: p.open_t, close_t: stamp(ms),
    entry: p.entry, exit: Math.round(price * 100) / 100,
    stop: p.stop, target: p.target,
    risk_pts: Math.round(risk * 100) / 100,
    reward_pts: Math.round(Math.abs(p.target - p.entry) * 100) / 100,
    planned_rr: Math.round(Math.abs(p.target - p.entry) / risk * 100) / 100,
    got_r: Math.round(pts / risk * 100) / 100,
    got_pts: Math.round(pts * 100) / 100,
    pnl,
    held_min: Math.max(0, Math.round((ms - p.ms) / 60000)),
    exit_type: how, flags: [], trail: [],
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

function draw() {
  const cv = $("dc");
  if (!cv) return;
  const W = cv.clientWidth, H = Math.max(250, Math.min(400, W * 0.5));
  const dpr = devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d");
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  // Read once per draw. This used to be called per candle and per level, and
  // every call forces the browser to recompute style, which was most of the
  // cost of stepping the chart.
  const _cs = getComputedStyle(document.documentElement);
  const _pal = {};
  const css = n => (_pal[n] !== undefined ? _pal[n]
                    : (_pal[n] = _cs.getPropertyValue(n).trim()));

  const N = Math.max(30, Math.floor(W / 6));
  const view = D.bars.slice(-N);
  if (!view.length) return;

  const L = 8, R = 74, T = 12, B = 22;
  const w = W - L - R, h = H - T - B;
  let lo = Infinity, up = -Infinity;
  for (const b of view) { lo = Math.min(lo, b.l); up = Math.max(up, b.h); }
  const p = D.pos;
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

  if (D.levels) {
    x.font = '10px "JetBrains Mono", monospace';
    x.textBaseline = "middle";
    const atMs = last() ? last().ms : null;
    // The model comes from the five-minute history; whether a level has been
    // tapped TODAY is read off the minute bars on screen.
    const odds = RV.untappedNow(D.bars, atMs, D.model);
    const marks = levelsAt(D.bars, atMs).filter(m => m.price >= lo && m.price <= up);
    for (const m of marks) {
      const o = m.label.includes("High") ? odds.get("above") : odds.get("below");
      if (m.family === "day" && o && Math.abs(o.price - m.price) < 1e-6)
        m.label += "  " + RV.pct(o.p) + " revisit" + (o.thin ? " ?" : "");
    }
    for (const m of marks) {
      const y = Math.round(Y(m.price)) + 0.5;
      x.strokeStyle = x.fillStyle = FAMILY_COLOUR[m.family] || css("--faint");
      x.globalAlpha = 0.5;
      x.setLineDash([2, 4]);
      x.beginPath(); x.moveTo(L, y); x.lineTo(L + w, y); x.stroke();
      x.setLineDash([]);
      x.globalAlpha = 0.85;
      x.fillText(m.label, L + 4, y - 7);
      x.globalAlpha = 1;
    }
  }

  if (p) {
    x.fillStyle = css("--loss-zone");
    x.fillRect(L, Y(Math.max(p.entry, p.stop)), w, Math.abs(Y(p.stop) - Y(p.entry)));
    x.fillStyle = css("--win-zone");
    x.fillRect(L, Y(Math.max(p.entry, p.target)), w, Math.abs(Y(p.target) - Y(p.entry)));
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
    x.strokeStyle = x.fillStyle = css(b.c >= b.o ? "--candle-up" : "--candle-dn");
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(Math.round(cx) + 0.5, Y(b.h));
    x.lineTo(Math.round(cx) + 0.5, Y(b.l));
    x.stroke();
    const bw = Math.max(1.6, cw * 0.6);
    const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
    x.fillRect(cx - bw / 2, y1, bw, Math.max(1, y2 - y1));
  });

  x.font = '11px "JetBrains Mono", monospace';
  x.textBaseline = "middle";
  x.fillStyle = css("--muted");
  for (let g = 0; g <= 4; g++)
    x.fillText(px(up - (up - lo) * g / 4), L + w + 7, T + h * g / 4);
  const b = view[view.length - 1];
  x.fillStyle = css("--accent");
  x.fillText(px(b.c), L + w + 7, Y(b.c));
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
    ? `Risking <b class="loss">${money(-lose)}</b> to make `
      + `<b class="win">${money(win)}</b>, at ${rr.toFixed(1)} times your risk. `
      + `That is <b>${(lose / acct * 100).toFixed(1)}%</b> of the account on `
      + `this one trade.`
      + (rr < 1 ? '<span class="rrwarn">Risking more than you stand to make</span>' : "")
      + (lose / acct > 0.02
          ? '<span class="rrwarn">Over 2% of the account on one trade</span>' : "")
    : "";
}

function render() {
  const b = last();
  const d = delayMin();
  $("dread").innerHTML = b
    ? `<span class="rv"><b>${D.sym}</b></span>`
      + `<span class="rv">last <b>${px(b.c)}</b></span>`
      + `<span class="rv ${d > 90 ? "loss" : ""}">${ageWords(d)}</span>`
      + `<span class="rv">${stamp(b.ms).slice(0, 16)}</span>`
    : '<span class="rv">Loading the market...</span>';

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

  ticket();
  draw();
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
  render();
}

export function init(onSaveToDiary, onTradeClosed) {
  loadAccount();
  onClosed = onTradeClosed || (() => {});

  $("dsym").innerHTML = SYMS.map(s => `<option value="${s}">${s}</option>`).join("");
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
    draw();
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

  addEventListener("resize", () => {
    const pane = document.querySelector('.tabpane[data-tab="demo"]');
    if (pane && !pane.hidden) draw();
  });

  render();
  refresh();
  // The site republishes bars through the session, so a tab left open picks
  // them up without being reloaded.
  setInterval(refresh, 5 * 60000);
}

export const redraw = () => { if (D.bars.length) draw(); };
export const inTrade = () => !!D.pos;
