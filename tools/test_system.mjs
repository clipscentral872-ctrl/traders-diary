/* Check the System tab reads the small file and the big one the same way.
 *
 * The system publishes two files now: a summary for this page, and its full
 * state for itself. The page can be handed either one, because the summary is
 * written by the poller and will not exist until it next runs, and because an
 * outage can push the page onto whichever host still answers. If the two ever
 * stop agreeing, the tab starts reporting different numbers depending on
 * which file got through, which is the worst kind of wrong: quietly.
 *
 *   node tools/test_system.mjs
 */
import {seenTotals, slim} from "../docs/system.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

// A poll's worth of workings, the shape poll_once.py writes.
const row = (all, fresh, long, short, fl, fs) =>
  ({when: "2026-09-08T10:00:00", track: "main", symbol: "MNQ",
    all, fresh, long, short, fresh_long: fl, fresh_short: fs});

const FULL = {
  equity: 52985.57, position: null, polls: 2953,
  started: "2026-08-26T17:25:33Z", updated: "2026-09-09T09:00:00Z",
  trades: [{pnl: 120, r: 0.6, symbol: "MNQ", entry: 1, exit: 2},
           {pnl: -80, r: -1, symbol: "MES", entry: 3, exit: 4}],
  wide: {equity: 50100, position: {side: "long", symbol: "MNQ", entry: 29500},
         trades: [{pnl: 40, r: 0.2}]},
  seen: [row(30, 1, 14, 16, 1, 0), row(25, 0, 12, 13, 0, 0),
         row(18, 2, 9, 9, 1, 1)],
};

console.log("\nthe workings add up to the totals the summary carries");
{
  const t = seenTotals(FULL);
  check("every setup offered", t.all === 73, String(t.all));
  check("the new ones", t.fresh === 3, String(t.fresh));
  check("long and short", t.long === 35 && t.short === 38,
        `${t.long}/${t.short}`);
  check("new long and new short", t.fresh_long === 2 && t.fresh_short === 1,
        `${t.fresh_long}/${t.fresh_short}`);
  check("and how many polls were logged", t.observations === 3,
        String(t.observations));
}

console.log("\nthe summary is read straight, not added up again");
{
  const summary = {seen_totals: {all: 73900, fresh: 18, long: 35654,
                                 short: 38246, fresh_long: 9, fresh_short: 9,
                                 observations: 3894}};
  const t = seenTotals(summary);
  check("the totals come through", t.all === 73900 && t.fresh === 18,
        JSON.stringify(t));
  check("and it is a copy, not the file's own object",
        t !== summary.seen_totals);
}

console.log("\nboth files land on the same numbers");
{
  // What poll_once.py writes into demo_summary.json, built from the same
  // state. If this and the full file ever disagree, the tab reports
  // different figures depending on which one got through.
  const summary = {
    equity: FULL.equity, position: FULL.position, polls: FULL.polls,
    started: FULL.started, updated: FULL.updated,
    trades: FULL.trades.map(t => ({pnl: t.pnl, r: t.r})),
    wide: {equity: FULL.wide.equity, position: FULL.wide.position,
           trades: FULL.wide.trades.map(t => ({pnl: t.pnl, r: t.r}))},
    seen_totals: seenTotals(FULL),
  };
  check("the totals match",
        JSON.stringify(seenTotals(summary)) === JSON.stringify(seenTotals(FULL)),
        JSON.stringify(seenTotals(summary)));
  check("and slimming either one gives the same thing",
        JSON.stringify(slim(summary)) === JSON.stringify(slim(FULL)),
        JSON.stringify(slim(summary)));
}

console.log("\nwhat gets kept on the device is the small shape");
{
  const kept = slim(FULL);
  check("the workings are not kept", kept.seen === undefined);
  check("the totals are", kept.seen_totals.all === 73);
  check("a trade keeps only what is read off it",
        JSON.stringify(kept.trades[0]) === '{"pnl":120,"r":0.6}',
        JSON.stringify(kept.trades[0]));
  check("the second book survives",
        kept.wide && kept.wide.trades.length === 1 && kept.wide.position,
        JSON.stringify(kept.wide));
  check("and it is far smaller",
        JSON.stringify(kept).length < JSON.stringify(FULL).length,
        `${JSON.stringify(kept).length} vs ${JSON.stringify(FULL).length}`);
}

console.log("\nan empty or half written file does not throw");
{
  check("nothing at all", seenTotals({}).observations === 0);
  check("a state with no seen log", seenTotals({polls: 1}).all === 0);
  check("and slim survives it", !!slim({}));
  check("with no second book", slim({}).wide === undefined);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
