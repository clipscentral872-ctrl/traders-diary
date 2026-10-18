/**
 * What the record is trying to tell you.
 *
 * The Diary already says what happened on each trade and whether it followed
 * the method. This asks the next question: across everything, what would you
 * change? Chris's own example is the shape of it. If his 20 point stops get
 * hit and the wick only ever runs 30 to 50, the stop is the problem, not the
 * direction, and no single trade can show that. Only the pile can.
 *
 * THREE RULES, because a journal that invents patterns is worse than one
 * that says nothing:
 *
 *   A finding needs a sample. Every lesson states how many trades it is
 *   built on and refuses to speak below a floor. Three trades is an anecdote
 *   and printing it with a percentage beside it is a lie with a number on it.
 *
 *   A comparison needs both sides. "Your shorts lose" means nothing without
 *   what the longs did, so every lesson compares groups from the same record
 *   rather than against some remembered idea of normal.
 *
 *   What needs candles says so. How far price ran past a stop before turning
 *   is only knowable from the bars, and the bars published with this app
 *   reach back about ten days. Where they are missing the lesson reports
 *   that it cannot answer yet instead of guessing.
 */

import * as C from "./clock.js";
import {POINT} from "./engine.js";

/* How few is too few. Under this a lesson says what it would need instead of
   what it thinks. */
const FLOOR = 6;        // per side of a comparison
const TOTAL = 12;       // across the whole lesson

const r1 = v => Math.round(v * 10) / 10;
const pct = v => Math.round(v * 100);
const money = v => (v < 0 ? "-" : "") + "$"
  + Math.abs(Math.round(v)).toLocaleString("en-US");

const live = trades => trades.filter(t => (t.source || "live") === "live");
const scored = trades => trades.filter(t => t.got_r != null);

/** Win rate, expectancy and money for a group, in one place. */
function stats(list) {
  const n = list.length;
  const wins = list.filter(t => (t.pnl || 0) > 0).length;
  /* The MIDDLE R, not the average one. A handful of trades where the stop
     sat two points from the entry produce R figures in the dozens, and one
     of those drags an average into saying a losing group is profitable. */
  const withR = list.filter(t => t.got_r != null)
    .map(t => t.got_r).sort((a, b) => a - b);
  const r = withR.length ? withR[Math.floor(withR.length / 2)] : null;
  return {
    n, wins, losses: n - wins,
    winRate: n ? wins / n : 0,
    r, pnl: list.reduce((s, t) => s + (t.pnl || 0), 0),
  };
}

/** Was this trade ended by its stop? */
const stoppedOut = t =>
  (t.exit_type || "").toLowerCase().includes("stop")
  || (t.got_r != null && t.got_r <= -0.95);

const nyHour = t => {
  try { return Math.floor(C.minutes(C.msOf(t.open_t)) / 60); } catch { return null; }
};

const weekday = t => {
  try { return new Date(t.open_t.slice(0, 10) + "T12:00:00Z").getUTCDay(); }
  catch { return null; }
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
              "Friday", "Saturday"];

/* A lesson is one comparison, with its evidence and what to do about it. */
const L = (id, title, finding, suggestion, evidence, n) =>
  ({id, title, finding, suggestion, evidence, n});

/* ------------------------------------------------------------- the stop */

/**
 * The one Chris asked for: is the stop the thing that is wrong?
 *
 * Trades are grouped by how far the stop sat from the entry, and each group
 * is asked how often it got hit. A tight group that gets hit far more often
 * than a wide one, on the same instrument, is the stop sitting inside the
 * noise rather than outside it.
 */
