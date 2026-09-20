/**
 * The funded account's own rules, watched against your own record.
 *
 * A funded account is not a small trading account. It is killed by rules that
 * have nothing to do with whether the trading was good: a drawdown that
 * follows your equity up and never comes back down, a consistency rule that
 * can hold a payout back because one day went too well, and a minimum number
 * of days that count. Those are the things that end accounts, and none of them
 * are visible while you trade.
 *
 * So the journal works them out from the record and says where you stand.
 *
 * THE NUMBERS ARE YOURS TO SET. The preset below is Funded Futures Family's
 * Velocity plan as their own pages describe it, at the $25,000 size. Anything
 * a firm publishes can change and sizes differ, so every number is editable
 * and the app says which preset it started from.
 */

/** A plan is what the firm will close the account over. */
export const PLANS = {
  "fff-velocity-25k": {
    id: "fff-velocity-25k",
    name: "Funded Futures Family, Velocity $25K",
    start: 25000,
    /* Trails your equity in real time, open profit included, and stops
       trailing for good once it reaches the starting balance. */
    drawdown: 1250,
    trail: "intraday",
    locksAt: "start",
    /* Velocity: no daily loss limit, a day needs $200 of profit to count
       towards a payout, three of those days, and the best day may be no more
       than 40% of the profit in the payout cycle. */
    dailyLoss: null,
    qualifyingDay: 200,
    minDays: 3,
    consistency: 0.40,
    target: 2500,
  },
  none: {id: "none", name: "No funded account", start: 0, drawdown: 0},
};

export const preset = id => ({...(PLANS[id] || PLANS["fff-velocity-25k"])});

const money = v => Math.round(v * 100) / 100;

/**
 * The account day by day.
 *
 * The broker's own balance history is used when it has been imported: it is
 * the account's real closing balance, net of every commission and exchange
 * fee, which a pile of fills can only estimate. Otherwise the days are built
 * from the trades, and the app says so, because a drawdown measured on gross
 * P&L flatters itself by the fees.
 */
export function days(plan, {balances = [], trades = []} = {}) {
  if (balances.length) {
    const out = [];
    let prev = null;
    for (const b of [...balances].sort((a, x) => (a.date < x.date ? -1 : 1))) {
      const pnl = b.realized != null ? b.realized
        : prev === null ? b.amount - plan.start : b.amount - prev;
      out.push({date: b.date, pnl: money(pnl), balance: money(b.amount),
                source: "broker"});
      prev = b.amount;
    }
    return out;
  }
  const byDay = new Map();
  for (const t of trades) {
    if ((t.source || "live") !== "live") continue;
    const d = String(t.open_t || "").slice(0, 10);
    if (!d) continue;
    // Fees when the export carried them, so the day is as close to the
    // account's own number as trades alone can get.
    byDay.set(d, (byDay.get(d) || 0) + (t.pnl || 0) - (t.fees || 0));
  }
  let running = plan.start;
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, pnl]) => {
      running += pnl;
      return {date, pnl: money(pnl), balance: money(running), source: "trades"};
    });
}

/**
 * Where the account stands against its rules.
 *
 * The drawdown floor walks forward day by day: it follows the highest balance
 * the account has closed at, never falls, and stops at the starting balance
 * when it gets there. On a plan that trails intraday the real floor can be a
 * little higher than this, because it also follows profit that was on screen
 * and given back, so `room` is the best case and is labelled as such.
 */
export function state(plan, data = {}) {
  const list = days(plan, data);
  const start = plan.start || 0;
  let peak = start, floor = start - (plan.drawdown || 0), locked = false;

  for (const d of list) {
    peak = Math.max(peak, d.balance);
    const trailed = Math.min(start, peak - (plan.drawdown || 0));
    floor = Math.max(floor, trailed);
    d.floor = money(floor);
    d.room = money(d.balance - floor);
    if (floor >= start) locked = true;
  }

  const balance = list.length ? list[list.length - 1].balance : start;
  const profit = money(balance - start);
  const wins = list.filter(d => d.pnl > 0);
  const best = wins.length ? Math.max(...wins.map(d => d.pnl)) : 0;
  const qualifying = list.filter(d => d.pnl >= (plan.qualifyingDay || 0)).length;
  const pct = plan.consistency || 0;

  /* The consistency rule is about the SHARE of the profit one day made, so it
     is failed by a good day rather than a bad one, and the way through it is
     more profit on other days, never less on that one. */
  const needTotal = pct && best ? money(best / pct) : 0;
  const consistencyOk = !pct || !best || best <= profit * pct + 0.005;

  const notes = [];
  if (!list.length) notes.push("Nothing imported yet, so there is nothing to watch.");
  else if (list[0].source === "trades")
    notes.push("Measured from your trades. Import the broker's Account Balance "
      + "History and it will use the account's own daily balance instead, net "
      + "of every fee.");
  if (plan.trail === "intraday" && list.length)
    notes.push("This plan trails intraday, so it also follows profit that was "
      + "on screen and handed back. The room below is the best case.");

  return {
    plan, days: list, start, balance, profit,
    peak: money(peak), floor: money(floor), locked,
    room: money(balance - floor),
    roomPct: plan.drawdown ? Math.max(0, Math.min(1, (balance - floor) / plan.drawdown)) : 0,
    best, bestPct: profit > 0 ? best / profit : (best ? 1 : 0),
    consistencyOk, needTotal, needMore: money(Math.max(0, needTotal - profit)),
    qualifying, minDays: plan.minDays || 0,
    daysLeft: Math.max(0, (plan.minDays || 0) - qualifying),
    ready: !!list.length && profit > 0 && consistencyOk
           && qualifying >= (plan.minDays || 0),
    breached: !!list.length && balance <= floor,
    notes,
  };
}
