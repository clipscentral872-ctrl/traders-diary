/**
 * Do the missions pay for the right things?
 *
 * One rule decides whether this feature is safe to ship: it must never pay
 * for money. A points system that rewards a green day pays a trader to take
 * the trade that breaks the account, so the first thing tested here is that a
 * losing day which kept every rule scores exactly the same as a winning one.
 *
 * The numbers are invented. This repository is public.
 *
 *   node tools/test_quests.mjs
 */
import * as Q from "../docs/quests.js";
import * as JD from "../docs/jdun.js";
import * as C from "../docs/clock.js";

C.setZone("America/New_York");
C.setExportOffset(() => -4);

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const P = JD.plan({drawdown: 2000});     // $200 a day, $100 a trade
const answered = {tsc: true, pocket: true, stacked: true, htf: true,
                  planned: true, calm: true};

/** A clean MNQ trade at 09:50, 20 point stop, 2 contracts. */
const t = (over = {}) => ({
  symbol: "MNQ", side: "Long", qty: 2, source: "live",
  open_t: "2026-10-12 09:50:00", close_t: "2026-10-12 10:30:00",
  entry: 25000, exit: 25040, pnl: 160, stop: 24980, initial_stop: 24980,
  final_stop: 24980, risk_pts: 20, planned_rr: 2, got_r: 2, flags: [],
  jdun: {...answered}, mine: "the plan said wait, so I waited",
  ...over,
});

const find = (list, id) => list.find(m => m.id === id);

console.log("\nthe rung you are on");
{
  check("nothing earned is level one", Q.level(0).level === 1);
  check("and it says how far the next one is", Q.level(0).toNext === 200,
        String(Q.level(0).toNext));
  check("200 is level two", Q.level(200).level === 2);
  check("part way up reads as part way", Math.abs(Q.level(400).pct - 0.5) < 1e-9,
        String(Q.level(400).pct));
  check("the top of the ladder stops asking for more", Q.level(99999).max);
}

console.log("\nit pays for the process, never for the money");
{
  const won = Q.board([t()], P);
  const lost = Q.board([t({exit: 24980, pnl: -80, got_r: -1})], P);
  check("a clean winner and a clean loser earn exactly the same",
        won.xp === lost.xp && won.gems === lost.gems,
        `${won.xp} vs ${lost.xp}`);
  check("and both earn something", won.xp > 0, String(won.xp));

  // A bigger win must not be worth more than a small one.
  const big = Q.board([t({exit: 25400, pnl: 1600, got_r: 20})], P);
  check("a huge winner is worth no more than a small one", big.xp === won.xp,
        `${big.xp} vs ${won.xp}`);
}

console.log("\nthe daily missions");
{
  const clean = Q.board([t()], P);
  check("a clean session clears every daily mission",
        clean.today.every(m => m.done), JSON.stringify(
          clean.today.filter(m => !m.done).map(m => m.id)));

  const early = Q.board([t({open_t: "2026-10-12 09:36:00"})], P);
  check("an entry in the danger zone fails that one",
        !find(early.today, "danger").done);
  check("and says what went wrong",
        /danger zone/.test(find(early.today, "danger").note),
        find(early.today, "danger").note);

  const noStop = Q.board([t({stop: null})], P);
  check("no stop on record fails the stop mission",
        !find(noStop.today, "stops").done);

  const big = Q.board([t({qty: 6})], P);
  check("sized past half the cap fails the sizing mission",
        !find(big.today, "size").done, find(big.today, "size").note);

  const blown = Q.board([t({pnl: -260, exit: 24870, got_r: -3})], P);
  check("a day past the cap fails the cap mission",
        !find(blown.today, "cap").done, find(blown.today, "cap").note);

  const three = Q.board([
    t({open_t: "2026-10-12 09:50:00"}),
    t({open_t: "2026-10-12 10:50:00"}),
    t({open_t: "2026-10-12 11:50:00"}),
  ], P);
  check("three trades fails two and done", !find(three.today, "two").done);

  const trimmed = Q.board([
    t({open_t: "2026-10-12 09:50:00", close_t: "2026-10-12 10:00:00", qty: 1, pnl: 40}),
    t({open_t: "2026-10-12 09:50:00", close_t: "2026-10-12 10:40:00", qty: 1, pnl: 120}),
  ], P);
  check("but trimming one entry in two pieces does not",
        find(trimmed.today, "two").done);

  const unanswered = Q.board([t({jdun: {tsc: true}})], P);
  check("unanswered questions fail the scoring mission",
        !find(unanswered.today, "scored").done);

  const quiet = Q.board([t({mine: ""})], P);
  check("no note of your own fails the note mission",
        !find(quiet.today, "note").done);
}

console.log("\nthe weekly missions");
{
  const week = [];
  for (const d of ["12", "13", "14", "15", "16"])
    week.push(t({open_t: `2026-10-${d} 09:50:00`,
                 close_t: `2026-10-${d} 10:30:00`}));
  const b = Q.board(week, P);
  check("five tracked sessions clears that one",
        find(b.thisWeek, "week-five").done);
  check("a week inside the cap clears that one",
        find(b.thisWeek, "week-clean").done);
  check("and a week with nothing broken clears the hardest one",
        find(b.thisWeek, "week-clean-rules").done,
        find(b.thisWeek, "week-clean-rules").note);

  const four = Q.board(week.slice(0, 4), P);
  check("four sessions does not, and says how many are left",
        !find(four.thisWeek, "week-five").done
        && /1 more session/.test(find(four.thisWeek, "week-five").note),
        find(four.thisWeek, "week-five").note);

  const monday = Q.weekOf("2026-10-14");
  check("a week is named by its Monday", monday === "2026-10-12", monday);
  check("and Monday belongs to its own week",
        Q.weekOf("2026-10-12") === "2026-10-12");
}

