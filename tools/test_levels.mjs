/* Check the session levels against bars with a known answer.
 *
 * These lines are the ones the whole method is built on, so a level in the
 * wrong place teaches the wrong lesson very convincingly. The two things that
 * actually go wrong are tested directly: the boundaries must be New York
 * rather than UTC, and a session must not appear before it has closed.
 *
 *   node tools/test_levels.mjs
 */
import {levelsAt} from "../docs/levels.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`
    + (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

/** A bar at a given New York wall time in September, which is EDT (UTC-4). */
const at = (day, h, m, high, low) => ({
  ms: Date.parse(`2026-09-${String(day).padStart(2, "0")}`
    + `T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`),
  o: low, h: high, l: low, c: high,
});

const find = (ls, label) => {
  const m = ls.find(x => x.label === label);
  return m ? m.price : null;
};

// Wednesday evening through Thursday afternoon, New York time.
const bars = [
  at(2, 19, 0, 100, 90),     // Asia, belongs to the 3rd
  at(2, 23, 0, 105, 95),
  at(3, 1, 0, 102, 88),      // still Asia
  at(3, 4, 0, 120, 110),     // London
  at(3, 7, 0, 125, 108),
  at(3, 10, 0, 140, 130),    // New York
  at(3, 14, 0, 150, 128),
  at(3, 17, 0, 145, 135),    // after the close
];

console.log("\nasia spans midnight and belongs to the next day");
let ls = levelsAt(bars, at(3, 4, 0).ms);
check("asia high is the whole 18:00-03:00 range", find(ls, "Asia High"), 105);
check("asia low likewise", find(ls, "Asia Low"), 88);

console.log("\na session that has not closed is not drawn");
check("london is not shown at 04:00", find(ls, "London High"), null);
ls = levelsAt(bars, at(3, 10, 0).ms);
check("london appears once 08:30 has passed", find(ls, "London High"), 125);
check("london low too", find(ls, "London Low"), 108);
check("new york is not shown at 10:00", find(ls, "New York High"), null);

console.log("\nnew york appears only after 16:00");
ls = levelsAt(bars, at(3, 14, 0).ms);
check("still hidden at 14:00", find(ls, "New York High"), null);
ls = levelsAt(bars, at(3, 17, 0).ms);
check("shown at 17:00", find(ls, "New York High"), 150);
check("and its low", find(ls, "New York Low"), 128);

console.log("\nthe boundaries are New York, not UTC");
// 03:30 New York is 07:30 UTC. Read as UTC, this bar would land in Asia.
const tz = [at(2, 20, 0, 100, 90), at(3, 3, 30, 200, 190), at(3, 9, 0, 50, 40)];
ls = levelsAt(tz, at(3, 9, 0).ms);
check("the 03:30 bar counted as London, not Asia", find(ls, "London High"), 200);
check("asia is unaffected by it", find(ls, "Asia High"), 100);

console.log("\nprevious day, not today");
ls = levelsAt(bars, at(3, 14, 0).ms);
check("prev day high is the 2nd only", find(ls, "Prev Day High"), 105);
check("prev day low is the 2nd only", find(ls, "Prev Day Low"), 90);

console.log("\nnothing before the first bar, and nothing from the future");
check("empty before any data", levelsAt(bars, at(2, 1, 0).ms), []);
check("no bars at all", levelsAt([], Date.now()), []);
const future = levelsAt(bars, at(3, 4, 0).ms);
check("the New York range is not leaked early",
  future.some(l => l.label.startsWith("New York")), false);

console.log("\na closed session from an earlier day says so");
// Two full days, read from inside the second day's New York session, when the
// most recent CLOSED New York range is the previous day's. Calling that
// "New York High" reads as today's, which is the one way this could mislead.
const twoDays = [
  at(2, 10, 0, 200, 190), at(2, 15, 0, 210, 180),   // 2nd, New York
  at(3, 4, 0, 120, 110),                            // 3rd, London
  at(3, 11, 0, 140, 130),                           // 3rd, New York, still open
];
ls = levelsAt(twoDays, at(3, 11, 0).ms);
check("yesterday's range is labelled Prev", find(ls, "Prev New York High"), 210);
check("and is not passed off as today's", find(ls, "New York High"), null);
check("today's low is not leaked either", find(ls, "New York Low"), null);
check("london closed today needs no Prev", find(ls, "London High"), 120);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
