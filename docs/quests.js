/**
 * Levels, XP and missions, earned by following the method.
 *
 * Tradeify's own dashboard has a Rewards Center: a level bar, a gem balance,
 * and daily and weekly missions. Chris wants the journal to feel like that,
 * and it is a good instinct, because the thing a trading journal most needs
 * to make rewarding is the part that has no immediate reward: waiting,
 * sizing down, stopping after two losses, writing the note.
 *
 * So every mission in here pays for PROCESS and none of them pays for money.
 * There is deliberately no mission for a green day, no bonus for a big
 * winner, and nothing that gets easier by taking more risk. A red day where
 * every rule was kept earns full marks. That is Jdun's own scorecard with a
 * number on it, and it is the only version of this that is safe to build:
 * points for profit would pay him to break the rules that keep the account.
 *
 * XP is never stored. It is recomputed from the record every time, so it
 * cannot drift, cannot be inflated by a reload, and goes down if a trade is
 * removed. What you see is what the record actually earns.
 */

import * as C from "./clock.js";
import * as JD from "./jdun.js";

/* ------------------------------------------------------------ the ladder */

/* Levels get further apart as they go, the way they always do, but not so
   far that the next one stops being worth having. */
export const LEVELS = [0, 200, 600, 1300, 2400, 4000, 6200, 9100, 12800,
                       17400, 23000];

export function level(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1]) i++;
  const at = LEVELS[i];
  const next = i + 1 < LEVELS.length ? LEVELS[i + 1] : null;
  return {
    level: i + 1,
    xp,
    into: xp - at,
    need: next === null ? null : next - at,
    toNext: next === null ? 0 : next - xp,
    pct: next === null ? 1 : (xp - at) / (next - at),
    max: next === null,
  };
}

/* ----------------------------------------------------------- the helpers */

const dayOf = t => String(t.open_t || "").slice(0, 10);

