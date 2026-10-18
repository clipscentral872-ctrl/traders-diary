/**
 * Does the playbook catch the trades that were never in the playbook?
 *
 * Each case is a trade built so the right answer is known before it is read:
 * one inside the opening fifteen minutes, one sized past the cap, one stop
 * widened, one perfectly good trade that lost. The last one matters most. A
 * grader that cannot tell a bad trade from an unlucky one is worse than no
 * grader, because it teaches the wrong lesson.
 *
 * The numbers are invented. This repository is public.
 *
 *   node tools/test_jdun.mjs
 */
import * as J from "../docs/jdun.js";
import * as C from "../docs/clock.js";

C.setZone("America/New_York");
C.setExportOffset(() => -4);          // stamps written in New York time

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const P = J.plan({drawdown: 2000});    // $200 a day, $100 a trade

/** A clean MNQ trade: 09:50 entry, 20 point stop, 2 contracts, closed at 2R. */
const good = (over = {}) => ({
  symbol: "MNQ", side: "Long", qty: 2,
  open_t: "2026-10-13 09:50:00", close_t: "2026-10-13 10:30:00",
  entry: 25000, exit: 25040, pnl: 160,
  stop: 24980, initial_stop: 24980, final_stop: 24980, stop_moved: false,
  risk_pts: 20, reward_pts: 40, planned_rr: 2, got_r: 2, flags: [],
  jdun: {tsc: true, pocket: true, stacked: true, htf: true, planned: true, calm: true},
  ...over,
});

const has = (fs, id, verdict) => fs.some(f => f.id === id && f.verdict === verdict);
const find = (fs, id) => fs.find(f => f.id === id);

console.log("\nthe numbers the whole plan hangs on");
{
  check("a $2,000 drawdown is a $200 day", J.dailyCap(P) === 200, String(J.dailyCap(P)));
  check("and a $100 full size loss, so two of them is the day",
        J.perTrade(P) === 100, String(J.perTrade(P)));
  const big = J.plan({drawdown: 3000});
  check("a $3,000 drawdown is a $300 day", J.dailyCap(big) === 300);
}

console.log("\nthe danger zone");
{
  const r = J.review(good({open_t: "2026-10-13 09:36:00"}), P, {});
  check("a trade inside the first fifteen minutes is caught",
        has(r.findings, "danger", "broke"), JSON.stringify(find(r.findings, "danger")));
  check("and it says what to do instead",
        /waits for it to finish/.test(find(r.findings, "danger").instead));
  check("09:50 is clean", has(J.review(good(), P, {}).findings, "danger", "kept"));
  check("before the bell is its own fault",
        has(J.review(good({open_t: "2026-10-13 08:10:00"}), P, {}).findings,
            "session", "broke"));
}

console.log("\nthe stop decides the size");
{
  const r = J.review(good({qty: 4, pnl: 320}), P, {});
  check("four contracts on a 20 point stop is $160, past the $100 loss",
        has(r.findings, "size", "broke"), JSON.stringify(find(r.findings, "size")));
  check("and the right size is worked out for him",
        /allows 2 contracts/.test(find(r.findings, "size").instead),
        find(r.findings, "size").instead);
  check("two contracts is inside it", has(J.review(good(), P, {}).findings, "size", "kept"));

  const noStop = J.review(good({stop: null, initial_stop: null, risk_pts: null,
                                got_r: null, planned_rr: null}), P, {});
  check("no stop on record is a question, not a verdict",
        has(noStop.findings, "stop", "asked"));
  check("and it says how to fix the record",
        /orders panel/.test(find(noStop.findings, "stop").instead));
}

console.log("\nthe stop that moved");
{
  const r = J.review(good({stop_moved: true, final_stop: 24960,
                           got_r: -2, pnl: -160, exit: 24960}), P, {});
  check("a stop moved away from entry is caught",
        has(r.findings, "widened", "broke"));
  check("and a loss past 1R is caught with it",
        has(r.findings, "overrun", "broke"), JSON.stringify(find(r.findings, "overrun")));

  const trail = J.review(good({stop_moved: true, final_stop: 25010}), P, {});
  check("a stop moved toward entry is not a fault",
        !has(trail.findings, "widened", "broke"));

  const slip = J.review(good({got_r: -1.4, pnl: -112, flags: ["slipped"]}), P, {});
  check("a loss past 1R from slippage is the market, not him",
        !has(slip.findings, "overrun", "broke"));
}

console.log("\ntaking it off too early");
{
  const r = J.review(good({got_r: 0.4, exit: 25008, pnl: 32}), P, {});
  check("a winner cut under 1R is flagged", has(r.findings, "early", "watch"));
  check("full marks are not lost over it",
        find(r.findings, "early").verdict === "watch");
  const thin = J.review(good({planned_rr: 1.1}), P, {});
  check("a target under 1.5R is flagged", has(thin.findings, "rr", "watch"));
}