console.log("\nwhat it does not do");
{
  const one = Q.board([t()], P);
  const twice = Q.board([t(), t()], P);
  check("drawing the board twice does not double the XP",
        Q.board([t()], P).xp === one.xp);
  check("and a trade removed takes its XP with it",
        Q.board([], P).xp === 0);
  void twice;

  const replay = Q.board([t({source: "replay"})], P);
  check("practice trades earn nothing", replay.xp === 0, String(replay.xp));
}

console.log("\nthe streak");
{
  const days = [
    t({open_t: "2026-10-12 09:50:00", close_t: "2026-10-12 10:30:00", pnl: -300}),
    t({open_t: "2026-10-13 09:50:00", close_t: "2026-10-13 10:30:00"}),
    t({open_t: "2026-10-14 09:50:00", close_t: "2026-10-14 10:30:00"}),
  ];
  const b = Q.board(days, P);
  check("counts back from the last session, stopping at the blown one",
        b.streak === 2, String(b.streak));
}

/* Tradeify's board, which is a mirror and not a scoreboard of ours.
 *
 * Two things matter here. Their gems and XP must stay out of our ladder,
 * because two of their missions pay for a green day and the rule above says
 * ours never does. And the two that Tradeify judges across every account
 * you hold must be judged that way here, or the mirror lies: a day green on
 * one account and redder on another is a day Tradeify paid for.
 */
{
  console.log("\nTradeify's missions, mirrored");
  const trade = (date, time, pnl, account, extra = {}) => ({
    symbol: "NQ", side: "Long", qty: 1, pnl,
    open_t: `${date} ${time}:00`, close_t: `${date} ${time}:00`,
    account, ...extra,
  });

  // Monday the 2nd: account A finished green, account B finished redder.
  const split = [trade("2026-03-02", "10:00", 50, "A"),
                 trade("2026-03-02", "10:30", -80, "B")];
  const tb = Q.tradeifyBoard(split, P, {every: split, notes: {}});
  const green = tb.today.find(m => m.id === "tf-green");
  check("a day green on one account counts, whatever the other did",
        green.done === true, green.note);

  const onlyRed = [split[1]];
  const red = Q.tradeifyBoard(onlyRed, P, {every: onlyRed, notes: {}})
    .today.find(m => m.id === "tf-green");
  check("a day red on the only account does not count",
        red.done === false, red.note);

  // A note counts whether it was written on the day card or on a trade.
  const noted = [trade("2026-03-03", "10:00", 10, "A",
                       {mine: "waited for the retest"})];
  const byTrade = Q.tradeifyBoard(noted, P, {every: noted, notes: {}})
    .today.find(m => m.id === "tf-scribe");
  check("a note on a trade counts as writing the session up",
        byTrade.done === true, byTrade.note);
  const bare = [trade("2026-03-03", "10:00", 10, "A")];
  const byCard = Q.tradeifyBoard(bare, P,
    {every: bare, notes: {"A|2026-03-03": "flat, did not force it"}})
    .today.find(m => m.id === "tf-scribe");
  check("and so does a note on the day card",
        byCard.done === true, byCard.note);
  const silent = Q.tradeifyBoard(bare, P, {every: bare, notes: {}})
    .today.find(m => m.id === "tf-scribe");
  check("with nothing written, it is not earned",
        silent.done === false, silent.note);

  // Clean Week: three days traded and not one session in the red, on any
  // account. The red session here belongs to the account NOT being shown.
  const week = [
    trade("2026-03-02", "10:00", 40, "A"),
    trade("2026-03-03", "10:00", 30, "A"),
    trade("2026-03-04", "10:00", 20, "A"),
    trade("2026-03-04", "11:00", -90, "B"),
  ];
  const shown = week.filter(t => t.account === "A");
  const clean = Q.tradeifyBoard(shown, P, {every: week, notes: {}})
    .thisWeek.find(m => m.id === "tf-clean-week");
  check("a red session on the other account breaks Clean Week",
        clean.done === false, clean.note);
  const alone = Q.tradeifyBoard(shown, P, {every: shown, notes: {}})
    .thisWeek.find(m => m.id === "tf-clean-week");
  check("without it, three green days earn it",
        alone.done === true, alone.note);

  // None of this may touch our own ladder.
  const ours = Q.board(split, P);
  const theirs = Q.tradeifyBoard(split, P, {every: split, notes: {}});
  check("their gems are counted on their own",
        theirs.gems > 0 && theirs.gems !== ours.gems,
        `${theirs.gems} theirs, ${ours.gems} ours`);
  check("and nothing of theirs is in our mission list",
        Q.MISSIONS.every(m => !String(m.id).startsWith("tf-")), "");
  check("every mission of theirs is one you can clear by trading",
        Q.TRADEIFY.every(m => /^tf-/.test(m.id) && typeof m.test === "function"),
        "");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
