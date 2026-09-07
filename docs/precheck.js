/* The short list, before the entry rather than after it.
 *
 * Everything else here reports on trades you have already taken, which is
 * useful and always too late. This is the same knowledge asked at the only
 * moment it can change anything.
 *
 * What is on the list is decided by the record, not by what sounds sensible.
 * Trailing the stop early is NOT on it: replaying the eleven flagged trades
 * with the stop left alone came out at six dollars a trade inside a seven
 * hundred dollar swing, so telling you to stop doing it would be advice this
 * app has already disproved. What is on it either costs real money in the
 * record or is arithmetic that does not need a record to be true.
 *
 * Two levels, because a list where everything shouts is a list nobody reads:
 *
 *   "hold" is worth a second press. Three of these have already cost real
 *   money in this account.
 *
 *   "note" is worth knowing and not worth blocking.
 */
import {RELEASE_SLOTS} from "./engine.js";
import * as C from "./clock.js";

export const OPEN = 9 * 60 + 30;
export const CLOSE = 16 * 60;
const NEWS_MIN = 3;          // how close to a slot is close enough to matter
const RISK_WARN = 0.01;      // a percent of the account
const RISK_HOLD = 0.02;

/** Minutes to the next scheduled release slot, or null when none is near. */
export function toRelease(ms, within = NEWS_MIN) {
  const now = C.minutes(ms);
  for (const [slot, what] of Object.entries(RELEASE_SLOTS)) {
    const at = (+slot.slice(0, 2)) * 60 + (+slot.slice(3));
    const gap = at - now;
    if (gap >= 0 && gap <= within) return {slot, what, gap};
  }
  return null;
}

/**
 * Everything worth saying before this entry.
 *
 * @param ctx.ms       the bar being traded on
 * @param ctx.risk     what the stop costs, in money
 * @param ctx.reward   what the target pays, in money
 * @param ctx.balance  the account it is a share of, or null
 * @param ctx.today    trades already closed on this session's date
 * @returns [{level, text}], worst first
 */
export function check(ctx) {
  const out = [];
  const {ms, risk, reward, balance, today = []} = ctx;

  // Arithmetic, true whatever the record says.
  if (risk > 0 && reward > 0 && reward < risk)
    out.push({level: "note",
              text: `Risking more than the target pays: $${Math.round(risk)} `
                  + `to make $${Math.round(reward)}.`});

  if (balance && risk > 0) {
    const share = risk / balance;
    if (share >= RISK_HOLD)
      out.push({level: "hold",
                text: `That stop costs ${(share * 100).toFixed(1)}% of the `
                    + `account. Two percent is where a normal run of losses `
                    + `starts doing damage you have to trade your way out of.`});
    else if (share >= RISK_WARN)
      out.push({level: "note",
                text: `That stop costs ${(share * 100).toFixed(1)}% of the `
                    + `account.`});
  }

  if (ms != null) {
    // The one that has already cost real money here: a stop taken 28 seconds
    // before 08:30, on a trade that would otherwise have reached its target.
    const rel = toRelease(ms);
    if (rel)
      out.push({level: "hold",
                text: `${rel.gap === 0 ? "It is" : rel.gap + " minutes to"} `
                    + `${rel.slot} New York, ${rel.what}. The minutes before a `
                    + `scheduled release are when the market reaches for `
                    + `resting stops.`});

    const mins = C.minutes(ms);
    if (mins < OPEN) {
      // Said the way a person would say it. "550 minutes early" is correct
      // and is not how anybody thinks about nine hours.
      const gap = OPEN - mins;
      const how = gap < 90 ? `${gap} minutes`
        : `${Math.round(gap / 60)} hours`;
      out.push({level: "note",
                text: `The cash session has not opened yet, by ${how}.`});
    }
    else if (mins >= CLOSE)
      out.push({level: "note", text: "The cash session has closed."});
  }

  // A run of losses is the shape of every account that has ever been blown.
  const losses = today.filter(t => t.pnl < 0).length;
  if (losses >= 3)
    out.push({level: "hold",
              text: `That is ${losses} losses already today. Your worst `
                  + `stretch in this record was three in a row.`});
  else if (losses === 2)
    out.push({level: "note", text: "Two losses already today."});

  const order = {hold: 0, note: 1};
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** Whether anything on the list is worth a second press. */
export const holds = list => list.some(x => x.level === "hold");

/** The sentence a confirm box should ask. */
export function ask(list) {
  const held = list.filter(x => x.level === "hold");
  return held.map(x => x.text).join("\n\n")
       + "\n\nTake the trade anyway?";
}
