/**
 * The playbook, and whether a trade actually followed it.
 *
 * Chris trades Jdun's A to Z method on two evaluation accounts. The method is
 * small enough to write down: mark the levels, sit out the opening fifteen
 * minutes, wait for a five minute close beyond the range with rising volume,
 * draw the Fibonacci retracement on that candle, enter on the retest into the
 * 0.5 to 0.618 pocket, stop where the trade is wrong, target a level, and take
 * at least 1.5 times what you risked. Two full losses and the day is over.
 *
 * What kills evaluation accounts is not the method. It is the trades that were
 * never in it. So this module takes a finished trade and says which rules it
 * met, which it broke, and what the rule asked for instead.
 *
 * TWO HONEST LIMITS, both deliberate:
 *
 *   1. A fill record cannot see a chart. Whether there was a trend setting
 *      candle, whether the entry was a retest into the pocket, whether a key
 *      level was under it: only Chris knows, so the app ASKS him and keeps the
 *      answer. Nothing here guesses at it.
 *   2. A rule that was followed into a loss is not a fault. Losing trades that
 *      kept every rule are reported as good trades, because they are, and the
 *      only thing that improves a win rate is taking the same setup again.
 */

import * as C from "./clock.js";
import {POINT} from "./engine.js";

/* ------------------------------------------------------------ the plan */

/**
 * The method's own numbers. Times are minutes past midnight in New York,
 * because every one of these rules is about the New York session.
 */
export const PLAN = {
  /* The chart */
  symbols: ["MNQ", "NQ", "MES", "ES"],
  entryTf: "5m",

  /* The session. The first three five minute candles are the danger zone:
     the range is still being built and there is nothing to retest yet. */
  openAt: 9 * 60 + 30,
  dangerUntil: 9 * 60 + 45,
  lastEntry: 15 * 60 + 30,

  /* The risk. KMFA: the daily cap is a tenth of what the account can lose in
     total, and the two loss rule means a full size loss is half of that cap.
     Both fall out of one number, so only the drawdown is worth setting. */
  drawdown: 2000,
  dailyCapPct: 0.10,
  lossesPerDay: 2,
  tradesPerDay: 2,

  /* The trade */
  minRR: 1.5,
  trimAtR: 1.0,

  /* A new trade this soon after a loss is worth a second look. */
  revengeMinutes: 10,
};

export const plan = (over = {}) => ({...PLAN, ...over});

/** The most one trade may lose: half the daily cap, so two of them end the
 *  day exactly on the cap rather than past it. */
export const dailyCap = p => Math.round((p.drawdown || 0) * (p.dailyCapPct || 0));
export const perTrade = p => Math.round(dailyCap(p) / Math.max(1, p.lossesPerDay));

/**
 * What the record cannot answer. Chris ticks these; the trade keeps them.
 *
 * They are written as statements so a tick always means the rule was kept,
 * and so an untouched trade reads as unanswered rather than as a failure.
 */
export const ASKS = [
  {id: "tsc", q: "A five minute close beyond the range, full body, rising volume",
   instead: "Without the trend setting candle there is no trend to join. "
          + "That is a pass, not a smaller position."},
  {id: "pocket", q: "Entry on the retest into the 0.5 to 0.618 pocket",
   instead: "Entering on the break instead of the retest buys the top of the "
          + "move and puts the stop where the retest would have been."},
  {id: "stacked", q: "A key level sat under the pocket",
   instead: "The pocket on its own is one reason. The method waits for the "
          + "pocket and a level in the same place."},
  {id: "htf", q: "The hour chart agreed with the direction",
   instead: "Against the hour, size down or leave it. The bias comes from "
          + "the higher time frame, the entry from the five minute."},
  {id: "planned", q: "It was on the plan before it happened",
   instead: "A trade found after the move started is a chase. The setup "
          + "repeats, so there is nothing to catch up to."},
  {id: "calm", q: "Not tilted, not bored, not getting even",
   instead: "The rule is the circuit breaker, not the mood. Close the "
          + "platform and the day keeps its shape."},
];

/* --------------------------------------------------------------- facts */

const nyMinutes = stamp => {
  try { return C.minutes(C.msOf(stamp)); } catch { return null; }
};

const money = v => Math.round(v * 100) / 100;