console.log("\nthe day's own rules");
{
  const l1 = good({open_t: "2026-10-13 09:50:00", close_t: "2026-10-13 10:00:00",
                   pnl: -100, got_r: -1});
  const l2 = good({open_t: "2026-10-13 10:30:00", close_t: "2026-10-13 10:40:00",
                   pnl: -100, got_r: -1});
  const third = good({open_t: "2026-10-13 11:30:00", close_t: "2026-10-13 12:00:00"});
  const day = [l1, l2, third];

  const r = J.review(third, P, {dayTrades: day});
  check("a third trade after two losses breaks the circuit breaker",
        has(r.findings, "twoloss", "broke"), JSON.stringify(find(r.findings, "twoloss")));
  check("and the trade count rule catches it too",
        has(r.findings, "count", "broke"));
  check("and the daily cap, which was already spent",
        has(r.findings, "cap", "broke"), JSON.stringify(find(r.findings, "cap")));
  check("the first trade of the day breaks none of them",
        !has(J.review(l1, P, {dayTrades: day}).findings, "twoloss", "broke"));

  const quick = good({open_t: "2026-10-13 10:03:00"});
  check("a trade three minutes after a loss is flagged",
        has(J.review(quick, P, {dayTrades: [l1, quick]}).findings, "revenge", "watch"));
  const later = good({open_t: "2026-10-13 10:40:00"});
  check("half an hour later is not",
        !has(J.review(later, P, {dayTrades: [l1, later]}).findings, "revenge", "watch"));
}

console.log("\none entry closed in two pieces is one trade");
{
  /* Trimming at 1R and letting the rest run is the method's own management.
     In the fills it comes back as two round trips off one entry, and
     counting the pieces would have the rules punish him for following
     them. */
  const a = good({open_t: "2026-10-13 09:50:00", close_t: "2026-10-13 10:00:00",
                  qty: 1, pnl: 80, got_r: 1});
  const b = good({open_t: "2026-10-13 09:50:00", close_t: "2026-10-13 10:40:00",
                  qty: 1, pnl: 160, got_r: 2});
  const later = good({open_t: "2026-10-13 11:00:00", close_t: "2026-10-13 11:30:00"});
  const day = [a, b, later];

  check("the second piece is not a second trade",
        !has(J.review(b, P, {dayTrades: day}).findings, "count", "broke"));
  check("and the next real trade is only the second of the day",
        !has(J.review(later, P, {dayTrades: day}).findings, "count", "broke"));

  const l1 = good({open_t: "2026-10-14 09:50:00", close_t: "2026-10-14 10:00:00",
                   qty: 1, pnl: -40, got_r: -1});
  const l2 = good({open_t: "2026-10-14 09:50:00", close_t: "2026-10-14 10:10:00",
                   qty: 1, pnl: -40, got_r: -1});
  const after = good({open_t: "2026-10-14 11:00:00", close_t: "2026-10-14 11:30:00"});
  check("one losing entry in two pieces is one loss, not two",
        !has(J.review(after, P, {dayTrades: [l1, l2, after]}).findings,
             "twoloss", "broke"));
}

console.log("\nthe questions only he can answer");
{
  const blank = good({jdun: undefined});
  const r = J.review(blank, P, {});
  check("an unanswered trade asks all six", r.score.asked === 6, String(r.score.asked));
  check("and is not marked as broken", r.verdict === "open", r.verdict);

  const no = J.review(good({jdun: {tsc: false, pocket: true, stacked: true,
                                   htf: true, planned: true, calm: true}}), P, {});
  check("a no answer is a broken rule", has(no.findings, "tsc", "broke"));
  check("and it says what the rule wanted",
        /pass, not a smaller position/.test(find(no.findings, "tsc").instead));
}

console.log("\nthe verdict, which is about process and not money");
{
  const won = J.review(good(), P, {});
  check("a clean winner is a good trade", won.verdict === "good", won.verdict);

  const lost = J.review(good({exit: 24980, pnl: -80, got_r: -1}), P, {});
  check("a clean loser is ALSO a good trade", lost.verdict === "good", lost.verdict);
  check("and it says so in plain words",
        /take the same setup again/.test(lost.line), lost.line);
  check("a clean loser scores full marks", lost.score.broke === 0);

  const lucky = J.review(good({open_t: "2026-10-13 09:33:00"}), P, {});
  check("a winner that broke a rule is called out", lucky.verdict === "lucky", lucky.verdict);
  check("and the words say why that is the dangerous kind",
        /only one of them repeats/.test(lucky.line));
}

console.log("\nthe day, and the habit");
{
  const l1 = good({open_t: "2026-10-13 09:36:00", close_t: "2026-10-13 09:45:00",
                   pnl: -100, got_r: -1});
  const l2 = good({open_t: "2026-10-14 09:38:00", close_t: "2026-10-14 09:50:00",
                   pnl: -100, got_r: -1});
  const clean = good({open_t: "2026-10-15 10:00:00", close_t: "2026-10-15 10:30:00"});

  const ds = J.days([l1, l2, clean], P);
  check("days come back newest first", ds[0].date === "2026-10-15", ds[0].date);
  check("a clean day says so", ds[0].notes.some(n => /Clean day/.test(n)));
  check("a red day with the rules kept is called a good day",
        J.reviewDay([good({exit: 24980, pnl: -80, got_r: -1})], P)
         .notes.some(n => /cost of doing business/.test(n)));

  const h = J.habits([l1, l2, clean], P);
  check("the habit that keeps happening is on top", h[0].id === "danger", JSON.stringify(h.map(x => x.id)));
  check("counted twice", h[0].n === 2, String(h[0].n));
  check("with what it cost", h[0].pnl === -200, String(h[0].pnl));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
