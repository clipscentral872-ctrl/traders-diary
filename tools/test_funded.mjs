/**
 * Does the funded account guard follow the firm's rules?
 *
 * These are the rules that close accounts for reasons that have nothing to do
 * with the trading: a drawdown that follows the equity up and never comes
 * back, a consistency rule that holds a payout back because one day went too
 * well, and days that have to count. Each is checked on made up days where the
 * right answer is known in advance.
 *
 * The numbers here are invented. This repository is public and nobody's
 * account balance belongs in it.
 *
 *   node tools/test_funded.mjs
 */
import {PLANS, preset, days, state, size} from "../docs/funded.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const plan = preset("fff-velocity-25k");
const bal = rows => ({balances: rows.map(([date, amount, realized]) =>
  ({date, amount, realized}))});

console.log("\nthe day by day account");
{
  const d = days(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25400, 400]]));
  check("the broker's own balance is used when it is there",
        d.length === 2 && d[1].balance === 25400 && d[1].source === "broker",
        JSON.stringify(d));
  check("and its realised figure is the day, fees and all", d[1].pnl === 400,
        String(d[1].pnl));

  const fromTrades = days(plan, {trades: [
    {source: "live", open_t: "2026-09-15 10:00:00", pnl: 500, fees: 10},
    {source: "live", open_t: "2026-09-15 12:00:00", pnl: -100, fees: 10},
    {source: "replay", open_t: "2026-09-15 13:00:00", pnl: 9999},
  ]});
  check("without it, the days come from live trades only, net of fees",
        fromTrades.length === 1 && fromTrades[0].pnl === 380,
        JSON.stringify(fromTrades));
}

console.log("\nthe drawdown that follows you up");
{
  let s = state(plan, bal([["2026-09-14", 25000, 0]]));
  check("it starts $1,250 under the account", s.floor === 23750, String(s.floor));
  check("and that is the room", s.room === 1250, String(s.room));

  s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25400, 400]]));
  check("a good day drags it up with you", s.floor === 24150, String(s.floor));
  check("leaving the same room behind", s.room === 1250, String(s.room));

  s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25400, 400],
                       ["2026-09-16", 25100, -300]]));
  check("a bad day never lowers it again", s.floor === 24150, String(s.floor));
  check("so the room is what you gave back", s.room === 950, String(s.room));
  check("not breached while the balance is above it", !s.breached);

  s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 26400, 1400]]));
  check("it stops for good at the starting balance", s.floor === 25000 && s.locked,
        `${s.floor} locked ${s.locked}`);
  s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 26400, 1400],
                       ["2026-09-16", 27500, 1100]]));
  check("and stays there however far above it you go", s.floor === 25000,
        String(s.floor));

  s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 23700, -1300]]));
  check("below it is a breached account", s.breached, String(s.room));
}

console.log("\nthe consistency rule");
{
  // One day of 400 out of 400 profit is the whole of it: 40% needs 1,000.
  let s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25400, 400]]));
  check("one big day is 100% of the profit", Math.abs(s.bestPct - 1) < 1e-9,
        String(s.bestPct));
  check("so the rule is not met yet", !s.consistencyOk);
  check("and it says how much more profit would meet it",
        s.needTotal === 1000 && s.needMore === 600,
        `${s.needTotal} / ${s.needMore}`);

  s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25400, 400],
                       ["2026-09-16", 25700, 300], ["2026-09-17", 26000, 300]]));
  check("spread across days it is met", s.consistencyOk && s.needMore === 0,
        `${s.bestPct} ${s.needMore}`);
  check("a losing day does not become the best day", s.best === 400, String(s.best));
}

console.log("\ndays that count, and being ready to ask");
{
  const s = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25400, 400],
                             ["2026-09-16", 25500, 100], ["2026-09-17", 25800, 300]]));
  check("a day under $200 does not count", s.qualifying === 2, String(s.qualifying));
  check("so one more day is needed", s.daysLeft === 1, String(s.daysLeft));
  check("and it is not ready to ask for a payout", !s.ready);

  const ok = state(plan, bal([["2026-09-14", 25000, 0], ["2026-09-15", 25300, 300],
                              ["2026-09-16", 25600, 300], ["2026-09-17", 25900, 300],
                              ["2026-09-18", 26200, 300]]));
  check("four days of $300 with no day over 40% is ready",
        ok.ready && ok.qualifying === 4, `${ok.ready} ${ok.qualifying}`);
}

console.log("\nwhat it says about itself");
{
  const s = state(plan, bal([["2026-09-14", 25000, 0]]));
  check("it warns that an intraday trail can be tighter than this",
        s.notes.some(n => n.includes("intraday")), JSON.stringify(s.notes));
  const t = state(plan, {trades: [{source: "live", open_t: "2026-09-15 10:00:00", pnl: 100}]});
  check("and that trades alone are not the account's own balance",
        t.notes.some(n => n.includes("Account Balance History")), JSON.stringify(t.notes));
  const none = state(preset("none"), {});
  check("no account, nothing to watch", none.days.length === 0 && !none.ready);
  check("the preset is a copy, so editing it cannot change the preset",
        preset("fff-velocity-25k") !== PLANS["fff-velocity-25k"]);
}

console.log("\nhow many contracts");
{
  // MNQ is $2 a point, so a 40 point stop risks $80 a contract.
  let s = size({risk: 200, stop: 40, value: 2});
  check("$200 at a 40 point stop is two MNQ",
        s.contracts === 2 && s.risk === 160, JSON.stringify(s));
  check("and it says what the rounding left behind", s.unused === 40,
        String(s.unused));

  check("$250 at 25 points is five, to the dollar",
        size({risk: 250, stop: 25, value: 2}).contracts === 5);
  check("$250 at 45 points is two, not three",
        size({risk: 250, stop: 45, value: 2}).contracts === 2);
  check("$250 at 10 points is twelve",
        size({risk: 250, stop: 10, value: 2}).contracts === 12);

  // ES is $50 a point: one contract on a 40 point stop is $2,000.
  s = size({risk: 200, stop: 40, value: 50});
  check("a budget that cannot buy one contract buys none",
        s.contracts === 0 && s.risk === 0, JSON.stringify(s));

  s = size({risk: 250, stop: 10, value: 2, max: 20});
  check("under the firm's cap it is left alone",
        s.contracts === 12 && !s.capped, JSON.stringify(s));
  s = size({risk: 2000, stop: 10, value: 2, max: 20});
  check("over it, the cap is the answer and it says so",
        s.contracts === 20 && s.capped, JSON.stringify(s));

  check("no stop, no size", size({risk: 200, stop: 0, value: 2}).contracts === 0);
  check("no budget, no size", size({risk: 0, stop: 20, value: 2}).contracts === 0);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
