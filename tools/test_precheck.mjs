/* Check the short list says the right things and, more importantly, does not
 * say the wrong ones.
 *
 * A checklist that blocks trades it should not is worse than no checklist:
 * it gets ignored, and then it is ignored on the day it was right. So the
 * negative cases matter as much as the positive ones, and the habit this app
 * has already disproved must never appear on it.
 *
 *   node tools/test_precheck.mjs
 */
import * as PC from "../docs/precheck.js";
import * as C from "../docs/clock.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

C.setZone(C.NY);
C.reset();

// July, so New York is UTC-4: 13:30 UTC is 09:30 there.
const at = (h, m) => Date.parse(`2026-07-15T${String(h).padStart(2, "0")}:`
                              + `${String(m).padStart(2, "0")}:00Z`);
const ny = (h, m) => at(h + 4, m);          // a New York wall time in July
const words = list => list.map(x => x.text).join(" | ");

console.log("\na clean trade in the middle of the session says nothing");
{
  const l = PC.check({ms: ny(11, 0), risk: 200, reward: 400,
                      balance: 100000, today: []});
  check("no items at all", l.length === 0, words(l));
  check("and nothing to confirm", !PC.holds(l));
}

console.log("\nthe release slots are the ones that cost money here");
{
  const l = PC.check({ms: ny(8, 28), risk: 200, reward: 400, balance: 100000});
  check("three minutes before 08:30 is held", PC.holds(l), words(l));
  check("it names the slot", /08:30/.test(words(l)), words(l));
  const ok = PC.check({ms: ny(8, 20), risk: 200, reward: 400, balance: 100000});
  check("ten minutes before is not", !PC.holds(ok), words(ok));
  // The bar a five minute chart actually prints before the slot. Inside
  // three minutes there is no such bar, so the warning arrived too late to
  // be a warning.
  const five = PC.check({ms: ny(9, 55), risk: 200, reward: 400, balance: 100000});
  check("the 09:55 bar catches the ten o'clock slot", PC.holds(five), words(five));
  const early = PC.check({ms: ny(9, 50), risk: 200, reward: 400, balance: 100000});
  check("but the one before it does not", !PC.holds(early), words(early));
  const after = PC.check({ms: ny(8, 31), risk: 200, reward: 400, balance: 100000});
  check("a minute after is not", !PC.holds(after), words(after));
  const ten = PC.check({ms: ny(9, 58), risk: 200, reward: 400, balance: 100000});
  check("10:00 is a slot too", PC.holds(ten), words(ten));
}

console.log("\nsize is arithmetic and does not need a record");
{
  const big = PC.check({ms: ny(11, 0), risk: 2500, reward: 5000, balance: 100000});
  check("two and a half percent is held", PC.holds(big), words(big));
  const mid = PC.check({ms: ny(11, 0), risk: 1200, reward: 2400, balance: 100000});
  check("one and a bit percent is a note, not a block",
        mid.length === 1 && !PC.holds(mid), words(mid));
  const small = PC.check({ms: ny(11, 0), risk: 400, reward: 800, balance: 100000});
  check("under one percent says nothing", small.length === 0, words(small));
  const none = PC.check({ms: ny(11, 0), risk: 2500, reward: 5000, balance: null});
  check("with no account to measure against, it does not guess",
        !PC.holds(none), words(none));
}

console.log("\nrisking more than the target pays");
{
  const l = PC.check({ms: ny(11, 0), risk: 400, reward: 200, balance: 100000});
  check("it is mentioned", /Risking more/.test(words(l)), words(l));
  check("but not blocked, because it can be deliberate", !PC.holds(l));
}

console.log("\na run of losses");
{
  const two = PC.check({ms: ny(11, 0), risk: 200, reward: 400, balance: 100000,
                        today: [{pnl: -100}, {pnl: -100}]});
  check("two is a note", two.length === 1 && !PC.holds(two), words(two));
  const three = PC.check({ms: ny(11, 0), risk: 200, reward: 400, balance: 100000,
                          today: [{pnl: -100}, {pnl: -100}, {pnl: -100}]});
  check("three is held", PC.holds(three), words(three));
  const mixed = PC.check({ms: ny(11, 0), risk: 200, reward: 400, balance: 100000,
                          today: [{pnl: -100}, {pnl: 500}, {pnl: -100}]});
  check("winners in between do not count as losses",
        !PC.holds(mixed), words(mixed));
}

console.log("\nthe session it is actually traded in");
{
  const early = PC.check({ms: ny(8, 0), risk: 200, reward: 400, balance: 100000});
  check("before the open is a note", /not opened yet/.test(words(early)), words(early));
  check("and says it in hours when it is hours",
        /by 2 hours/.test(words(early)), words(early));
  const soon = PC.check({ms: ny(9, 0), risk: 200, reward: 400, balance: 100000});
  check("and in minutes when it is minutes",
        /by 30 minutes/.test(words(soon)), words(soon));
  check("and not a block", !PC.holds(early), words(early));
  const late = PC.check({ms: ny(16, 30), risk: 200, reward: 400, balance: 100000});
  check("after the close is a note", /has closed/.test(words(late)), words(late));
}

console.log("\nwhat must never be on the list");
{
  // Replaying the eleven flagged trades put this at six dollars a trade
  // inside a seven hundred dollar swing. Putting it on a checklist would be
  // this app contradicting its own evidence.
  const every = [
    PC.check({ms: ny(8, 28), risk: 2500, reward: 200, balance: 100000,
              today: [{pnl: -1}, {pnl: -1}, {pnl: -1}]}),
    PC.check({ms: ny(11, 0), risk: 200, reward: 400, balance: 100000}),
  ].map(words).join(" | ");
  check("nothing tells him not to trail the stop",
        !/trail/i.test(every), every);
  check("nor invents a rule about structure or confluence",
        !/structure|confluence/i.test(every), every);
}

console.log("\nthe worst thing comes first, and the confirm asks about it");
{
  const l = PC.check({ms: ny(8, 28), risk: 2500, reward: 200, balance: 100000,
                      today: [{pnl: -1}, {pnl: -1}, {pnl: -1}]});
  check("holds are sorted above notes", l[0].level === "hold", l[0].level);
  const q = PC.ask(l);
  check("the question ends by asking", /Take the trade anyway\?$/.test(q));
  check("it repeats only the blocking ones",
        !/Risking more/.test(q), q.slice(0, 120));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