/** What one trade put at risk in dollars, when the stop is on record. */
export function riskUsd(t) {
  const pv = POINT[t.symbol] ?? null;
  if (!pv || !t.risk_pts || !t.qty) return null;
  return money(t.risk_pts * pv * t.qty);
}

const hhmm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":"
                + String(m % 60).padStart(2, "0");

/** How many contracts that stop allows, written so one of them reads as one. */
const allows = (cap, t) => {
  const n = Math.floor(cap / (t.risk_pts * (POINT[t.symbol] || 1)));
  return `At ${t.risk_pts} points the stop allows `
       + (n === 0 ? "nothing at all" : n === 1 ? "one contract" : `${n} contracts`);
};

/* ------------------------------------------------------------- the read */

/* A finding is one rule, one verdict.
 *
 *   kept    the record shows the rule was met
 *   broke   the record shows it was not
 *   watch   inside the rule, but the kind of thing that becomes a habit
 *   asked   only Chris can answer, and has not
 */
const F = (id, verdict, rule, what, instead = "") =>
  ({id, verdict, rule, what, instead});

/**
 * Everything the record alone can say about one trade.
 *
 * @param t    a finished trade from the engine
 * @param p    the plan
 * @param ctx  {dayTrades} the day's trades in time order, for the rules that
 *             are about the day rather than the trade
 */
