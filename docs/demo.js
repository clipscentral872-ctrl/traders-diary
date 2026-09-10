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
import * as C from "./clock.js";
import {levelsAt, FAMILY_COLOUR} from "./levels.js";
import {createChart} from "./chart.js";
import * as WL from "./watchlist.js";
import * as SER from "./series.js";
import * as RV from "./revisit.js";
import * as DRAW from "./draw.js";
import * as P from "./profile.js";
import * as PC from "./precheck.js";

const $ = id => document.getElementById(id);
// The demo account lives under whichever journal is open.
const SYMS = ["NQ", "ES", "YM", "RTY"];
const START_BALANCE = 100000;

const D = {
  sym: "NQ", tf: "5m", bars: [], pos: null, levels: true,
  model: null, modelKey: null,
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
    const o = JSON.parse(P.get("demo"));
    if (o && typeof o.balance === "number") {
      // Anything in the list that is not a trade is dropped rather than
      // trusted. A half-written or older-format entry here throws while the
      // module is still starting, which takes the whole app down with it and
      // leaves no screen to fix it from.
      const ok = t => t && typeof t.got_r === "number"
        && typeof t.pnl === "number";
      D.account = {balance: o.balance,
                   trades: (o.trades || []).filter(ok)};
      D.pos = o.pos && typeof o.pos.entry === "number" ? o.pos : null;
    }
  } catch { /* a fresh account is the right fallback */ }
}
function saveAccount() {
  try {
    P.set("demo", JSON.stringify(
      {balance: D.account.balance, trades: D.account.trades, pos: D.pos}));
  } catch { /* storage full or blocked; the screen is still right */ }
}

/* ---------------------------------------------------------------- data */

const last = () => D.bars.length ? D.bars[D.bars.length - 1] : null;

/** The freshest price the app holds, which is not the bar on the chart.
 *
 *  A five minute chart's last bar is still forming. It is stamped 12:55 and
 *  its close is the price at 12:59, and the minute bars for 12:56 to 12:59
 *  sit inside it. Opening a trade on that bar and then recording 12:55 as
 *  the moment last seen made settle() walk those four minutes as if they
 *  were news, and close the trade on them: a long opened and stopped out in
 *  the same click, at -1.96R, on four minutes that had already happened.
 *  Worse on an hourly chart, where up to sixty minutes are replayed.
 *
 *  So the entry, its moment, and the price on the buttons all come from
 *  here, and a position can only ever be resolved by bars that arrive after
 *  it was opened. */
const tip = () => entryBar(D.bars, D.fine);