function stopDistance(all) {
  const list = scored(all).filter(t => t.risk_pts > 0);
  if (list.length < TOTAL)
    return L("stop-distance", "Is your stop too tight?",
      `Not enough trades with a stop on record yet: ${list.length} of the `
      + `${TOTAL} this needs.`,
      "Import the Orders report with your Fills and every trade gets its "
      + "stop, which is what this is measured from.", [], list.length);

  const band = t => t.risk_pts <= 15 ? "15 points or less"
    : t.risk_pts <= 25 ? "16 to 25 points"
    : t.risk_pts <= 40 ? "26 to 40 points" : "over 40 points";
  const groups = new Map();
  for (const t of list) {
    const b = band(t);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(t);
  }
  /* Ordered by distance, never by how often they were hit. Sorting by the
     hit rate and then calling the first row "wide" produced a finding that
     contradicted its own evidence on Chris's real record. */
  const ORDER = ["15 points or less", "16 to 25 points", "26 to 40 points",
                 "over 40 points"];
  const rows = [...groups.entries()]
    .filter(([, g]) => g.length >= FLOOR)
    .map(([name, g]) => ({name, ...stats(g),
                          hit: g.filter(stoppedOut).length / g.length}))
    .sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));

  const evidence = rows.map(r =>
    `${r.name}: stopped out ${pct(r.hit)}% of ${r.n}, `
    + `${pct(r.winRate)}% won, `
    + `${r.r == null ? "" : r1(r.r) + "R in the middle"}`);

  if (rows.length < 2)
    return L("stop-distance", "Is your stop too tight?",
      "Your stops are all about the same distance, so there is nothing to "
      + "compare them against yet.",
      "Vary the stop with the setup rather than using one number, and this "
      + "will have two groups to weigh against each other.", evidence,
      list.length);

  const tight = rows[0], wide = rows[rows.length - 1];
  const gap = tight.hit - wide.hit;

  if (gap >= 0.15)
    return L("stop-distance", "Your stop is sitting inside the noise",
      `Stops of ${tight.name.toLowerCase()} are hit ${pct(tight.hit)}% of the `
      + `time. Stops of ${wide.name.toLowerCase()} are hit ${pct(wide.hit)}%. `
      + `${pct(gap)} percentage points apart on the same method.`,
      "Set the stop where the trade is actually wrong rather than where the "
      + "risk feels comfortable, then size down to pay for it. On MNQ a "
      + "40 point stop at $100 of risk is two contracts, not five.",
      evidence, list.length);

  if (gap <= -0.15)
    return L("stop-distance", "Your wider stops are the ones getting hit",
      `Stops of ${wide.name.toLowerCase()} are hit ${pct(wide.hit)}% of the `
      + `time against ${pct(tight.hit)}% for ${tight.name.toLowerCase()}. `
      + `The tight ones are surviving.`,
      "That is the opposite of a stop problem, and it usually means the "
      + "wider stops are going on the setups you are least sure of. Look at "
      + "what those trades have in common before widening anything.",
      evidence, list.length);

  return L("stop-distance", "Is your stop too tight?",
    "No, as far as this can tell. Your tighter stops are not hit much more "
    + "often than your wider ones.",
    "Leave the stop where the setup puts it. On this record the distance is "
    + "not what is deciding the outcome.", evidence, list.length);
}

/**
 * The same question answered properly, when the candles are there.
 *
 * For every trade that stopped out, how far past the entry did price
 * actually go before it turned? That is the maximum adverse excursion, and
 * it is the only honest answer to "how wide should my stop have been".
 */
function stopFromBars(all) {
  const list = scored(all).filter(t => t.mae_r != null && t.risk_pts > 0);
  const out = list.filter(stoppedOut);
  if (out.length < FLOOR)
    return L("stop-mae", "How far price really ran against you",
      `This needs the candles, and only ${out.length} of your stopped out `
      + `trades have them. The bars published with the app reach back about `
      + `ten days.`,
      "Import each session while it is recent and this fills in. It is the "
      + "one measurement that can size a stop properly.", [], out.length);

  /* How far past the entry price went, in points, on trades that were
     stopped. mae_r is in R, so it scales back by the risk. */
  const runs = out.map(t => ({t, pts: Math.abs(t.mae_r) * t.risk_pts}))
    .sort((a, b) => a.pts - b.pts);
  const at = q => runs[Math.min(runs.length - 1,
    Math.floor(q * (runs.length - 1)))].pts;
  const median = at(0.5), eight = at(0.8);
  const typical = Math.round(median), wide = Math.round(eight);
  const now = Math.round(
    out.reduce((s, t) => s + t.risk_pts, 0) / out.length);

  const evidence = [
    `${out.length} stopped out trades with candles`,
    `half of them ran ${typical} points or less past your entry`,
    `four in five ran ${wide} points or less`,
    `your stop on those trades averaged ${now} points`,
  ];

  if (wide <= now * 1.1)
    return L("stop-mae", "Your stop is where it should be",
      `On the trades that stopped you, price ran ${wide} points past your `
      + `entry at the worst, and your stop sat at ${now}. It is outside the `
      + `noise, not inside it.`,
      "Nothing to change here. A stop that gets hit is not automatically a "
      + "stop that was wrong.", evidence, out.length);

  return L("stop-mae", "A wider stop would have survived most of these",
    `On the trades that stopped you out, price ran a median of ${typical} `
    + `points past your entry and ${wide} points in four cases out of five. `
    + `Your stop on those trades was ${now} points.`,
    `A stop around ${wide + 5} points would have stayed in for most of them. `
    + `It only helps if the size comes down to match: at $100 of risk that `
    + `is ${Math.max(1, Math.floor(100 / ((wide + 5) * 2)))} MNQ, not what `
    + `you were trading.`,
    evidence, out.length);
}