export function readTrade(t, p = PLAN, ctx = {}) {
  const out = [];
  const inMin = nyMinutes(t.open_t);
  const day = (ctx.dayTrades || []).filter(x => x.open_t <= t.open_t);
  const before = day.slice(0, -1);

  /* The danger zone. */
  if (inMin !== null) {
    if (inMin < p.openAt)
      out.push(F("session", "broke", "Trade the New York session",
        `Entered at ${hhmm(inMin)} New York, before the open.`,
        "The levels this method reads are built by the New York session. "
        + "Before 09:30 none of them are in yet."));
    else if (inMin < p.dangerUntil)
      out.push(F("danger", "broke", "No trades in the first fifteen minutes",
        `Entered at ${hhmm(inMin)} New York, inside the opening range.`,
        `The range was still being built until ${hhmm(p.dangerUntil)}. `
        + "The method waits for it to finish, then trades the break and "
        + "retest of it."));
    else if (inMin > p.lastEntry)
      out.push(F("late", "watch", "Keep entries inside the session",
        `Entered at ${hhmm(inMin)} New York, late in the day.`,
        "Volume thins out into the close and the levels get less reliable."));
    else
      out.push(F("danger", "kept", "No trades in the first fifteen minutes",
        `Entered at ${hhmm(inMin)} New York, with the range in.`));
  }

  /* The instrument. */
  if (t.symbol && !p.symbols.includes(t.symbol))
    out.push(F("symbol", "watch", "Trade the index you have studied",
      `${t.symbol} is outside the playbook.`,
      `The method was taught on ${p.symbols.slice(0, 2).join(" and ")}, `
      + "and the levels that matter were drawn there."));

  /* The stop, and what it was worth. */
  const risk = riskUsd(t);
  const cap = perTrade(p);
  if (t.stop == null) {
    out.push(F("stop", "asked", "A hard stop on every trade",
      "No stop order is on record for this trade.",
      "Export the orders panel at the end of the session. Without the stop "
      + "there is no R, and a trade with no R cannot be judged."));
  } else {
    out.push(F("stop", "kept", "A hard stop on every trade",
      `Stop ${t.risk_pts} points away`
      + (risk ? `, ${t.qty} ${t.symbol} at $${risk}.` : ".")));
    if (risk && risk > cap * 1.05)
      out.push(F("size", "broke", "Size to the stop, never past half the cap",
        `$${risk} at risk against a $${cap} full size loss.`,
        allows(cap, t) + `, not ${t.qty}. The stop decides the size.`));
    else if (risk)
      out.push(F("size", "kept", "Size to the stop, never past half the cap",
        `$${risk} at risk, inside the $${cap} full size loss.`));
  }

  /* A stop that moved away from the entry is the one rule with no exception. */
  if (t.stop_moved && t.initial_stop != null && t.final_stop != null) {
    const away = t.side === "Short"
      ? t.final_stop > t.initial_stop : t.final_stop < t.initial_stop;
    if (away)
      out.push(F("widened", "broke", "Never widen a stop",
        `The stop moved from ${t.initial_stop} to ${t.final_stop}, further from entry.`,
        "The stop marks where the trade is wrong. Moving it does not make "
        + "the trade right, it makes the loss bigger than the one that was planned."));
  }

  /* What it actually cost, against what it was supposed to cost. */
  if (t.got_r != null) {
    if (t.got_r < -1.05 && !(t.flags || []).includes("slipped"))
      out.push(F("overrun", "broke", "A loss is one R",
        `This one came to ${Math.abs(t.got_r).toFixed(2)}R.`,
        "Past 1R the stop was moved, lifted or never there. The whole plan "
        + "is built on a loss being a known size."));
    else if (t.got_r > 0 && t.got_r < p.trimAtR)
      out.push(F("early", "watch", `Trim at ${p.trimAtR}R, then let it run`,
        `Closed at ${t.got_r.toFixed(2)}R.`,
        "Winners cut under 1R cannot pay for the losses, which are a full R "
        + "each. The first trim is at 1R and the rest runs to a level."));
    else if (t.got_r >= p.trimAtR)
      out.push(F("hold", "kept", `Trim at ${p.trimAtR}R, then let it run`,
        `Closed at ${t.got_r.toFixed(2)}R.`));
  }

  /* Was there enough on the table to be worth the risk? */
  if (t.planned_rr != null) {
    if (t.planned_rr < p.minRR)
      out.push(F("rr", "watch", `Target at least ${p.minRR}R`,
        `The target was ${t.planned_rr.toFixed(2)}R away.`,
        `Under ${p.minRR}R the win rate has to carry the whole system. `
        + "Target a level that is far enough away to pay for a loss."));
    else
      out.push(F("rr", "kept", `Target at least ${p.minRR}R`,
        `The target was ${t.planned_rr.toFixed(2)}R away.`));
  }

  /* The day's rules, judged at the moment this trade was opened. */
  const losses = before.filter(x => (x.pnl || 0) < 0).length;
  if (losses >= p.lossesPerDay)
    out.push(F("twoloss", "broke", `${p.lossesPerDay} losses and the day is done`,
      `This was opened after ${losses} losing trades on the same day.`,
      "The rule is a circuit breaker. It is there precisely for the setup "
      + "that looks too good to leave."));

  if (before.length >= p.tradesPerDay)
    out.push(F("count", "broke", `At most ${p.tradesPerDay} trades a day`,
      `Trade number ${before.length + 1} of the day.`,
      "One good trade is the target. Past the second the edge is usually "
      + "boredom rather than a setup."));

  const lost = [...before].reverse().find(x => (x.pnl || 0) < 0);
  if (lost) {
    const gap = (Date.parse(t.open_t.replace(" ", "T"))
               - Date.parse(lost.close_t.replace(" ", "T"))) / 60000;
    if (gap >= 0 && gap < p.revengeMinutes)
      out.push(F("revenge", "watch", "Let a loss settle before the next trade",
        `Opened ${Math.round(gap)} minutes after a losing trade closed.`,
        "A trade taken straight out of a loss is usually the loss talking. "
        + "The setup is still there in ten minutes if it is real."));
  }

  /* The cap is hit, not passed: at the cap the day is already over. */
  const spent = before.reduce((s, x) => s + Math.min(0, x.pnl || 0), 0);
  if (dailyCap(p) > 0 && spent <= -dailyCap(p))
    out.push(F("cap", "broke", `Stop at the $${dailyCap(p)} daily cap`,
      `The day was already $${Math.abs(money(spent))} down when this was opened.`,
      "The cap is what keeps one bad day from being the account."));

  return out;
}

/** The ticked answers, as findings, so they read beside the rest. */
export function readAsks(t) {
  const a = t.jdun || {};
  return ASKS.map(ask => {
    const v = a[ask.id];
    return F(ask.id, v === true ? "kept" : v === false ? "broke" : "asked",
      ask.q,
      v === true ? "Yes." : v === false ? "No." : "Not answered yet.",
      v === false ? ask.instead : "");
  });
}

/* ------------------------------------------------------------- the score */

/**
 * One trade, scored on process alone.
 *
 * The P&L is deliberately not in here. A red trade that kept every rule
 * scores full marks, and a green one that broke three does not, because the
 * second kind is what empties an account a month later.
 */
