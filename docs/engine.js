/* The journal engine, running in the browser.
 *
 * This is a faithful port of the Python one, kept deliberately close to it so
 * a fix in one is easy to make in the other. The rules it enforces are the
 * ones that were learned the hard way:
 *
 *   R is the risk taken AT ENTRY, never the trailed stop. Dividing a small
 *   loss by a tiny remaining risk once produced -22R on a single trade and
 *   -3.8R of expectancy on a day that made money.
 *
 *   The activity log is written newest-first, so it has to be sorted before
 *   the "first" stop of a trade means the first one.
 *
 *   TradingView caps the activity-log export. A trade outside what the log
 *   covers has no recorded entry stop, and the honest answer is that it has
 *   no R, not a number measured against the wrong stop.
 *
 *   Adding to a position is not an exit. Fills do not alternate.
 *
 * Nothing here talks to a server. Your exports are read in the browser and
 * stay in it.
 */

export const POINT = {NQ: 20, MNQ: 2, ES: 50, MES: 5,
                      YM: 5, MYM: 0.5, RTY: 50, M2K: 5};
export const TICKER = {
  "CME_MINI:NQ1!": "NQ", "CME_MINI:ES1!": "ES", "CBOT_MINI:YM1!": "YM",
  "CME_MINI:RTY1!": "RTY", "CME_MINI:MNQ1!": "MNQ", "CME_MINI:MES1!": "MES",
  "CME_MINI:M2K1!": "M2K", "CBOT_MINI:MYM1!": "MYM",
};
export const FEED = {NQ: "NQ", MNQ: "NQ", ES: "ES", MES: "ES",
                     YM: "YM", MYM: "YM", RTY: "RTY", M2K: "RTY"};

// Exports are stamped in the trader's own local time. Everything derived from
// them (the New York clock, the candle lookup) needs to know which one.
export const BREAKEVEN_AT_R = 2.0;
export const PAD_BEFORE = 10, PAD_AFTER = 30;

const contract = raw => TICKER[raw] || String(raw).split(":").pop().replace("1!", "");

/* ---------------------------------------------------------------- CSV */

/** A CSV parser that survives quoted commas, which every one of these files has. */
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length > 1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}

