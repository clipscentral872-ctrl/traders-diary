/* Check the counterfactual against the real trades and the real bars.
 *
 * The numbers here were produced independently in Python before this module
 * existed, walking the same minute bars with the same two rules. If the two
 * disagree, one of them is wrong and it matters which: this is the file that
 * decides whether the app tells Chris to change how he trades.
 *
 *   node tools/test_whatif.mjs [trades.json] [bars dir]
 */
import fs from "node:fs";
import path from "node:path";
import * as W from "../docs/whatif.js";
import * as C from "../docs/clock.js";

const TRADES = process.argv[2]
  || "C:/Users/chris/AITrader/journal_data/trades.json";
const BARS = process.argv[3] || path.join(import.meta.dirname, "..", "docs", "bars");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

// Chris's exports are stamped UTC+2 and read in New York, same as the app.
C.setExportOffset(2);
C.setZone(C.NY);

const cache = new Map();
function barsOf(sym) {
  if (cache.has(sym)) return cache.get(sym);
  let out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BARS, `${sym}_1m.json`), "utf8"));
    j.bars.forEach((b, i) => {
      if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                       o: b[0], h: b[1], l: b[2], c: b[3]});
    });
  } catch { out = []; }
  cache.set(sym, out);
  return out;
}

const all = JSON.parse(fs.readFileSync(TRADES, "utf8"))
  .filter(t => (t.source || "live") === "live");
const flagged = all.filter(t => (t.flags || []).includes("trailed early"));

console.log(`\n${all.length} live trades, ${flagged.length} flagged for trailing early`);
check("eleven were flagged", flagged.length === 11, String(flagged.length));

const c = W.compare(flagged, barsOf);

console.log("\nevery flagged trade could be replayed");
check("none unmeasurable", c.unmeasured === 0, String(c.unmeasured));
check("nine resolved before the close", c.resolved === 9, String(c.resolved));

console.log("\nthe pessimistic rule never had to be used");
check("no minute touched both the stop and the target",
      c.ambiguous === 0, String(c.ambiguous));

console.log("\nthe totals match the independent Python run");
check("as traded is $2,810", c.asTraded === 2810, String(c.asTraded));
check("left alone is $2,755", c.leftAlone === 2755, String(c.leftAlone));
check("the difference is -$55", c.leftAlone - c.asTraded === -55,
      String(c.leftAlone - c.asTraded));

console.log("\nand so does the spread");
check("the average is about -$6", Math.abs(c.mean + 6) < 1, String(c.mean));
check("the swing is about $749", Math.abs(c.sd - 749) < 2, String(c.sd));
check("the average is buried in it", c.signal < 0.05, String(c.signal));

console.log("\nthe one trade checked by hand agrees");
{
  // ES short on 4 September, tightened twice and stopped 28 seconds before
  // the release. The original stop was never touched and the target was.
  const es = flagged.find(t => t.symbol === "ES" && t.open_t.startsWith("2026-09-04 14:05"));
  check("it is in the record", !!es);
  const got = W.stopHeld(es, barsOf("ES"));
  check("held, it reaches the target", got && got.how === "target",
        got ? got.how : "no result");
  check("worth +$1,275 instead of -$500", got && got.pnl === 1275,
        got ? String(got.pnl) : "-");
}

console.log("\nthe verdict refuses to claim an edge it cannot see");
{
  const words = W.verdict(c);
  check("it says there is no detectable difference",
        /no detectable difference/i.test(words), words.slice(0, 90));
  check("it names the noise", /inside the noise/i.test(words));
}

console.log("\nnothing is invented where there is nothing to read");
{
  check("a trade with no stop cannot be measured",
        W.stopHeld({...flagged[0], initial_stop: null, stop: null}, barsOf("NQ")) === null);
  check("nor one with no bars", W.stopHeld(flagged[0], []) === null);
  const empty = W.compare([], barsOf);
  check("no trades, no verdict", /nothing to say/i.test(W.verdict(empty)));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
