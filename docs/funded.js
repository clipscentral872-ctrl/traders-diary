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
    /* The firm's position cap, in micro contracts. Two minis on the $25,000
       size is twenty micros. Check it against your own dashboard. */
    maxMicros: 20,
  },
  /* Tradeify's Select evaluation at $50,000, which is what Chris trades.
     Taken from Tradeify's own pricing table and help centre on 2026-10-17.
     Firms change these, so the app lets every number be edited.

     The drawdown trails the highest END OF DAY balance and never locks on
     an evaluation: locking is a funded-account rule there. It is updated at
     the close but enforced in real time against net liquidation value, open
     positions included, so touching the floor intraday fails the account
     even if the day finishes green. */
  "tradeify-select-50k": {
    id: "tradeify-select-50k",
    name: "Tradeify Select evaluation, $50,000",
    start: 50000,
    drawdown: 2000,
    trail: "eod",
    realtime: true,
    locksAt: "none",
    dailyLoss: null,
    qualifyingDay: 0,
    minDays: 3,
    consistency: 0.40,
    target: 3000,
    maxMicros: 40,
  },
  /* The funded stage of the same account, for when he passes. Here the
     drawdown does lock: at a $52,100 end of day balance, or the moment a
     payout is requested, and the floor is then $50,100 for good. */
  "tradeify-select-50k-funded": {
    id: "tradeify-select-50k-funded",
    name: "Tradeify Select funded, $50,000",
    start: 50000,
    drawdown: 2000,
    trail: "eod",
    realtime: true,
    locksAt: 52100,
    lockFloor: 50100,
    dailyLoss: null,
    qualifyingDay: 0,
    minDays: 1,
    consistency: 0,
    target: 0,
    maxMicros: 40,
  },
  none: {id: "none", name: "No funded account", start: 0, drawdown: 0},
};

/* The plan a fresh journal assumes, which is the one Chris trades. */
export const DEFAULT_PLAN = "tradeify-select-50k";

export const preset = id => ({...(PLANS[id] || PLANS[DEFAULT_PLAN])});

const money = v => Math.round(v * 100) / 100;

/**
 * How many contracts a risk budget buys.
 *
 * Risk first, stop second, size last, and always rounded DOWN: the contract
 * that would take you past the budget is the one that turns a planned loss
 * into an unplanned one. What is left over is reported rather than hidden,
 * because on a wide stop the rounding can waste a third of the budget, and
 * knowing that is how you decide whether the trade is worth taking at all.
 *
 * @param risk    dollars you are willing to lose on this trade
 * @param stop    the stop distance in points
 * @param value   what one point of this contract is worth, in dollars
 * @param max     the firm's cap on contracts, if there is one
 */
export function size({risk = 0, stop = 0, value = 0, max = Infinity} = {}) {
  const per = money(stop * value);
  if (!(per > 0) || !(risk > 0))
    return {contracts: 0, per: per || 0, risk: 0, unused: money(risk || 0),
            capped: false};
  let contracts = Math.floor(risk / per);
  const capped = contracts > max;
  if (capped) contracts = Math.floor(max);
  return {contracts, per, risk: money(contracts * per),
          unused: money(risk - contracts * per), capped};
}

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
 * The drawdown floor walks forward day by day, following the highest balance
 * the account has closed at and never falling. Where it STOPS following is
 * the part firms differ on, and getting it wrong misstates the one number
 * that decides whether the account survives:
 *
 *   "start"  it stops at the starting balance. Funded Futures Family.
 *   "none"   it never stops. Every Tradeify evaluation works this way, so
 *            past the drawdown in profit the floor is above where you began.
 *   a number the EOD balance that locks it, after which the floor is fixed at
 *            `lockFloor`. Tradeify's funded accounts: $52,100 on the $50,000,
 *            and the floor then sits at $50,100 for good.
 *
 * On a plan that is enforced against open profit as well, the real floor can
 * be tighter than this, so `room` is the best case and is labelled as such.
 */
export function state(plan, data = {}) {
  const list = days(plan, data);
  const start = plan.start || 0;
  let peak = start, floor = start - (plan.drawdown || 0), locked = false;

  for (const d of list) {
    peak = Math.max(peak, d.balance);
    let trailed;
    if (typeof plan.locksAt === "number")
      trailed = peak >= plan.locksAt
        ? (plan.lockFloor ?? start) : peak - (plan.drawdown || 0);
    else if (plan.locksAt === "none") trailed = peak - (plan.drawdown || 0);
    else trailed = Math.min(start, peak - (plan.drawdown || 0));
    floor = Math.max(floor, trailed);
    d.floor = money(floor);
    d.room = money(d.balance - floor);
    if (typeof plan.locksAt === "number") locked = peak >= plan.locksAt;
    else if (plan.locksAt === "none") locked = false;
    else if (floor >= start) locked = true;
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
  else if (plan.realtime && list.length)
    notes.push("The floor only moves at the close, but it is enforced against "
      + "your open positions all day. Touching it for a second fails the "
      + "account, even if the day ends green. The room below is end of day.");

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
