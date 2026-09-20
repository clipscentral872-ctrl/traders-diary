/**
 * Does a broker export land in the journal as the same trades?
 *
 * Chris trades a funded Tradovate account through TradingView. The broker's
 * own export is the complete record, so it has to arrive as fills the engine
 * can pair, with the stop that was on the position, in his own local time.
 *
 * The columns here are Tradovate's documented ones, cross-checked against the
 * community parsers other journals use. When his real file lands, any column
 * that differs is one line in docs/imports.js and one fixture here.
 *
 *   node tools/test_imports.mjs
 */
import {sniff, readAny, stamp, rootSymbol} from "../docs/imports.js";
import {parseCSV, pairTrades, analyse} from "../docs/engine.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const file = (name, text) => ({name, text});

/* A day on the funded account: buy two MNQ, a stop and a target go on, the
   target fills. Tradovate writes the stop and limit as their own rows. */
const TRADOVATE = `orderId,Account,Date,Fill Time,B/S,Contract,Product,Filled Qty,Avg Fill Price,Status,Type,Stop Price,Limit Price,Commission
1001,DEMO123,9/18/26,09:35:12,Buy,MNQZ5,MNQ,2,24950.25,Filled,Market,,,1.04
1002,DEMO123,9/18/26,09:35:13,Sell,MNQZ5,MNQ,,,Working,Stop,24930.25,,
1003,DEMO123,9/18/26,09:35:13,Sell,MNQZ5,MNQ,,,Working,Limit,,24990.25,
1004,DEMO123,9/18/26,10:02:44,Sell,MNQZ5,MNQ,2,24990.25,Filled,Limit,,24990.25,1.04
`;

console.log("\nwhat a file is, by its columns");
{
  const rows = parseCSV(TRADOVATE);
  const s = sniff(Object.keys(rows[0]));
  check("a Tradovate export is recognised", s && s.id === "tradovate-orders",
        s ? s.id : "nothing");
  const tv = parseCSV("Symbol,Side,Qty,Fill price,Status,Closing time\n"
    + "CME_MINI:MNQ1!,buy,2,24950.25,Filled,2026-09-18 09:35:12\n");
  const s2 = sniff(Object.keys(tv[0]));
  check("a TradingView export is still recognised as its own thing",
        s2 && s2.id === "tradingview-orders", s2 ? s2.id : "nothing");
  check("something else is not claimed by either",
        sniff(["Date", "Note", "Amount"]) === null);
}

console.log("\nthe broker's fills");
{
  const got = readAny([file("Orders.csv", TRADOVATE)], parseCSV);
  check("both filled orders arrive, and only those", got.fills.length === 2,
        String(got.fills.length));
  check("the contract becomes the symbol the journal uses",
        got.fills[0]["Symbol"] === "MNQ", got.fills[0]["Symbol"]);
  check("the date and time become one stamp",
        got.fills[0]["Closing time"] === "2026-09-18 09:35:12",
        got.fills[0]["Closing time"]);
  check("it says what it read", got.found.length === 1
        && got.found[0].source === "tradovate-orders" && got.found[0].fills === 2,
        JSON.stringify(got.found));

  const {trades} = pairTrades(got.fills);
  check("the two fills pair into one trade", trades.length === 1,
        String(trades.length));
  const t = trades[0];
  check("a long of two contracts", t.side === "Long" && t.qty === 2,
        `${t.side} ${t.qty}`);
  check("40 points on two MNQ is $160", Math.abs(t.pnl - 160) < 1e-6, String(t.pnl));

  const done = analyse({...t}, got.moves, got.spans);
  check("the stop order on the position gives the risk",
        done.stop === 24930.25 && done.risk_pts === 20,
        `${done.stop} / ${done.risk_pts}`);
  check("and R is measured against it", Math.abs(done.got_r - 2) < 1e-9,
        String(done.got_r));
  check("the target is read too", done.target === 24990.25, String(done.target));
}

console.log("\nthe shapes Tradovate writes");
{
  check("M/D/YY with a time", stamp("9/18/26", "09:35:12") === "2026-09-18 09:35:12",
        String(stamp("9/18/26", "09:35:12")));
  check("a whole stamp in the time column",
        stamp("", "09/18/2026 09:35:12") === "2026-09-18 09:35:12",
        String(stamp("", "09/18/2026 09:35:12")));
  check("a twelve hour clock", stamp("9/18/26", "1:05 PM") === "2026-09-18 13:05:00",
        String(stamp("9/18/26", "1:05 PM")));
  check("midnight on a twelve hour clock",
        stamp("9/18/26", "12:05 AM") === "2026-09-18 00:05:00",
        String(stamp("9/18/26", "12:05 AM")));
  check("an ISO stamp is left alone",
        stamp("", "2026-09-18 09:35") === "2026-09-18 09:35:00",
        String(stamp("", "2026-09-18 09:35")));
  check("nothing readable is nothing, not a guess", stamp("", "") === null
        && stamp("not a date", "") === null);
  check("the contract month comes off", rootSymbol("MNQZ5") === "MNQ"
        && rootSymbol("ESU2026") === "ES" && rootSymbol("MNQ") === "MNQ",
        [rootSymbol("MNQZ5"), rootSymbol("ESU2026")].join());
  check("a TradingView ticker still resolves",
        rootSymbol("CME_MINI:MNQ1!") === "MNQ", rootSymbol("CME_MINI:MNQ1!"));
}

console.log("\nwhat it refuses to do");
{
  const cancelled = `orderId,Account,Date,Fill Time,B/S,Contract,Product,Filled Qty,Avg Fill Price,Status,Type
2001,D,9/18/26,09:40:00,Buy,MNQZ5,MNQ,,,Canceled,Limit
`;
  const got = readAny([file("Orders.csv", cancelled)], parseCSV);
  check("an order that never filled is not a fill", got.fills.length === 0,
        String(got.fills.length));
  const empty = readAny([file("notes.csv", "Date,Note\n9/18/26,hello\n")], parseCSV);
  check("a file it does not know is left alone", empty.fills.length === 0
        && empty.found.length === 0);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
