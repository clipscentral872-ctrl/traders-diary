/* Check a demo trade opens on the right bar and is only ever closed by bars
 * that came after it.
 *
 * The bug this exists to stop: a five minute chart's last bar is still
 * forming. It is stamped 12:55 and its close is the price at 12:59, and the
 * minute bars for 12:56 to 12:59 sit inside it. Opening on that bar and then
 * recording 12:55 as the moment last seen made the settle walk replay those
 * four minutes as if they were news. A long was opened and stopped out in
 * the same click, at -1.96R, on minutes that had already happened.
 *
 *   node tools/test_demo.mjs
 */
import {entryBar, resolve} from "../docs/demo.js";
import {tradeKey} from "../docs/engine.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const T = m => Date.UTC(2026, 8, 4, 16, m);          // 16:mm on the day
const bar = (m, o, h, l, c) => ({ms: T(m), o, h, l, c});

// What the two published series actually looked like on the day this broke:
// the five minute series ends at 16:55 and the minute series runs on to
// 16:59, forty points lower for three of those minutes.
const FIVE = [bar(50, 29500, 29570, 29495, 29560), bar(55, 29560, 29570, 29519, 29565.25)];
const ONE = [
  bar(55, 29560, 29566, 29558, 29563),
  bar(56, 29526, 29526, 29519.5, 29524.5),
  bar(57, 29524.5, 29525.25, 29521.25, 29525.25),
  bar(58, 29525, 29526.75, 29523.75, 29524.25),
  bar(59, 29525, 29565.25, 29521.25, 29565.25),
];

const long = (entry, seen) => ({
  side: "Long", entry, seen,
  stop: entry - 20, target: entry + 40,
});

console.log("\nthe trade opens on the freshest bar held, not the chart's");
{
  const b = entryBar(FIVE, ONE);
  check("the minute bar wins when it is newer", b.ms === T(59),
        new Date(b.ms).toISOString());
  check("and its close is the entry price", b.c === 29565.25, String(b.c));
  check("the chart's bar wins when nothing is fresher",
        entryBar(FIVE, [ONE[0]]).ms === T(55));
  check("one series alone still gives a bar",
        entryBar(FIVE, []).ms === T(55) && entryBar([], ONE).ms === T(59));
  check("no bars at all gives nothing", entryBar([], []) === null);
}

console.log("\nbars that already happened cannot close the trade");
{
  const p = long(29565.25, T(59));           // opened on the freshest bar
  const {hit} = resolve(p, ONE);
  check("nothing settles it", hit === null, hit && hit.how);

  // The same trade with the old, wrong moment. If this ever stops finding a
  // stop, the case above has stopped proving anything.
  const was = long(29565.25, T(55));
  const old = resolve(was, ONE);
  check("and the bug it replaced really did settle it",
        old.hit && old.hit.how === "Stop", String(old.hit));
}

console.log("\nbars that do arrive settle it, in order");
{
  const p = long(29565.25, T(59));
  const later = [...ONE,
    bar(60, 29566, 29580, 29564, 29578),
    bar(61, 29578, 29612, 29576, 29610)];
  const {hit, seen} = resolve(p, later);
  check("the target is taken", hit && hit.how === "Take Profit", String(hit));
  check("at the target price", hit && hit.price === 29605.25, hit && String(hit.price));
  check("on the bar that reached it", hit && hit.ms === T(61));
  check("and nothing past that bar is counted as seen", seen === T(61));
}

console.log("\na stop that was hit and recovered from is still a stop");
{
  const p = long(29565.25, T(59));
  const later = [...ONE,
    bar(60, 29566, 29570, 29540, 29568),     // through the stop, then back
    bar(61, 29568, 29612, 29566, 29610)];    // and on to the target
  const {hit} = resolve(p, later);
  check("the stop wins", hit && hit.how === "Stop" && hit.ms === T(60),
        String(hit && hit.how));
}

console.log("\none bar touching both closes at the stop");
{
  const p = long(29565.25, T(59));
  const {hit} = resolve(p, [...ONE, bar(60, 29566, 29612, 29540, 29600)]);
  check("the worse of the two", hit && hit.how === "Stop", String(hit && hit.how));
}

console.log("\na gap fills where it opened, not where the order sat");
{
  const p = long(29565.25, T(59));
  const gap = resolve(p, [...ONE, bar(60, 29500, 29505, 29495, 29502)]);
  check("a long gapping down fills at the open",
        gap.hit && gap.hit.price === 29500, gap.hit && String(gap.hit.price));

  const win = resolve(long(29565.25, T(59)),
                      [...ONE, bar(60, 29620, 29630, 29618, 29625)]);
  check("and a long gapping past its target fills at the open too",
        win.hit && win.hit.how === "Take Profit" && win.hit.price === 29620,
        win.hit && String(win.hit.price));
}

console.log("\nthe short side is the same rules the other way up");
{
  const short = {side: "Short", entry: 29565.25, seen: T(59),
                 stop: 29585.25, target: 29525.25};
  const stopped = resolve({...short}, [...ONE, bar(60, 29566, 29590, 29564, 29588)]);
  check("a stop above is hit by a high", stopped.hit
        && stopped.hit.how === "Stop" && stopped.hit.price === 29585.25,
        String(stopped.hit));
  const won = resolve({...short}, [...ONE, bar(60, 29564, 29566, 29520, 29522)]);
  check("a target below is hit by a low", won.hit
        && won.hit.how === "Take Profit" && won.hit.price === 29525.25,
        String(won.hit));
  const gapped = resolve({...short}, [...ONE, bar(60, 29600, 29605, 29598, 29602)]);
  check("and a short gapping up fills at the open",
        gapped.hit && gapped.hit.price === 29600, String(gapped.hit));
}

console.log("\ntwo trades on the same bar are two trades");
{
  // The open time is the bar's, and one bar stays the latest for about half
  // an hour, so closing one trade and opening another gives both the same
  // open_t. On the old key the second was dropped on the way to the Diary.
  const a = {id: "demo:abc:1", source: "demo", symbol: "NQ",
             open_t: "2026-09-07 19:34:00"};
  const b = {id: "demo:abc:2", source: "demo", symbol: "NQ",
             open_t: "2026-09-07 19:34:00"};
  check("they are told apart", tradeKey(a) !== tradeKey(b),
        tradeKey(a) + " vs " + tradeKey(b));
  check("and the same one sent twice is still one",
        tradeKey(a) === tradeKey({...a}));
  check("the old key really did lose one",
        `${a.source}|${a.symbol}|${a.open_t}`
          === `${b.source}|${b.symbol}|${b.open_t}`);
}

console.log("\nan imported trade keeps the older key");
{
  const t = {symbol: "NQ", open_t: "2026-09-04 15:53:08"};
  check("source, symbol and open time",
        tradeKey(t, "live") === "live|NQ|2026-09-04 15:53:08",
        tradeKey(t, "live"));
  check("so importing the same session twice adds nothing",
        tradeKey(t, "live") === tradeKey({...t}, "live"));
  check("and its own source wins over the one passed in",
        tradeKey({...t, source: "demo"}, "live")
          === "demo|NQ|2026-09-04 15:53:08");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