const num = v => {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------- ingest */

/** Every filled order across every export, de-duplicated by order ID. */
export function readExports(files) {
  const seen = new Set(), fills = [];
  for (const f of files.filter(f => /order-history/i.test(f.name))) {
    for (const r of parseCSV(f.text)) {
      if ((r["Status"] || "").toLowerCase() !== "filled") continue;
      const oid = (r["Order ID"] || "").trim();
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      fills.push(r);
    }
  }
  fills.sort((a, b) => (a["Closing time"] < b["Closing time"] ? -1 : 1));
  return fills;
}

/** One number, or nothing.
 *
 *  A position held in several legs logs every leg's stop on one line:
 *  "with SL 53705, 53643, 53705, 53705 and TP ...". There is no single stop
 *  there, so there is nothing to read. Stripping the commas first turns that
 *  list into whichever number happens to come first, which is a guess wearing
 *  a number's clothes. */
const one = v => {
  const s = String(v ?? "").trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
};

/** Stop and target changes. The only record that a stop was ever moved. */
export function readStopMoves(files) {
  const moves = [];
  for (const f of files.filter(f => /activity-log/i.test(f.name))) {
    for (const r of parseCSV(f.text)) {
      const txt = r["Text"] || "";
      if (!txt.includes("Modify position") || !txt.includes("SL")) continue;
      const sl = one((txt.split("SL")[1] || "").split("and")[0]);
      if (sl === null) continue;
      let tp = null;
      if (txt.includes("TP")) tp = one(txt.split("TP")[1]);
      const raw = Object.keys(TICKER).find(k => txt.includes(k));
      moves.push({t: r["Time"], symbol: raw ? TICKER[raw] : null, sl, tp});
    }
  }
  // TradingView writes this file newest-first. Left in file order the "first"
  // stop of a trade is the last one you trailed to, which is the whole point.
  moves.sort((a, b) => (a.t < b.t ? -1 : 1));
  return moves;
}

/** The stretches of time the activity logs actually cover. */
export function logCoverage(files) {
  const spans = [];
  for (const f of files.filter(f => /activity-log/i.test(f.name))) {
    const stamps = parseCSV(f.text).map(r => r["Time"]).filter(Boolean);
    if (stamps.length) spans.push([stamps.reduce((a, b) => a < b ? a : b),
                                   stamps.reduce((a, b) => a > b ? a : b)]);
  }
  return spans;
}

export const covered = (spans, open_t, close_t) =>
  spans.some(([lo, hi]) => lo <= open_t && close_t <= hi);

/** The balance before the first trade, so the curve shows the account. */
export function readStartBalance(files) {
  const rows = [];
  for (const f of files.filter(f => /balance-history/i.test(f.name)))
    rows.push(...parseCSV(f.text));
  if (!rows.length) return null;
  rows.sort((a, b) => ((a["Time"] || "") < (b["Time"] || "") ? -1 : 1));
  return num(rows[0]["Balance before"]);
}

/** The broker's own round trips. Here to be disagreed with, not trusted. */
export function readBrokerTrades(files) {
  const out = new Map();
  for (const f of files.filter(f => /trade-history/i.test(f.name))) {
    for (const r of parseCSV(f.text)) {
      const sym = contract(r["Symbol"] || "");
      const kind = (r["Type"] || "").toLowerCase();
      const n = parseInt(r["Trade number"], 10);
      const px = num(r["Price"]), pnl = num(r["Net PnL USD"]);
      if (!Number.isFinite(n) || px === null || pnl === null) continue;
      const key = sym + "#" + n;
      if (!out.has(key)) out.set(key, {symbol: sym, n, pnl, qty: num(r["Size (qty)"])});
      const t = out.get(key);
      if (kind.startsWith("entry")) {
        t.side = kind.endsWith("long") ? "Long" : "Short";
        t.entry = px;
      } else if (kind.startsWith("exit")) t.exit = px;
    }
  }
  return [...out.values()].filter(t => t.entry != null && t.exit != null);
}

/** Compare what the fills say to what the broker says. Report the gaps. */
export function reconcile(mine, broker) {
  if (!broker.length) return [];
  const problems = [];
  const symbols = [...new Set(broker.map(b => b.symbol))].sort();
  for (const sym of symbols) {
    const theirs = broker.filter(b => b.symbol === sym).sort((a, b) => a.n - b.n);
    const ours = mine.filter(t => t.symbol === sym)
                     .sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
    if (theirs.length !== ours.length) {
      problems.push(`${sym}: the broker lists ${theirs.length} round trips, `
                  + `the fills fold into ${ours.length}`);
      continue;
    }
    theirs.forEach((b, i) => {
      const o = ours[i];
      if (Math.abs(b.pnl - o.pnl) > 0.5)
        problems.push(`${sym} trade ${b.n}: broker $${b.pnl.toFixed(2)}, `
                    + `fills $${o.pnl.toFixed(2)}`);
      else if (Math.abs(b.entry - o.entry) > 0.26)
        problems.push(`${sym} trade ${b.n}: broker entry ${b.entry}, `
                    + `fills ${o.entry}`);
    });
  }
  return problems;
}

/* -------------------------------------------------------------- pairing */

/** Fold executions into round trips. Fills do not alternate; adding is not
 *  exiting, a partial close leaves the rest running, and a fill big enough to
 *  go through flat opens the other way. */
export function pairTrades(fills) {
  const open = new Map(), trades = [];

  const close = (sym, o, px, t, r, qty) => {
    const pts = o.side === "sell" ? o.px - px : px - o.px;
    const pv = POINT[sym] ?? 1;
    trades.push({
      symbol: sym, side: o.side === "sell" ? "Short" : "Long", qty,
      open_t: o.t, entry: Math.round(o.px * 1e4) / 1e4,
      close_t: t, exit: px, pnl: Math.round(pts * pv * qty * 100) / 100,
      exit_type: r["Type"] || "",
      exit_stop_px: num(r["Stop price"]),
      exit_limit_px: num(r["Limit price"]),
    });
  };

  for (const r of fills) {
    const sym = contract(r["Symbol"] || "");
    const side = (r["Side"] || "").trim().toLowerCase();
    const px = num(r["Fill price"]), qty = num(r["Quantity"]);
    const t = r["Closing time"];
    if (px === null || qty === null) continue;
    const o = open.get(sym);

    if (!o) { open.set(sym, {side, px, qty, t}); continue; }

    if (side === o.side) {           // scaling in: size-weighted average entry
      const total = o.qty + qty;
      o.px = (o.px * o.qty + px * qty) / total;
      o.qty = total;
      continue;
    }

    const done = Math.min(qty, o.qty);
    close(sym, o, px, t, r, done);
    const left = o.qty - done;
    if (left > 1e-9) { o.qty = left; continue; }
    open.delete(sym);
    const flipped = qty - done;
    if (flipped > 1e-9) open.set(sym, {side, px, qty: flipped, t});
  }
  return {trades, stillOpen: [...open.keys()]};
}

/* ------------------------------------------------------------- analysis */

const f2 = v => v.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});
const sgn = v => (v >= 0 ? "+" : "") + v.toFixed(2);

