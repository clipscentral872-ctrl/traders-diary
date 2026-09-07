/* What a habit actually costs, tested against the bars rather than guessed.
 *
 * The Diary can see that you moved a stop early and it can see that those
 * trades did worse than your others. Those are not the same thing, and
 * treating them as the same thing is how a journal ends up telling you
 * confidently to fix something that costs nothing. Different trades on
 * different days in different conditions differ for a hundred reasons; the
 * habit is only one of them.
 *
 * The question with an answer is narrower: THIS trade, this entry, this
 * target, this minute, with the stop left where it was set. Everything else
 * held still. That can be replayed against the minute bars and it gives a
 * number rather than a correlation.
 *
 * Two rules keep it honest:
 *
 *   Where a single minute touches both the stop and the target there is no
 *   way to know which came first, so the stop is taken. That is the reading
 *   that cannot flatter the result, and how often it was needed is reported
 *   rather than buried.
 *
 *   A trade that reached neither by the close is reported as unresolved, not
 *   quietly marked a winner at whatever price the bell happened to ring at.
 *   Those are kept out of the headline number, because the headline would
 *   otherwise be an assumption wearing a dollar sign.
 */
import * as C from "./clock.js";
import {POINT} from "./engine.js";

/** Bars from a trade's entry to the close of that New York session. */
function session(bars, fromMs) {
  const out = [];
  for (const b of bars) {
    if (b.ms < fromMs) continue;
    if (C.minutes(b.ms) >= C.RTH_CLOSE) break;
    out.push(b);
  }
  return out;
}

/**
 * Replay one trade with the stop left where it was set at entry.
 *
 * @returns {pnl, r, how, both} or null when it cannot be measured
 */
export function stopHeld(t, bars) {
  const stop = t.initial_stop ?? t.stop;
  const target = t.target;
  if (stop == null || target == null || !bars || !bars.length) return null;
  const from = C.msOf(t.open_t);
  if (from == null) return null;
  const risk = Math.abs(t.entry - stop);
  if (!risk) return null;

  const long = t.side === "Long";
  const pv = POINT[t.symbol] ?? 1;
  const run = session(bars, from);
  if (!run.length) return null;

  const money = px => Math.round((long ? px - t.entry : t.entry - px)
                                 * pv * t.qty * 100) / 100;
  const inR = px => Math.round((long ? px - t.entry : t.entry - px)
                               / risk * 100) / 100;

  let both = 0;
  for (const b of run) {
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTgt = long ? b.h >= target : b.l <= target;
    if (hitStop && hitTgt) both++;
    if (hitStop) return {pnl: money(stop), r: inR(stop), how: "stop", both};
    if (hitTgt) return {pnl: money(target), r: inR(target), how: "target", both};
  }
  const last = run[run.length - 1].c;
  return {pnl: money(last), r: inR(last), how: "unresolved", both};
}

/**
 * The whole picture for a set of trades.
 *
 * @param trades the ones carrying the habit
 * @param barsOf a function from symbol to its minute bars
 */
export function compare(trades, barsOf) {
  const rows = [];
  let unmeasured = 0, ambiguous = 0;
  for (const t of trades) {
    const got = stopHeld(t, barsOf(t.symbol));
    if (!got) { unmeasured++; continue; }
    ambiguous += got.both;
    rows.push({t, got, diff: Math.round((got.pnl - t.pnl) * 100) / 100});
  }

  const resolved = rows.filter(r => r.got.how !== "unresolved");
  const diffs = resolved.map(r => r.diff);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const mean = diffs.length ? sum(diffs) / diffs.length : null;
  // Population spread: this is the whole record, not a sample of it.
  const sd = diffs.length > 1
    ? Math.sqrt(sum(diffs.map(d => (d - mean) ** 2)) / diffs.length) : null;

  return {
    rows, unmeasured, ambiguous,
    resolved: resolved.length,
    asTraded: Math.round(sum(resolved.map(r => r.t.pnl))),
    leftAlone: Math.round(sum(resolved.map(r => r.got.pnl))),
    mean, sd,
    // How far the average sits from zero in its own spread. Under about one,
    // the average is inside the noise and means nothing yet.
    signal: mean != null && sd ? Math.abs(mean) / sd : null,
  };
}

/**
 * What that adds up to, in a sentence, with the hedging the numbers earn.
 *
 * Deliberately refuses to call a difference real when the spread swamps it.
 * Nine trades that swing by hundreds either way cannot show a per-trade edge
 * of tens, and saying otherwise is the whole failure this file exists to
 * avoid.
 */
export function verdict(c) {
  if (!c.resolved)
    return "None of these could be replayed against the bars, so there is "
         + "nothing to say about them yet.";
  const diff = c.leftAlone - c.asTraded;
  const money = Math.abs(Math.round(c.mean));
  if (c.resolved < 5)
    return `Only ${c.resolved} of them resolved before the close, which is too `
         + `few to read anything into. Come back to this with more.`;
  if (c.signal != null && c.signal < 0.5)
    return `No detectable difference. Leaving the stop alone would have been `
         + `${diff >= 0 ? "+" : "-"}$${Math.abs(diff).toLocaleString("en-US")} `
         + `across ${c.resolved} trades, an average of $${money} each against `
         + `a swing of $${Math.round(c.sd).toLocaleString("en-US")} a trade. `
         + `That average is inside the noise: on this evidence the habit is `
         + `costing you nothing.`;
  return `Leaving the stop alone would have been `
       + `${diff >= 0 ? "+" : "-"}$${Math.abs(diff).toLocaleString("en-US")} `
       + `across ${c.resolved} trades, an average of `
       + `${c.mean >= 0 ? "+" : "-"}$${money} each. `
       + `${c.resolved < 30 ? "Still a small number of trades, so treat it as "
                            + "a direction rather than a measurement." : ""}`;
}