export function score(findings) {
  const judged = findings.filter(f => f.verdict === "kept" || f.verdict === "broke");
  const kept = judged.filter(f => f.verdict === "kept").length;
  return {
    kept, of: judged.length,
    broke: judged.length - kept,
    watch: findings.filter(f => f.verdict === "watch").length,
    asked: findings.filter(f => f.verdict === "asked").length,
    pct: judged.length ? kept / judged.length : null,
  };
}

/** Everything about one trade: the record's findings, the answers, the score. */
export function review(t, p = PLAN, ctx = {}) {
  const findings = [...readTrade(t, p, ctx), ...readAsks(t)];
  const s = score(findings);
  const broke = findings.filter(f => f.verdict === "broke");
  const won = (t.pnl || 0) > 0;

  /* The sentence at the top of the card. */
  let verdict, line;
  if (broke.length === 0 && s.asked === 0) {
    verdict = won ? "good" : "good";
    line = won
      ? "Every rule kept, and it paid."
      : "Every rule kept. This is the losing trade the method expects, and "
      + "the only thing to do with it is take the same setup again.";
  } else if (broke.length === 0) {
    verdict = "open";
    line = `Nothing in the record broke a rule. ${s.asked} question`
         + `${s.asked === 1 ? "" : "s"} about the chart ${s.asked === 1 ? "is" : "are"} `
         + "still unanswered.";
  } else {
    verdict = won ? "lucky" : "broken";
    line = won
      ? `${broke.length} rule${broke.length === 1 ? "" : "s"} broken, and it `
      + "still paid. That is the dangerous kind: the money says yes and the "
      + "process says no, and only one of them repeats."
      : `${broke.length} rule${broke.length === 1 ? "" : "s"} broken.`;
  }
  return {trade: t, findings, score: s, verdict, line};
}

/* ---------------------------------------------------------------- a day */

/** The day as the method would grade it: the scorecard, not the P&L. */
export function reviewDay(dayTrades, p = PLAN) {
  const list = [...dayTrades].sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
  const reviews = list.map(t => review(t, p, {dayTrades: list}));
  const broke = reviews.reduce((s, r) => s + r.score.broke, 0);
  const kept = reviews.reduce((s, r) => s + r.score.kept, 0);
  const pnl = money(list.reduce((s, t) => s + (t.pnl || 0), 0));
  const losses = list.filter(t => (t.pnl || 0) < 0).length;
  const cap = dailyCap(p);

  const notes = [];
  if (list.length > p.tradesPerDay)
    notes.push(`${list.length} trades. The plan is ${p.tradesPerDay} at most.`);
  if (losses > p.lossesPerDay)
    notes.push(`${losses} losing trades. The day should have ended at ${p.lossesPerDay}.`);
  if (pnl < -cap)
    notes.push(`Down $${Math.abs(pnl)} against a $${cap} cap.`);
  if (!broke && pnl < 0)
    notes.push("A red day with the rules kept is a good day. It is the cost "
             + "of doing business, and nothing about it needs fixing.");
  if (!broke && pnl >= 0 && list.length)
    notes.push("Clean day.");

  return {
    date: list.length ? list[0].open_t.slice(0, 10) : null,
    trades: list.length, pnl, losses,
    kept, broke, pct: kept + broke ? kept / (kept + broke) : null,
    notes, reviews,
  };
}

/** Days in order, newest first, from a flat list of trades. */
export function days(trades, p = PLAN) {
  const by = new Map();
  for (const t of trades) {
    const d = String(t.open_t || "").slice(0, 10);
    if (!d) continue;
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(t);
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([, list]) => reviewDay(list, p));
}

/**
 * What keeps going wrong, across everything imported.
 *
 * Ranked by how often, because the point is to find the one habit worth
 * fixing this week rather than a list of everything ever done wrong.
 */
export function habits(trades, p = PLAN) {
  const count = new Map();
  for (const day of days(trades, p))
    for (const r of day.reviews)
      for (const f of r.findings) {
        if (f.verdict !== "broke") continue;
        const got = count.get(f.id)
          || {id: f.id, rule: f.rule, instead: f.instead, n: 0, pnl: 0};
        got.n++;
        got.pnl = money(got.pnl + (r.trade.pnl || 0));
        count.set(f.id, got);
      }
  return [...count.values()].sort((a, b) => b.n - a.n || a.pnl - b.pnl);
}