/** Turn one round trip into facts, flags and a plain-English read. */
export function analyse(t, moves, spans) {
  const {entry, exit: exit_, side} = t;
  const short = side === "Short";

  const rel = moves.filter(m => m.symbol === t.symbol
    && t.open_t <= m.t && m.t <= t.close_t);

  const target = (rel.find(m => m.tp)?.tp) ?? t.exit_limit_px ?? null;
  t.trail = rel.map(m => ({t: m.t.slice(11), sl: m.sl}));

  // R is the risk taken AT ENTRY, so the FIRST stop, never the last. The stop
  // on the exit order is only the entry stop when it was never moved, and that
  // is only knowable when the activity log covers the trade.
  let stop, noLog = false;
  if (rel.length) stop = rel[0].sl;
  else if (!spans || covered(spans, t.open_t, t.close_t)) stop = t.exit_stop_px;
  else { stop = null; noLog = true; }

  t.initial_stop = stop;
  t.final_stop = rel.length ? rel[rel.length - 1].sl : stop;
  t.stop_moved = rel.length > 0 && Math.abs(rel[rel.length - 1].sl - rel[0].sl) > 0.01;

  const flags = [], notes = [];
  const risk = stop ? Math.abs(entry - stop) : null;
  const reward = target ? Math.abs(target - entry) : null;
  const got = short ? entry - exit_ : exit_ - entry;

  t.stop = stop; t.target = target;
  t.risk_pts = risk ? Math.round(risk * 100) / 100 : null;
  t.reward_pts = reward ? Math.round(reward * 100) / 100 : null;
  t.planned_rr = (risk && reward) ? Math.round(reward / risk * 100) / 100 : null;
  t.got_r = risk ? Math.round(got / risk * 100) / 100 : null;
  t.got_pts = Math.round(got * 100) / 100;
  t.held_min = Math.floor((Date.parse(t.close_t.replace(" ", "T"))
                         - Date.parse(t.open_t.replace(" ", "T"))) / 60000);

  // a stop is a market order and takes whatever price is there
  const fired = t.exit_stop_px || t.final_stop;
  if (fired && t.exit_type === "Stop") {
    const slip = short ? exit_ - fired : fired - exit_;
    if (slip > 0.01) {
      flags.push("slipped");
      const cost = t.got_r !== null
        ? `the loss came to ${Math.abs(t.got_r).toFixed(2)}R rather than the 1R you risked`
        : "the loss came out bigger than the one you set";
      notes.push(`The stop sat at ${f2(fired)} and filled at ${f2(exit_)}, `
        + `${f2(slip)} points worse. A stop is a market order: once touched it `
        + `takes whatever price is there, so ${cost}.`);
    }
  }

  if (rel.length > 1) flags.push("trailed");
  if (rel.length && stop) {
    const wrong = rel.filter(m => short ? m.sl < entry : m.sl > entry);
    if (wrong.length && t.got_r !== null && t.got_r < 0) {
      const m = wrong[wrong.length - 1];
      flags.push("stop wrong side");
      notes.push(`At ${m.t.slice(11)} the stop was moved to ${f2(m.sl)}, which is `
        + `on the wrong side of a ${side.toLowerCase()} entry at ${f2(entry)}. For a `
        + `${side.toLowerCase()}, the stop is a ${short ? "buy" : "sell"} order and `
        + `must sit ${short ? "above" : "below"} the market. Placed the other side `
        + `it is already triggered, so it filled immediately. Trailing the stop in `
        + `behind price is the plan, but here price had moved away from the target, `
        + `not toward it, so there was no gain to protect yet.`);
    }
  }

  if (target && reward) {
    const hit = short ? exit_ <= target + 0.01 : exit_ >= target - 0.01;
    const pct = reward ? got / reward * 100 : 0;
    if (hit) {
      flags.push("target hit");
      notes.push(t.planned_rr !== null && t.got_r !== null
        ? `Reached the target. Planned ${t.planned_rr.toFixed(2)}R and took ${sgn(t.got_r)}R.`
        : "Reached the target. No stop is recorded for this trade, so there is "
          + "no R to measure it against.");
    } else if (got > 0 && pct < 70) {
      flags.push("closed early");
      notes.push(`Closed by hand with ${pct.toFixed(0)}% of the planned move: `
        + `${f2(got)} points of the ${f2(reward)} you were aiming at. Banking a `
        + `winner is fine, but a target that far out makes every exit feel premature.`);
    }
  }

  if (t.planned_rr && t.planned_rr >= 3.5) flags.push("target far out");
  if (t.held_min <= 1 && t.got_r !== null && t.got_r < 0) flags.push("stopped fast");

  if (noLog) {
    flags.push("no R");
    notes.unshift("No activity log covers this trade, so the stop you set at entry "
      + "is not on record and there is no R to measure. The money is right; the R is "
      + "simply unknown. Export the activity log on the day you trade and this fills in.");
  } else if (stop === null) {
    flags.push("no R");
    notes.unshift("No stop was set on this trade. R is defined by the risk you take, "
      + "so a trade with no stop has no R at all, and no size that could have been "
      + "worked out in advance.");
  }

  t.flags = flags;
  t.flags_base = [...flags];
  t.note = notes.length ? notes.join(" ")
    : "Nothing mechanical to flag. Entry, stop and exit all behaved as set.";
  t.note_base = t.note;
  return t;
}