/* -------------------------------------------------------- the rest of it */

/** Two groups of the same record, compared honestly. */
function versus(id, title, all, split, names, line) {
  const list = live(all);
  const a = list.filter(split), b = list.filter(t => !split(t));
  if (a.length < FLOOR || b.length < FLOOR)
    return L(id, title,
      `Not enough of both yet: ${a.length} ${names[0]} and ${b.length} `
      + `${names[1]}, and this needs ${FLOOR} of each.`,
      "Keep importing and it will answer.", [], list.length);
  const sa = stats(a), sb = stats(b);
  const evidence = [
    `${names[0]}: ${sa.n} trades, ${pct(sa.winRate)}% won, `
      + `${sa.r == null ? "no R" : r1(sa.r) + "R in the middle"}, `
      + `${money(sa.pnl)} (${money(sa.pnl / sa.n)} a trade)`,
    `${names[1]}: ${sb.n} trades, ${pct(sb.winRate)}% won, `
      + `${sb.r == null ? "no R" : r1(sb.r) + "R in the middle"}, `
      + `${money(sb.pnl)} (${money(sb.pnl / sb.n)} a trade)`,
  ];
  return line(sa, sb, evidence, list.length);
}

function direction(all) {
  return versus("direction", "Long or short", all,
    t => t.side === "Long", ["Long", "Short"],
    (longs, shorts, evidence, n) => {
      /* Win rate AND money. A side can win more often and still be the one
         losing the money, which is exactly what a bigger loser does. */
      const perL = longs.pnl / longs.n, perS = shorts.pnl / shorts.n;
      const gap = longs.winRate - shorts.winRate;
      if (Math.abs(gap) < 0.2 && Math.abs(perL - perS) < 25)
        return L("direction", "Long or short",
          "You trade both sides about as well as each other.",
          "No reason to drop a side. Keep taking whichever the trend "
          + "setting candle gives you.", evidence, n);
      const bad = (perL - perS) !== 0
        ? (perL > perS ? "short" : "long")
        : (gap > 0 ? "short" : "long");
      return L("direction", `Your ${bad}s are the weaker side`,
        `${pct(Math.abs(gap))} percentage points of win rate between them, `
        + `and ${money(Math.abs(perL - perS))} a trade.`,
        `Before the next ${bad}, check the hour chart agrees with it. The `
        + `method says size down or stand aside against the higher time `
        + `frame, and this is what that looks like when it is ignored.`,
        evidence, n);
    });
}