/** How old the price on screen is, in minutes. */
const delayMin = () => {
  const b = tip();
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

const loadSymbol = (sym, tf) => SER.load(sym, tf || D.tf);

/* --------------------------------------------------------------- fills */

const fillPrice = (b, level, worseIsBelow) =>
  worseIsBelow ? (b.o < level ? b.o : level) : (b.o > level ? b.o : level);

/** Which bar a trade opens on: the freshest one held, whatever the chart shows.
 *
 *  Exported so it can be tested against the pair of series that broke it.
 *
 *  @param chart the bars being drawn, whose last one may still be forming
 *  @param fine  the minute bars fills are resolved on
 */
export function entryBar(chart, fine) {
  const b = chart && chart.length ? chart[chart.length - 1] : null;
  const f = fine && fine.length ? fine[fine.length - 1] : null;
  if (!b) return f;
  if (!f) return b;
  return f.ms > b.ms ? f : b;
}

/** Walk any bars that arrived since the position was opened, in order.
 *
 *  Bars land in batches here rather than one at a time, so this has to check
 *  every bar it has not seen, not just the newest. Skipping to the latest
 *  would miss a stop that was hit and then recovered from, which is exactly
 *  the case that matters.
 *
 *  A bar that touches both the stop and the target closes at the stop. Which
 *  came first inside the minute is not knowable from a bar, and the honest
 *  guess is the one that does not flatter the record.
 *
 *  @returns {seen, hit} where hit is {price, ms, how} or null
 */
export function resolve(p, bars) {
  const long = p.side === "Long";
  let seen = p.seen;
  for (const b of bars) {
    if (b.ms <= seen) continue;
    seen = b.ms;
    const hitStop = long ? b.l <= p.stop : b.h >= p.stop;
    const hitTgt = long ? b.h >= p.target : b.l <= p.target;
    if (hitStop)
      return {seen, hit: {price: fillPrice(b, p.stop, long), ms: b.ms,
                          how: "Stop"}};
    if (hitTgt)
      return {seen, hit: {price: fillPrice(b, p.target, !long), ms: b.ms,
                          how: "Take Profit"}};
  }
  return {seen, hit: null};
}

function settle() {
  const p = D.pos;
  if (!p) return;
  const {seen, hit} = resolve(p, D.fine || D.bars);
  p.seen = seen;
  if (hit) close(hit.price, hit.ms, hit.how);
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
const newId = () => `demo:${Date.now().toString(36)}:${++seq}`;

function close(price, ms, how) {
  const p = D.pos;
  const pts = p.side === "Long" ? price - p.entry : p.entry - price;
  const pv = E.POINT[p.symbol] ?? 1;
  const pnl = Math.round(pts * pv * p.qty * 100) / 100;
  const risk = p.risk0 ?? Math.abs(p.entry - p.stop);

  const trade = {
    id: newId(),
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

/* What the two orders are worth, for the labels on their lines.
 *
 * The chart draws them; it does not know what a point of NQ is worth, and it
 * should not. This is worked out fresh on every repaint so the numbers move
 * with the line while it is being dragged. */
function withWorth(p) {
  if (!p) return null;
  const pv = E.POINT[p.symbol] ?? 1;
  return {...p,
    stopMoney: money(-Math.abs(p.entry - p.stop) * pv * p.qty),
    targetMoney: money(Math.abs(p.target - p.entry) * pv * p.qty)};
}

function paint() {
  if (!chart) return;
  chart.setLevels(overlayLevels());
  chart.setPosition(withWorth(D.pos));
}

function ohlc(b, prev) {
  const box = $("dohlc");
  if (!box) return;
  if (!b) { box.innerHTML = ""; return; }
  const up = b.c >= b.o;
  // The change on the bar before, the way a chart legend shows it.
  const ch = prev ? b.c - prev.c : null;
  box.innerHTML = '<span class="pohlc">'
    + `<span>${C.hhmm(b.ms)}</span>`
    + `<span>O <b>${px(b.o)}</b></span><span>H <b>${px(b.h)}</b></span>`
    + `<span>L <b>${px(b.l)}</b></span>`
    + `<span class="${up ? "up" : "dn"}">C <b>${px(b.c)}</b></span>`
    + (ch == null ? "" : `<span class="${ch >= 0 ? "up" : "dn"}">`
        + `${ch >= 0 ? "+" : ""}${px(ch)} `
        + `(${ch >= 0 ? "+" : ""}${(ch / prev.c * 100).toFixed(2)}%)</span>`)
    + '</span>';
}

/* -------------------------------------------------------------- render */

function ticket() {
  const b = tip();
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
    : "";
  precheck();
}

/** What the list needs to know: the bar, the money, and today so far. */
function context() {
  const b = tip();
  const qty = Math.max(1, +$("dqty").value || 1);
  const risk = Math.max(0.25, +$("drisk").value || 0);
  const rr = Math.max(0.1, +$("drr").value || 0);
  const pv = E.POINT[D.sym] ?? 1;
  const day = b ? C.day(b.ms) : null;
  return {
    ms: b ? b.ms : null,
    // The clock as well as the bar, because here they can disagree: the
    // published price runs behind the market.
    now: Date.now(),
    risk: risk * pv * qty,
    reward: risk * rr * pv * qty,
    balance: D.account.balance,
    today: (D.account.trades || [])
      .filter(t => C.day(C.msOf(t.open_t)) === day),
  };
}

function precheck() {
  const box = $("dpre");
  if (!box) return;
  /* In a trade, only the release slot is still worth saying.
   *
   * Size and session are entry decisions and there is nothing to do about
   * them now. A scheduled release is different: it is the one thing on this
   * list that has already taken money out of this account, on a trade that
   * was open and doing fine until the minute before 08:30. */
  const list = D.pos
    ? PC.check(context()).filter(x => /New York/.test(x.text))
    : PC.check(context());
  box.hidden = !list.length;
  box.innerHTML = list.map(x =>
    `<div class="pcitem ${x.level}">${x.text}</div>`).join("");
}

function render() {
  const b = last();
  const t = tip();
  const d = delayMin();
  $("dread").innerHTML = t
    ? `${C.full(t.ms)} ${C.zoneName(t.ms)} &nbsp; `
      + `<span class="${d > 90 ? "old" : ""}">${ageWords(d)}</span>`
    : "Loading the market...";
  if (t) {
    $("dbuypx").textContent = px(t.c);
    $("dsellpx").textContent = px(t.c);
  }
  if (b) ohlc(b);

  const p = D.pos;
  const stats = [
    ["balance", plain(D.account.balance), ""],
    ["open", p ? `${p.side} ${p.qty} ${p.symbol}` : "flat", ""],
  ];
  if (p && t) {
    const pts = p.side === "Long" ? t.c - p.entry : p.entry - t.c;
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
      + `${C.hhmm(p.ms)}. Stop ${px(p.stop)}, target ${px(p.target)}. `
      + `It settles by itself as new bars arrive.`
    : t ? "Flat. Set your size and stop, then take a side."
        : "Waiting for the market data to load.";

  $("dflat").hidden = !p;
  // Opening on a price from before the weekend is not a demo trade, it is a
  // bet on the gap. Nothing good is learned from it.
  const stale = d != null && d > 240;
  $("dbuy").disabled = $("dsell").disabled = !!p || !t || stale;
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
  const p = D.pos, b = tip();
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
  const p = D.pos, b = tip();
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
  const p = D.pos, b = tip();
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
  const b = tip();
  if (!b || D.pos) return;
  // The short list, before the entry rather than after it.
  const list = PC.check(context());
  if (PC.holds(list) && !confirm(PC.ask(list))) return;
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
    D.bars = await loadSymbol(sym, D.tf);
    // A stop is hit on the market, not on the timeframe you happen to be
    // looking at. Fills are always resolved on the one-minute bars, or a
    // trade could survive on the 4h chart that a 4h low went straight
    // through.
    D.fine = await SER.load(sym, "1m").catch(() => D.bars);
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
    timeLabel: ms => C.label(ms),
    timeParts: ms => ({day: C.day(ms), min: C.minutes(ms)}),
    overlay: c => DRAW.paint(c),
    onPress: (px, py) => DRAW.down(px, py, chart),
    onDrag: (px, py) => DRAW.move(px, py, chart),
    onRelease: moved => { if (DRAW.release(moved)) chart.repaint(); },
    onHover: (b, i, prev) => ohlc(b || last(), b ? prev : null),
    onLevelMove: levelMoved,
    onLevelDrop: which => { recordMove(which); saveAccount(); render(); },
  });
  $("dtf").innerHTML = SER.TIMEFRAMES.map(t =>
    `<button class="ptool tfb" data-tf="${t.key}" `
    + `aria-pressed="${t.key === D.tf}">${t.label}</button>`).join("");
  $("dtf").addEventListener("click", async e => {
    const b = e.target.closest(".tfb");
    if (!b) return;
    D.tf = b.dataset.tf;
    [...$("dtf").children].forEach(c =>
      c.setAttribute("aria-pressed", String(c.dataset.tf === D.tf)));
    await refresh();
    if (chart) chart.fit(160);
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
    DRAW.setSymbol(sym);
    $("dsym").value = sym;
    refresh().then(paintWatch);
  });
  paintWatch();
  $("dsym").addEventListener("change", async () => {
    // Switching contract while in a trade would leave the position orphaned
    // on a chart it does not belong to.
    if (D.pos) { $("dsym").value = D.pos.symbol; return; }
    D.sym = $("dsym").value;
    DRAW.setSymbol(D.sym);
    await refresh();
  });

  $("dbuy").addEventListener("click", () => open_("Long"));
  $("dsell").addEventListener("click", () => open_("Short"));
  $("dflat").addEventListener("click", () => {
    // The freshest bar, the same one the trade was opened on. Taken from the
    // chart's bar instead, a trade opened at 13:34 on the minute series was
    // closed at 13:30 by the still-forming five minute bar: an exit stamped
    // before its own entry, at a price four minutes stale. An hour stale on
    // the hourly chart.
    const b = tip();
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

  /* The same drawing tools as the replay, on the same rail, because a chart
     you cannot mark up is half a chart wherever it is. */
  $("dtools").innerHTML = DRAW.TOOLS.map(t =>
    `<button class="rtool" data-tool="${t.id}" title="${t.name}"`
    + ` aria-pressed="${t.id === "cursor"}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg>`
    + "</button>").join("");
  const litTools = () => {
    const on = DRAW.getTool();
    [...$("dtools").children].forEach(b =>
      b.setAttribute("aria-pressed", String(b.dataset.tool === on)));
    $("dwipe").disabled = !DRAW.count();
  };
  // The rail has to hear about drawings made anywhere, including the ones
  // already saved when a journal opens. Without this the Clear button here
  // stayed greyed out over a chart with a box sitting on it.
  DRAW.setOnChange(litTools);
  $("dtools").addEventListener("click", e => {
    const b = e.target.closest(".rtool");
    if (!b) return;
    DRAW.setTool(b.dataset.tool);
    litTools();
    if (chart) chart.draw();
  });
  $("dwipe").addEventListener("click", () => {
    if (!DRAW.count()) return;
    if (!confirm(`Remove all ${DRAW.count()} drawings on ${D.sym}?`)) return;
    DRAW.clear();
    litTools();
    if (chart) chart.draw();
  });
  addEventListener("keydown", e => {
    const pane = document.querySelector('.tabpane[data-tab="demo"]');
    if (!pane || pane.hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key === "Escape" && DRAW.cancel()) { litTools(); chart.draw(); }
    if ((e.key === "Delete" || e.key === "Backspace") && DRAW.hasSelection()) {
      e.preventDefault();
      DRAW.removeSelected();
      litTools();
      chart.draw();
    }
  });
  litTools();

  render();
  refresh();
  // The site republishes bars through the session, so a tab left open picks
  // them up without being reloaded.
  setInterval(() => { WL.refresh(); refresh().then(paintWatch); }, 5 * 60000);
}

/** Re-read the account for whichever journal is now open. */
export function reload() {
  D.account = {balance: START_BALANCE, trades: []};
  D.pos = null;
  loadAccount();
  render();
}

export const redraw = () => { if (chart) chart.draw(); };
export const inTrade = () => !!D.pos;