const OPENERS = [
  "Nothing mechanical to flag. Entry, stop and exit all behaved as set. ",
  "Nothing mechanical to flag. Entry, stop and exit behaved as set. ",
];

/** Judge the trade against the candles it happened on. */
export function analyseExcursion(t) {
  const bars = t.bars, risk = t.risk_pts;
  if (!bars || !bars.length || !risk) return t;

  // Runs over every stored trade on every import, so it has to be idempotent.
  t.note = t.note_base ?? t.note ?? "";
  t.flags = [...(t.flags_base ?? t.flags ?? [])];
  const short = t.side === "Short";
  const entry = t.entry;
  const ei = t.entry_i ?? 0, xi = t.exit_i ?? bars.length - 1;

  const fav = seq => !seq.length ? 0
    : short ? entry - Math.min(...seq.map(b => b.l))
            : Math.max(...seq.map(b => b.h)) - entry;
  const r2 = v => Math.round(v * 100) / 100;

  const live = bars.slice(ei, xi + 1);
  t.mfe_r = r2(fav(live) / risk);
  t.mae_r = short ? r2((Math.max(...live.map(b => b.h)) - entry) / risk)
                  : r2((entry - Math.min(...live.map(b => b.l))) / risk);
  if (t.mfe_r > 0 && t.got_r !== null && t.got_r !== undefined)
    t.kept_pct = Math.round(Math.max(t.got_r, 0) / t.mfe_r * 100);

  const steps = [];
  for (const m of (t.trail || [])) {
    const j = bars.findIndex(b => b.t === m.t.slice(0, 5));
    if (j < 0 || j < ei) { steps.push({...m, fav_r: null}); continue; }
    const f = r2(fav(bars.slice(ei, j + 1)) / risk);
    const past = short ? m.sl < entry : m.sl > entry;
    const be = Math.abs(m.sl - entry) < 0.01;
    const kind = past ? "wrong side" : (be ? "breakeven" : "tighten");
    steps.push({...m, fav_r: f, kind: steps.length ? kind : "initial"});
  }
  t.trail = steps;

  const early = steps.slice(1).filter(x =>
    x.fav_r !== null && x.fav_r < BREAKEVEN_AT_R && x.kind !== "wrong side");
  if (early.length) {
    t.flags.push("trailed early");
    const x = early[0];
    t.note += ` The stop was tightened at ${x.t} after price had run `
      + `${x.fav_r.toFixed(2)}R in your favour. Your rule holds the stop until about `
      + `${BREAKEVEN_AT_R.toFixed(0)}R, so this came `
      + `${(BREAKEVEN_AT_R - x.fav_r).toFixed(2)}R early.`;
    t.note += t.exit_type === "Stop"
      ? " That tightened stop is what closed the trade, so the early move is what ended it."
      : " It cost nothing here because you closed by hand before the tightened stop was reached.";
  }

  const after = bars.slice(xi + 1);
  if (after.length && t.got_r !== null && t.got_r !== undefined && t.got_r < 0) {
    const ran = r2(fav(after) / risk);
    if (ran >= 1.0) {
      t.flags.push("right, stopped early");
      t.note += ` Price then ran ${ran.toFixed(2)}R past your entry in the direction `
        + `you took, within ${after.length} minutes of being stopped. The read was `
        + `right. A stop ${f2(risk)} points away sat inside the noise, not outside it.`;
    }
  }

  if (after.length && t.target && !t.flags.includes("target hit")) {
    const reach = short ? Math.min(...after.map(b => b.l)) <= t.target
                        : Math.max(...after.map(b => b.h)) >= t.target;
    const best = r2(fav(bars.slice(ei)) / risk);
    if (reach) {
      t.flags.push("cut short");
      t.note += ` Price went on to reach your target within ${after.length} minutes `
        + `of the exit. The trail took ${sgn(t.got_r)}R where the full move was worth `
        + `${t.planned_rr.toFixed(2)}R.`;
    } else if (best - t.mfe_r < 0.05) {
      t.note += ` Price did not improve after the exit over the next `
        + `${after.length} minutes, so leaving early cost nothing here.`;
    }
  }

  flagReleaseWindow(t);

  // The opening line is written before the candles are read, so a trade that
  // looked clean could end up saying "nothing to flag" and then list five things.
  if (t.flags.length > (t.flags_base || []).length) {
    for (const o of OPENERS)
      if (t.note.startsWith(o)) { t.note = t.note.slice(o.length); break; }
  }
  return t;
}