/** Monday's date for the week a day belongs to. */
export function weekOf(date) {
  const d = new Date(date + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const nyMinutes = stamp => {
  try { return C.minutes(C.msOf(stamp)); } catch { return null; }
};

/** The distinct entries in a list, so a trade trimmed in two counts once. */
const entries = list => new Set(list.map(t => t.open_t + "|" + t.symbol)).size;

/* ---------------------------------------------------------- the missions */

/**
 * Each mission answers one question about a day or a week of trading, and
 * returns {done, note} where note is what is still missing.
 *
 * `xp` is the reward. `gems` is the same idea in a second currency, kept
 * because a number that only ever goes up is worth having beside one that
 * resets.
 */
export const MISSIONS = [
  {
    id: "danger", scope: "day", xp: 40, gems: 10,
    title: "Let the range finish",
    what: "No entry before 09:45 New York.",
    test(day, p) {
      const early = day.filter(t => {
        const m = nyMinutes(t.open_t);
        return m !== null && m < p.dangerUntil;
      });
      return {done: !early.length, note: early.length
        ? `${early.length} entr${early.length === 1 ? "y" : "ies"} in the danger zone`
        : ""};
    },
  },
  {
    id: "stops", scope: "day", xp: 40, gems: 10,
    title: "A stop on every trade",
    what: "Every trade of the day has a stop on record.",
    test(day) {
      const without = day.filter(t => t.stop == null).length;
      return {done: !without, note: without
        ? `${without} trade${without === 1 ? "" : "s"} with no stop on record` : ""};
    },
  },
  {
    id: "size", scope: "day", xp: 50, gems: 15,
    title: "Sized to the stop",
    what: "No trade risked more than half the daily cap.",
    test(day, p) {
      const cap = JD.perTrade(p);
      const over = day.filter(t => {
        const r = JD.riskUsd(t);
        return r != null && r > cap * 1.05;
      }).length;
      return {done: !over, note: over
        ? `${over} trade${over === 1 ? "" : "s"} sized past $${cap}` : ""};
    },
  },
  {
    id: "cap", scope: "day", xp: 60, gems: 20,
    title: "Finished inside the cap",
    what: "The day did not lose more than the daily cap.",
    test(day, p) {
      const cap = JD.dailyCap(p);
      const pnl = day.reduce((n, t) => n + (t.pnl || 0), 0);
      return {done: !(cap > 0 && pnl < -cap),
              note: pnl < -cap ? `down $${Math.round(Math.abs(pnl))} of $${cap}` : ""};
    },
  },
  {
    id: "two", scope: "day", xp: 50, gems: 15,
    title: "Two and done",
    what: "At most two trades, and nothing after two losses.",
    test(day, p) {
      const n = entries(day);
      const losses = entries(day.filter(t => (t.pnl || 0) < 0));
      const ok = n <= p.tradesPerDay && !(losses > p.lossesPerDay);
      return {done: ok, note: ok ? ""
        : `${n} trade${n === 1 ? "" : "s"}, `
          + `${losses} of them ${losses === 1 ? "a loss" : "losses"}`};
    },
  },
  {
    id: "scored", scope: "day", xp: 70, gems: 25,
    title: "Scored the session",
    what: "The six questions answered on every trade of the day.",
    test(day) {
      const left = day.filter(t => {
        const a = t.jdun || {};
        return JD.ASKS.some(q => a[q.id] === undefined);
      }).length;
      return {done: !left, note: left ? `${left} still to answer` : ""};
    },
  },
  {
    id: "note", scope: "day", xp: 30, gems: 10,
    title: "Wrote it down",
    what: "A note of your own on at least one trade.",
    test(day) {
      const n = day.filter(t => (t.mine || "").trim()).length;
      return {done: n > 0, note: n ? "" : "no note yet"};
    },
  },

  {
    id: "week-clean", scope: "week", xp: 300, gems: 100,
    title: "A week inside the cap",
    what: "Every session of the week finished inside the daily cap.",
    test(week, p) {
      const cap = JD.dailyCap(p);
      const days = new Map();
      for (const t of week)
        days.set(dayOf(t), (days.get(dayOf(t)) || 0) + (t.pnl || 0));
      const over = [...days.values()].filter(v => cap > 0 && v < -cap).length;
      return {done: days.size > 0 && !over, note: over
        ? `${over} session${over === 1 ? "" : "s"} past the cap` : ""};
    },
  },
  {
    id: "week-five", scope: "week", xp: 250, gems: 80,
    title: "Five tracked sessions",
    what: "Traded and recorded on five different days this week.",
    test(week) {
      const days = new Set(week.map(dayOf)).size;
      return {done: days >= 5,
              note: days >= 5 ? "" : `${5 - days} more session${5 - days === 1 ? "" : "s"}`};
    },
  },
  {
    id: "week-scored", scope: "week", xp: 350, gems: 120,
    title: "Nothing left unanswered",
    what: "Every trade of the week has its six questions answered.",
    test(week) {
      const left = week.filter(t => {
        const a = t.jdun || {};
        return JD.ASKS.some(q => a[q.id] === undefined);
      }).length;
      return {done: week.length > 0 && !left,
              note: left ? `${left} trade${left === 1 ? "" : "s"} still to score` : ""};
    },
  },
  {
    id: "week-clean-rules", scope: "week", xp: 400, gems: 150,
    title: "A week by the book",
    what: "Not one rule the record can see was broken all week.",
    test(week, p) {
      let broke = 0;
      for (const day of JD.days(week, p)) broke += day.broke;
      return {done: week.length > 0 && !broke,
              note: broke ? `${broke} rule${broke === 1 ? "" : "s"} broken` : ""};
    },
  },
];

/* ------------------------------------------------------------- the board */

const byDay = trades => {
  const m = new Map();
  for (const t of trades) {
    const d = dayOf(t);
    if (!d) continue;
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(t);
  }
  return m;
};

const byWeek = trades => {
  const m = new Map();
  for (const t of trades) {
    const d = dayOf(t);
    if (!d) continue;
    const w = weekOf(d);
    if (!m.has(w)) m.set(w, []);
    m.get(w).push(t);
  }
  return m;
};

/**
 * Everything earned, and where it was earned.
 *
 * Totals are summed over every day and week in the record, which is why they
 * cannot drift: remove a trade and the XP it earned goes with it.
 */
export function board(trades, p = JD.PLAN, today = null) {
  const live = trades.filter(t => (t.source || "live") === "live");
  const days = byDay(live);
  const weeks = byWeek(live);

  let xp = 0, gems = 0, done = 0, possible = 0;
  const perDay = new Map();

  for (const [date, list] of days) {
    const got = [];
    for (const m of MISSIONS) {
      if (m.scope !== "day") continue;
      possible++;
      const r = m.test(list, p);
      if (r.done) { xp += m.xp; gems += m.gems; done++; }
      got.push({...m, ...r});
    }
    perDay.set(date, got);
  }
  const perWeek = new Map();
  for (const [week, list] of weeks) {
    const got = [];
    for (const m of MISSIONS) {
      if (m.scope !== "week") continue;
      possible++;
      const r = m.test(list, p);
      if (r.done) { xp += m.xp; gems += m.gems; done++; }
      got.push({...m, ...r});
    }
    perWeek.set(week, got);
  }

  /* The day on the board is the most recent one traded, unless a day is
     named. Showing an empty today over a record that stops on Friday is how
     a progress screen ends up looking broken on a Sunday. */
  const dates = [...days.keys()].sort();
  const day = today && days.has(today) ? today : dates[dates.length - 1] || null;
  const week = day ? weekOf(day) : null;

  return {
    ...level(xp), gems, done, possible,
    day, week,
    today: day ? perDay.get(day) : [],
    thisWeek: week ? (perWeek.get(week) || []) : [],
    days: perDay, weeks: perWeek,
    streak: streak(days, p),
  };
}

/** Sessions in a row, counted back from the last one, inside the cap. */
function streak(days, p) {
  const cap = JD.dailyCap(p);
  const dates = [...days.keys()].sort();
  let n = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    const pnl = days.get(dates[i]).reduce((s, t) => s + (t.pnl || 0), 0);
    if (cap > 0 && pnl < -cap) break;
    n++;
  }
  return n;
}

/* ------------------------------------------------------- Tradeify's board */

/**
 * Tradeify's own missions, the ones a trading record can answer.
 *
 * Their Rewards Center hands out gems and XP for things it can see in your
 * account data. Clearing one of these here means it is cleared over there,
 * so the diary stops being a separate scoreboard you have to reconcile by
 * hand with theirs.
 *
 * Three of theirs are left out on purpose and none of them for a technical
 * reason. Retweet the League and Brand Boost want a post on X, Rip & React
 * wants a video of your face, and Audition for The Audit wants another one.
 * Chris does not want missions that involve filming himself or posting, so
 * they are not here. The monthly ones are left out because they are decided
 * by a leaderboard of everybody else's XP, which is nothing this record can
 * see or you can do anything about on a given Tuesday.
 *
 * These deliberately do NOT feed the level bar above them. That ladder pays
 * for process and nothing else: waiting out the range, sizing to the stop,
 * stopping after two losses. Two of Tradeify's pay for a green day and a
 * green week, which is paying for the outcome, and a scoreboard that pays
 * for the outcome quietly pays you to take the trade you should not. So
 * they are shown, tracked and totalled on their own, in Tradeify's own
 * currency, beside the ladder rather than inside it.
 */
export const TRADEIFY = [
  {
    id: "tf-game", scope: "day", gems: 20, xp: 500,
    title: "In the Game",
    what: "At least one trade closed today.",
    test(day) {
      const n = entries(day);
      return {done: n > 0, note: n ? "" : "no trade closed yet"};
    },
  },
  {
    id: "tf-scribe", scope: "day", gems: 20, xp: 500,
    title: "Session Scribe",
    what: "A note written for the session.",
    test(day, p, ctx) {
      const ok = wroteOn(dayOf(day[0] || {}), ctx);
      return {done: ok, note: ok ? "" : "nothing written yet"};
    },
  },
  {
    id: "tf-green", scope: "day", gems: 40, xp: 500,
    title: "Green Print",
    what: "The session finished with a positive net.",
    test(day, p, ctx) {
      /* Tradeify credits this for a day that finished green on an account,
         not for the two of them added together. With both accounts on
         screen a green day on one and a redder day on the other summed to
         a loss and said you had not earned something you had. */
      const on = dayOf(day[0] || {});
      const by = new Map();
      for (const t of (ctx.every || day)) {
        if (dayOf(t) !== on) continue;
        const k = t.account || "";
        by.set(k, (by.get(k) || 0) + (t.pnl || 0));
      }
      const best = by.size ? Math.max(...by.values()) : 0;
      return {done: best > 0, note: best > 0 ? ""
        : `finished ${best < 0 ? "-" : ""}$${Math.abs(Math.round(best))}`};
    },
  },

  {
    id: "tf-week-five", scope: "week", gems: 200, xp: 3000,
    title: "Full Traded Week",
    what: "A trade closed on five different days this week.",
    test(week) {
      const n = new Set(week.map(dayOf)).size;
      return {done: n >= 5,
              note: n >= 5 ? "" : `${5 - n} more day${5 - n === 1 ? "" : "s"}`};
    },
  },
  {
    id: "tf-rhythm", scope: "week", gems: 100, xp: 500,
    title: "Journal Rhythm",
    what: "A note written on three different days this week.",
    test(week, p, ctx) {
      const n = [...new Set(week.map(dayOf))].filter(d => wroteOn(d, ctx)).length;
      return {done: n >= 3,
              note: n >= 3 ? "" : `${n} of 3 days written up`};
    },
  },
  {
    id: "tf-clean-week", scope: "week", gems: 100, xp: 1500,
    title: "Clean Week",
    what: "Three days traded and not one of them finished red.",
    test(week, p, ctx) {
      /* Tradeify checks this across every account you hold, not the one you
         happen to be looking at, so this reads the whole record for the same
         week rather than the filtered list it was handed. */
      const on = dayOf(week[0] || {});
      if (!on) return {done: false, note: "nothing traded this week"};
      const mon = weekOf(on);
      const all = (ctx.every || week)
        .filter(t => dayOf(t) && weekOf(dayOf(t)) === mon);
      const sessions = new Map();
      for (const t of all) {
        const k = (t.account || "") + "|" + dayOf(t);
        sessions.set(k, (sessions.get(k) || 0) + (t.pnl || 0));
      }
      const traded = new Set([...sessions.keys()].map(k => k.split("|")[1])).size;
      const red = [...sessions.values()].filter(v => v < 0).length;
      if (red) {
        return {done: false, note: `${red} session${red === 1 ? "" : "s"} in the red`};
      }
      return {done: traded >= 3,
              note: traded >= 3 ? "" : `${3 - traded} more day${3 - traded === 1 ? "" : "s"}`};
    },
  },
];

/** Whether anything was written about a date, on a day card or on a trade. */
function wroteOn(date, ctx) {
  if (!date) return false;
  const notes = (ctx && ctx.notes) || {};
  for (const k of Object.keys(notes)) {
    if (k.slice(-10) === date && String(notes[k]).trim()) return true;
  }
  const every = (ctx && ctx.every) || [];
  return every.some(t => dayOf(t) === date && String(t.mine || "").trim());
}

/**
 * The same shape `board` returns, for Tradeify's missions.
 *
 * No level, no XP total of ours: these are counted in their currency and
 * kept out of ours on purpose. See the note on TRADEIFY above.
 */
export function tradeifyBoard(trades, p = JD.PLAN, ctx = {}) {
  const live = trades.filter(t => (t.source || "live") === "live");
  const days = byDay(live);
  const weeks = byWeek(live);
  const dates = [...days.keys()].sort();
  const want = ctx.today && days.has(ctx.today) ? ctx.today
    : dates[dates.length - 1] || null;
  const week = want ? weekOf(want) : null;

  let gems = 0, xp = 0, done = 0, possible = 0;
  const run = (list, scope) => TRADEIFY.filter(m => m.scope === scope)
    .map(m => ({...m, ...m.test(list, p, ctx)}));

  for (const [, list] of days) {
    for (const m of run(list, "day")) {
      possible++;
      if (m.done) { gems += m.gems; xp += m.xp; done++; }
    }
  }
  for (const [, list] of weeks) {
    for (const m of run(list, "week")) {
      possible++;
      if (m.done) { gems += m.gems; xp += m.xp; done++; }
    }
  }

  return {
    day: want, week, gems, xp, done, possible,
    today: want ? run(days.get(want), "day") : [],
    thisWeek: week ? run(weeks.get(week) || [], "week") : [],
  };
}
