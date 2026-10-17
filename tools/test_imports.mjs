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

console.log("\nthe Fills report, the shape Tradovate's Reports page writes");
{
  /* The real report carries Tradovate's own columns beside the human ones,
     including a UTC `_timestamp` next to a local `Timestamp`, a leading space
     in B/S, and no status column at all: every row in it is a fill. The
     numbers here are invented; the columns are the ones the real file has. */
  const FILLS = `_id,_orderId,_contractId,_timestamp,_tradeDate,_action,_qty,_price,_active,_accountId,Fill ID,Order ID,Timestamp,Date,Account,B/S,Quantity,Price,_priceFormat,_priceFormatType,_tickSize,Contract,Product,Product Description,commission
1,2,4470324,2026-09-15 14:17:10.848Z,2026-09-15,1,7,29345.5,true,99,1,2,09/15/2026 16:17:10,9/15/26,ACC1, Sell,7,29345.50,-2,0,0.25,MNQZ6,MNQ,Micro E-mini NASDAQ-100,2.73
3,4,4470324,2026-09-15 14:24:15.040Z,2026-09-15,0,7,29318.0,true,99,3,4,09/15/2026 16:24:15,9/15/26,ACC1, Buy,7,29318.00,-2,0,0.25,MNQZ6,MNQ,Micro E-mini NASDAQ-100,2.73
`;
  const got = readAny([file("Fills.csv", FILLS)], parseCSV);
  check("the Fills report is recognised as its own thing", got.found.length === 1
        && got.found[0].source === "tradovate-fills", JSON.stringify(got.found));
  check("every row is a fill, status column or not", got.fills.length === 2,
        String(got.fills.length));
  check("the local stamp is used, not the UTC one beside it",
        got.fills[0]["Closing time"] === "2026-09-15 16:17:10",
        got.fills[0]["Closing time"]);
  check("a leading space in B/S is still a side",
        got.fills[0]["Side"] === "sell", got.fills[0]["Side"]);
  check("the commission comes with it", got.fills[0]["Commission"] === "2.73",
        got.fills[0]["Commission"]);
  const {trades} = pairTrades(got.fills);
  check("sold first and bought back, so a short",
        trades.length === 1 && trades[0].side === "Short",
        JSON.stringify(trades.map(t => t.side)));
  check("27.5 points on seven MNQ is $385, which is what the broker's own "
        + "report says", Math.abs(trades[0].pnl - 385) < 1e-6, String(trades[0].pnl));
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

console.log("\nthe Fills report and the Orders report, dropped together");
{
  /* This is how Chris's exports actually arrive: the Fills report for what
     was executed, and the Orders report for the stop that was on it. The
     Orders report lists the filled orders too, so counting both would double
     every trade. */
  const FILLS = `Fill ID,Order ID,Timestamp,Date,Account,B/S,Quantity,Price,Contract,Product
9001,8001,10/14/2026 15:51:27,10/14/26,EVAL1, Buy,2,30611.50,MNQZ6,MNQ
9002,8003,10/14/2026 15:52:19,10/14/26,EVAL1, Sell,2,30575.25,MNQZ6,MNQ
`;
  const ORDERS = `orderId,Account,Order ID,B/S,Contract,Product,Fill Time,Status,Timestamp,Date,Quantity,Type,Limit Price,Stop Price,Filled Qty,Avg Fill Price
8001,EVAL1,8001,Buy,MNQZ6,MNQ,10/14/2026 15:51:27,Filled,10/14/2026 15:51:27,10/14/26,2,Market,,,2,30611.50
8002,EVAL1,8002,Sell,MNQZ6,MNQ,,Canceled,10/14/2026 15:51:27,10/14/26,2,Limit,30706.00,,,
8003,EVAL1,8003,Sell,MNQZ6,MNQ,10/14/2026 15:52:19,Filled,10/14/2026 15:51:27,10/14/26,2,Stop,,30575.25,2,30575.25
`;
  const got = readAny([file("Fills.csv", FILLS), file("Orders.csv", ORDERS)],
                      parseCSV);
  check("both files are recognised", got.found.length === 2,
        JSON.stringify(got.found.map(f => f.source)));
  check("the executions are counted once, not twice", got.fills.length === 2,
        String(got.fills.length));
  check("and they are the Fills report's own rows",
        got.fills.every(f => f["Fill price"]), JSON.stringify(got.fills[0]));
  check("the stop comes out of the Orders report",
        got.moves.filter(m => m.sl === 30575.25).length === 1,
        JSON.stringify(got.moves));
  check("so the trade knows what it risked",
        pairTrades(got.fills).trades.length === 1);

  // The Orders report on its own still has to work, for a session where only
  // that was exported.
  const alone = readAny([file("Orders.csv", ORDERS)], parseCSV);
  check("the Orders report alone still gives the fills", alone.fills.length === 2,
        String(alone.fills.length));
}

console.log("\ntwo accounts, one contract");
{
  /* Both evaluation accounts long MNQ at the same minute, both out later.
     Keyed on the contract alone, account B's sell would have closed account
     A's long and invented a trade across two accounts that never happened. */
  const both = `Fill ID,Timestamp,Date,Account,B/S,Quantity,Price,Contract,Product
5001,09/16/2026 09:50:00,9/16/26,EVAL111, Buy,2,25000.00,MNQZ6,MNQ
5002,09/16/2026 09:50:00,9/16/26,EVAL222, Buy,3,25001.00,MNQZ6,MNQ
5003,09/16/2026 10:10:00,9/16/26,EVAL222, Sell,3,25011.00,MNQZ6,MNQ
5004,09/16/2026 10:30:00,9/16/26,EVAL111, Sell,2,25020.00,MNQZ6,MNQ
`;
  const {fills} = readAny([file("Fills.csv", both)], parseCSV);
  check("the account comes through on every fill",
        fills.length === 4 && fills.every(f => f["Account"]),
        JSON.stringify(fills.map(f => f["Account"])));

  const {trades} = pairTrades(fills);
  check("two accounts give two trades, not one crossed pair",
        trades.length === 2, String(trades.length));
  const a = trades.find(t => t.account === "EVAL111");
  const b = trades.find(t => t.account === "EVAL222");
  check("each trade knows its own account", !!a && !!b,
        JSON.stringify(trades.map(t => t.account)));
  check("and pairs with its own fills, not the other account's",
        a.qty === 2 && a.exit === 25020 && b.qty === 3 && b.exit === 25011,
        JSON.stringify([a.qty, a.exit, b.qty, b.exit]));
  check("so the money is each account's own",
        a.pnl === 80 && b.pnl === 60, JSON.stringify([a.pnl, b.pnl]));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