/* ------------------------------------------------- the news-slot check */

// US macro data lands at fixed times, so this needs no calendar and no feed.
// 08:30 New York is the main data slot: payrolls, CPI, PPI, retail sales, and
// jobless claims every Thursday. 10:00 is the second slot, 14:00 is where the
// Fed statement goes. What is scheduled is the SLOT, not any particular number,
// which is exactly what makes this safe to check mechanically.
export const RELEASE_SLOTS = {
  "08:30": "the main US data slot",
  "10:00": "the second US data slot",
  "14:00": "the Fed statement slot",
};

/** A local export stamp as New York wall time, honouring daylight saving. */
export function nyClock(stamp, offsetHours) {
  const ms = Date.parse(stamp.replace(" ", "T") + "Z") - offsetHours * 3600e3;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = k => parseInt(parts.find(p => p.type === k).value, 10);
  return {h: get("hour") % 24, m: get("minute"), s: get("second")};
}

/** Say so when a stop was taken in the last minutes before a release slot.
 *
 *  Not a rule telling you to avoid the news. The observation that the minute
 *  before a scheduled release is when a market reaches for resting stops, and
 *  a stop parked just above the last few highs is the easiest one to reach. */
export function flagReleaseWindow(t, beforeMin = 3, offsetHours = LOCAL_OFFSET_H) {
  const type = (t.exit_type || "").toLowerCase();
  if (type !== "stop" && type !== "stop loss") return t;
  let ny;
  try { ny = nyClock(t.close_t, offsetHours); } catch { return t; }
  const mins = ny.h * 60 + ny.m;
  for (const [slot, what] of Object.entries(RELEASE_SLOTS)) {
    const gap = (+slot.slice(0, 2)) * 60 + (+slot.slice(3)) - mins;
    if (gap >= 0 && gap <= beforeMin && !(gap === 0 && ny.s === 0)) {
      const secs = gap * 60 - ny.s;
      (t.flags = t.flags || []).push("stopped into the news");
      t.note = (t.note || "") + ` That stop was taken ${secs} seconds before `
        + `${slot} New York, ${what}. The minute before a scheduled release is `
        + `when the market reaches for resting stops, and yours was sitting `
        + `where it could reach.`;
      break;
    }
  }
  return t;
}

// Set by the app from the saved setting, so one place decides the clock.
export let LOCAL_OFFSET_H = 2;
export const setLocalOffset = h => { LOCAL_OFFSET_H = h; };

/* -------------------------------------------------------------- candles */

/** Attach the minute bars a trade happened on, from bars published beside
 *  this page. Browsers cannot fetch a market feed directly, so a daily job
 *  publishes them here instead. */