function firstTrade(all) {
  const list = live(all);
  const byDay = new Map();
  for (const t of list) {
    const d = t.open_t.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const first = [], rest = [];
  for (const [, day] of byDay) {
    const sorted = [...day].sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
    const entry = sorted[0].open_t;
    for (const t of sorted) (t.open_t === entry ? first : rest).push(t);
  }
  if (first.length < FLOOR || rest.length < FLOOR)
    return L("first", "Your first trade against the rest",
      `Not enough yet: ${first.length} first trades and ${rest.length} `
      + `after them.`,
      "Keep importing and it will answer.", [], list.length);
  const sf = stats(first), sr = stats(rest);
  const evidence = [
    `First trade of the day: ${sf.n}, ${pct(sf.winRate)}% won, ${money(sf.pnl)}`,
    `Everything after it: ${sr.n}, ${pct(sr.winRate)}% won, ${money(sr.pnl)}`,
  ];
  /* Per trade, not per total. Twenty six trades losing more in total than
     nine is arithmetic, not a finding. */
  const avgF = sf.pnl / sf.n, avgR = sr.pnl / sr.n;
  evidence.push(`per trade: ${money(avgF)} first, ${money(avgR)} after`);
  if (avgR >= avgF - 5)
    return L("first", "Your first trade against the rest",
      `Per trade they are about the same: ${money(avgF)} for the first of `
      + `the day against ${money(avgR)} for the ones after it.`,
      "The two trade rule is still worth keeping, but on this record the "
      + "later trades are not where the money is going.", evidence, list.length);
  return L("first", "The damage is in the trades after the first",
    `Your first trade of the day averages ${money(avgF)}. Every trade after `
    + `it averages ${money(avgR)}.`,
    "This is the two trade rule earning its place. One good setup, then "
    + "close the platform.",
    evidence, list.length);
}

function timeOfDay(all) {
  const list = live(all).filter(t => nyHour(t) !== null);
  if (list.length < TOTAL)
    return L("hour", "The hour you trade best",
      `Not enough yet: ${list.length} of ${TOTAL}.`,
      "Keep importing and it will answer.", [], list.length);
  const groups = new Map();
  for (const t of list) {
    const h = nyHour(t);
    const band = h < 9 ? "before the open" : h < 10 ? "09:00 to 10:00"
      : h < 12 ? "10:00 to 12:00" : "after midday";
    if (!groups.has(band)) groups.set(band, []);
    groups.get(band).push(t);
  }
  const rows = [...groups.entries()]
    .filter(([, g]) => g.length >= FLOOR)
    .map(([name, g]) => ({name, ...stats(g)}))
    .sort((a, b) => b.pnl - a.pnl);
  const evidence = rows.map(r =>
    `${r.name}: ${r.n} trades, ${pct(r.winRate)}% won, ${money(r.pnl)}`);
  if (rows.length < 2)
    return L("hour", "The hour you trade best",
      "Your trades are all in one part of the session, so there is nothing "
      + "to compare.", "", evidence, list.length);
  const best = rows[0], worst = rows[rows.length - 1];

  /* Trades before the open are outside the method whatever they made, so
     that is said first and separately. A good month of them is not a reason
     to trade a session the method was not built for. */
  const early = rows.find(r => r.name === "before the open");
  if (early)
    evidence.push("before the open is outside the method whatever it made: "
      + "the levels it reads are built by the New York session");

  if (worst.pnl >= 0)
    return L("hour", "The hour you trade best",
      `Every part of the session you trade is positive, best ${best.name} `
      + `at ${money(best.pnl)}.`,
      early ? "The only one worth cutting is before the open, which is "
            + "outside the method however it went."
            : "Nothing to cut.", evidence, list.length);

  if (worst.name === "before the open")
    return L("hour", "Before the open is costing you",
      `${money(worst.pnl)} across ${worst.n} trades taken before 09:00 New `
      + `York, against ${money(best.pnl)} across ${best.n} ${best.name}.`,
      "The method is built on the New York open and the levels that form "
      + "before it. Trades taken hours earlier are not in it, so this is "
      + "the easiest money on the page to stop losing.",
      evidence, list.length);

  /* Inside the session, a losing window is a question rather than an
     instruction. Telling him to stop trading the hours the method is built
     on, off eighteen trades, would be advice the record cannot support. */
  return L("hour", `Your worst window is ${worst.name}`,
    `${worst.name}: ${money(worst.pnl)} across ${worst.n} trades. `
    + `${best.name}: ${money(best.pnl)} across ${best.n}.`,
    `That is inside the session the method trades, so it is worth asking `
    + `what those trades have in common rather than dropping the window. `
    + `Open the Diary, filter to ${worst.name}, and read the ones that lost.`,
    evidence, list.length);
}

function sizing(all) {
  const list = scored(all).filter(t => t.qty > 0);
  if (list.length < TOTAL)
    return L("size", "Does trading bigger go better?",
      `Not enough yet: ${list.length} of ${TOTAL}.`,
      "Keep importing and it will answer.", [], list.length);
  const med = [...list].map(t => t.qty).sort((a, b) => a - b)[
    Math.floor(list.length / 2)];
  const big = list.filter(t => t.qty > med), small = list.filter(t => t.qty <= med);
  if (big.length < FLOOR || small.length < FLOOR)
    return L("size", "Does trading bigger go better?",
      "You trade about the same size every time, which is what the method "
      + "asks for.",
      "Keep it there. Size comes from the stop and the cap, not from how "
      + "the setup feels.", [], list.length);
  const sb = stats(big), ss = stats(small);
  const evidence = [
    `Over ${med} contracts: ${sb.n} trades, ${pct(sb.winRate)}% won, ${money(sb.pnl)}`,
    `${med} or fewer: ${ss.n} trades, ${pct(ss.winRate)}% won, ${money(ss.pnl)}`,
  ];
  if (sb.winRate >= ss.winRate - 0.05)
    return L("size", "Does trading bigger go better?",
      "Your bigger trades hold up as well as your smaller ones.",
      "The size is not the problem. Keep it inside the daily cap anyway.",
      evidence, list.length);
  return L("size", "Your bigger trades are your worse trades",
    `Over ${med} contracts you win ${pct(sb.winRate)}% and the group is `
    + `${money(sb.pnl)}. At ${med} or fewer you win ${pct(ss.winRate)}% for `
    + `${money(ss.pnl)}.`,
    "Size up on the data at the end of a month, never on a setup that looks "
    + "better than the last one. That feeling is what the big ones have in "
    + "common.",
    evidence, list.length);
}

function movedStops(all) {
  return versus("moved", "Moving the stop", all,
    t => !!t.stop_moved, ["Stop moved", "Stop left alone"],
    (moved, left, evidence, n) => {
      if (moved.r == null || left.r == null || moved.r >= left.r - 0.1)
        return L("moved", "Moving the stop",
          "Moving the stop is not costing you anything measurable here.",
          "Trailing to breakeven after 1R is the plan, so this is working "
          + "as intended.", evidence, n);
      return L("moved", "Moving the stop is costing you",
        `Trades where the stop moved come to ${r1(moved.r)}R each. Trades `
        + `where it was left alone come to ${r1(left.r)}R.`,
        "Move it to breakeven once, at 1R, and then leave it. Every move "
        + "after that is a decision made while in the trade, which is the "
        + "worst time to make one.",
        evidence, n);
    });
}

function targets(all) {
  const list = scored(all).filter(t => t.planned_rr != null);
  if (list.length < TOTAL)
    return L("target", "How far you aim",
      `Not enough with a target on record yet: ${list.length} of ${TOTAL}.`,
      "The Orders report carries your limit orders, so importing it fills "
      + "this in.", [], list.length);
  const near = list.filter(t => t.planned_rr < 1.5);
  const far = list.filter(t => t.planned_rr >= 1.5);
  if (near.length < FLOOR || far.length < FLOOR)
    return L("target", "How far you aim",
      far.length >= near.length
        ? "You are aiming for 1.5R or better on nearly everything, which is "
          + "what the method asks."
        : "Nearly all your targets are under 1.5R.",
      far.length >= near.length
        ? "Keep it there."
        : "A target under 1.5R makes the win rate carry the whole system. "
          + "Aim at a level that is far enough away to pay for a loss.",
      [], list.length);
  const sn = stats(near), sf = stats(far);
  const evidence = [
    `Under 1.5R: ${sn.n} trades, ${pct(sn.winRate)}% won, ${money(sn.pnl)}`,
    `1.5R or better: ${sf.n} trades, ${pct(sf.winRate)}% won, ${money(sf.pnl)}`,
  ];
  return L("target", "How far you aim",
    `Targets under 1.5R: ${money(sn.pnl)} across ${sn.n}. At 1.5R or `
    + `better: ${money(sf.pnl)} across ${sf.n}.`,
    sf.pnl >= sn.pnl
      ? "The further targets are paying better, which is the arithmetic the "
        + "method is built on. Keep aiming at a level."
      : "The near targets are doing better here, which usually means the "
        + "far ones are being set past a level rather than at one.",
    evidence, list.length);
}

/* ------------------------------------------------------------ the report */

/**
 * Everything worth saying about the record, most useful first.
 *
 * Lessons that cannot speak yet are kept rather than hidden: knowing what
 * the journal is still waiting for is worth as much as a finding, and it is
 * the honest way to show a record that is only nine sessions old.
 */
export function lessons(trades, plan) {
  void plan;
  const all = live(trades);
  const out = [
    stopFromBars(all),
    stopDistance(all),
    direction(all),
    timeOfDay(all),
    firstTrade(all),
    sizing(all),
    movedStops(all),
    targets(all),
  ];
  const ready = out.filter(l => l.evidence.length);
  const waiting = out.filter(l => !l.evidence.length);
  return {ready, waiting, trades: all.length};
}