export function attachBars(t, feed, offsetHours = LOCAL_OFFSET_H) {
  if (!feed || !feed.length || t.bars) return false;
  const at = s => Date.parse(s.replace(" ", "T") + "Z") - offsetHours * 3600e3;
  const lo = at(t.open_t) - PAD_BEFORE * 60e3;
  const hi = at(t.close_t) + PAD_AFTER * 60e3;
  const w = feed.filter(b => b.ms >= lo && b.ms <= hi);
  if (!w.length) return false;
  const hhmm = ms => {
    const d = new Date(ms + offsetHours * 3600e3);
    return String(d.getUTCHours()).padStart(2, "0") + ":"
         + String(d.getUTCMinutes()).padStart(2, "0");
  };
  t.bars = w.map(b => ({t: hhmm(b.ms), o: b.o, h: b.h, l: b.l, c: b.c}));
  const oi = t.bars.findIndex(b => b.t === t.open_t.slice(11, 16));
  const xi = t.bars.findIndex(b => b.t === t.close_t.slice(11, 16));
  t.entry_i = oi < 0 ? 0 : oi;
  t.exit_i = xi < 0 ? t.bars.length - 1 : xi;
  return true;
}

/* ------------------------------------------------------------- summary */

export function summarise(trades) {
  const done = trades.filter(t => t.got_r !== null && t.got_r !== undefined);
  const rs = done.map(t => t.got_r);
  const pnl = trades.map(t => t.pnl);
  const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x < 0);
  let streak = 0, worst = 0;
  for (const x of pnl) { streak = x <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  let eq = 0, peak = 0, dd = 0;
  for (const x of pnl) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: pnl.length ? wins.length / pnl.length * 100 : 0,
    pnl: pnl.reduce((s, x) => s + x, 0),
    avg_win: mean(wins),
    avg_loss: mean(losses),
    expectancy_r: rs.length ? mean(rs) : null,
    scored: rs.length,
    worst_streak: worst,
    max_dd: dd,
  };
}

/* ---------------------------------------------------------------- import */

/** The whole pipeline, from six dropped files to a finished record.
 *
 *  Existing trades are kept and matched on symbol plus open time, so dropping
 *  the same export twice changes nothing and a fresh one only adds. */
export function ingest(files, existing, barsBySymbol, offsetHours) {
  const fills = readExports(files);
  const moves = readStopMoves(files);
  const spans = logCoverage(files);
  const {trades: fresh, stillOpen} = pairTrades(fills);

  const byKey = new Map(existing.map(t => [t.symbol + "|" + t.open_t, t]));
  let added = 0;
  for (const t of fresh) {
    const k = t.symbol + "|" + t.open_t;
    if (byKey.has(k)) continue;
    byKey.set(k, analyse(t, moves, spans));
    added++;
  }

  const all = [...byKey.values()].sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
  /* How many CAN be drawn, not how many were attached just now.
   *
   * attachBars does nothing and returns false when a trade already has its
   * candles, which is right for its own job and wrong to count. Every
   * re-import therefore reported every healthy trade as undrawable: import
   * the same session twice and it said "16 could not be drawn: the published
   * bars only reach back about ten days" about sixteen trades that all had
   * their charts. Chris imports on top of what is already there every
   * session, so that false alarm was the normal case. */
  let withBars = 0;
  for (const t of all) {
    attachBars(t, barsBySymbol[FEED[t.symbol]], offsetHours);
    analyseExcursion(t);
    if (t.bars && t.bars.length) withBars++;
  }

  const broker = readBrokerTrades(files);
  const gaps = reconcile(all, broker);
  const start = readStartBalance(files);

  return {trades: all, added, stillOpen, gaps, brokerCount: broker.length,
          startBalance: start, withBars, files: files.length};
}

/**
 * What makes a trade the same trade, for the purpose of not storing it twice.
 *
 * An id when the trade carries one. Demo and practice trades stamp
 * themselves, because two of them can honestly share an open time: the open
 * time is the BAR's, and one bar stays the latest for about half an hour. So
 * close one, open another, and on the old key the second was dropped on the
 * way to the Diary as a duplicate of the first. A winning short went that way
 * while the screen said three trades had been sent and four existed.
 *
 * Imported trades have no id and keep the older key of source, symbol and
 * open time. That is what stops re-importing a session doubling it up, and a
 * real broker fill genuinely is identified by those three.
 */
export const tradeKey = (t, source) =>
  t.id || ((t.source || source) + "|" + t.symbol + "|" + t.open_t);
