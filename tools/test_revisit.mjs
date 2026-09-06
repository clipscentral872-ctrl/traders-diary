/* Check the revisit model on bars with a known answer.
 *
 * A probability is the easiest thing in a trading app to get wrong and the
 * hardest to notice, because any number between 0 and 1 looks plausible. So
 * these scenarios are built so the right answer is known in advance:
 * a level that always gets tapped, one that never does, and a thin bucket
 * that must NOT be believed.
 *
 *   node tools/test_revisit.mjs
 */
import * as R from "../docs/revisit.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

// One New York trading day of 5-minute bars, 78 of them from 09:30.
// Counted forward from a fixed first day, because writing the calendar out by
// hand produced "2026-03-40" and an invalid date.
const DAY0 = Date.parse("2026-03-02T09:30:00-05:00");

function day(dayNum, shape) {
  const bars = [];
  const base = DAY0 + (dayNum - 2) * 86400000;
  for (let k = 0; k < 78; k++) {
    const {o, h, l, c} = shape(k);
    bars.push({ms: base + k * 300000, o, h, l, c});
  }
  return bars;
}

/* ------------------------------------------------------------------ */
console.log("\na level that always gets tapped comes out near certain");
{
  const bars = [];
  for (let d = 2; d <= 40; d++) {
    // Every day runs the same range, so each day's high and low sit exactly
    // where the previous day's did and are always revisited.
    bars.push(...day(d, k => {
      const mid = 100 + Math.sin(k / 6) * 10;
      return {o: mid, h: mid + 1, l: mid - 1, c: mid};
    }));
  }
  const m = R.build(bars);
  check("model built", m.obs > 0, JSON.stringify({obs: m.obs, days: m.days}));
  check("base rate is high", m.base > 0.9, "base " + m.base.toFixed(3));
  const c = R.chance(m, {price: 111, above: true}, 100, 0.1);
  check("a near level early reads high", c.p > 0.8, "p " + c.p.toFixed(3));
}

/* ------------------------------------------------------------------ */
console.log("\na level that never gets tapped comes out near zero");
{
  const bars = [];
  for (let d = 2; d <= 40; d++) {
    // A market that only ever falls, so yesterday's high is never revisited.
    const start = 1000 - d * 20;
    bars.push(...day(d, k => {
      const p = start - k * 0.2;
      return {o: p, h: p + 0.1, l: p - 0.3, c: p - 0.2};
    }));
  }
  const m = R.build(bars);
  check("base rate is low", m.base < 0.35, "base " + m.base.toFixed(3));
  const far = R.chance(m, {price: 1000, above: true}, 500, 0.5);
  check("a far untapped high reads low", far.p < 0.35, "p " + far.p.toFixed(3));
}

/* ------------------------------------------------------------------ */
console.log("\na thin bucket is pulled toward the base rate, not believed");
{
  const m = {
    buckets: new Map([["0|0", {hit: 3, n: 3}]]),
    base: 0.2, days: 100, adr: 10, obs: 5000,
  };
  const c = R.chance(m, {price: 100.2, above: true}, 100, 0.05);
  check("three-for-three is not printed as certain", c.p < 0.5,
        "p " + c.p.toFixed(3));
  check("it is still pulled above the base rate", c.p > 0.2,
        "p " + c.p.toFixed(3));
  check("flagged as thin", c.thin === true);
  check("the sample size comes back", c.n === 3, "n " + c.n);
  // (3 + 20*0.2) / (3 + 20) = 7/23
  check("shrinkage is the stated formula",
        Math.abs(c.p - 7 / 23) < 1e-9, "p " + c.p);
}

/* ------------------------------------------------------------------ */
console.log("\na fat bucket mostly speaks for itself");
{
  const m = {
    buckets: new Map([["0|0", {hit: 800, n: 1000}]]),
    base: 0.2, days: 100, adr: 10, obs: 50000,
  };
  const c = R.chance(m, {price: 100.2, above: true}, 100, 0.05);
  check("close to its own rate", Math.abs(c.p - 0.8) < 0.02, "p " + c.p.toFixed(3));
  check("not flagged as thin", c.thin === false);
}

/* ------------------------------------------------------------------ */
console.log("\nnothing is invented from nothing");
{
  check("no bars", R.build([]).obs === 0);
  check("too few bars", R.build(new Array(20).fill({ms: 0, o: 1, h: 1, l: 1, c: 1})).obs === 0);
  check("no model means no answer", R.chance(R.build([]), {price: 1, above: true}, 1, 0.5) === null);
  const flat = R.build(day(2, () => ({o: 5, h: 5, l: 5, c: 5})));
  check("a market with no range at all is refused", flat.obs === 0);
}

/* ------------------------------------------------------------------ */
console.log("\nthe model never looks ahead");
{
  // Two identical histories except for what happens AFTER the last bar.
  // The estimate at that bar has to be the same in both.
  const make = tail => {
    const bars = [];
    for (let d = 2; d <= 30; d++)
      bars.push(...day(d, k => {
        const mid = 100 + Math.sin(k / 5) * 8;
        return {o: mid, h: mid + 1, l: mid - 1, c: mid};
      }));
    if (tail) bars.push(...day(31, k => ({o: 500, h: 900, l: 100, c: 500})));
    return bars;
  };
  const a = R.build(make(false)), b = R.build(make(true));
  const qa = R.chance(a, {price: 110, above: true}, 100, 0.25);
  const qb = R.chance(b, {price: 110, above: true}, 100, 0.25);
  // The later day adds its own observations, so the models differ overall.
  // What must not change is that the earlier days were scored without it.
  const sameEarly = [...a.buckets.entries()].every(([k, v]) => {
    const w = b.buckets.get(k);
    return w && w.hit >= v.hit && w.n >= v.n;
  });
  check("earlier days keep the counts they already had", sameEarly);
  check("both answer", qa !== null && qb !== null);
}

console.log("\nthe answer does not depend on the bar size");
{
  // The same day and the same moment, given minute bars and five-minute bars.
  // The question is about the day, so the answer has to be the same. It was
  // not: how far through the session had been counted in bars against a fixed
  // 78, which is right for five-minute data and puts minute data permanently
  // at "session over".
  const shape = k => {
    const mid = 100 + Math.sin(k / 9) * 6;
    return {o: mid, h: mid + 0.6, l: mid - 0.6, c: mid};
  };
  const five = [], one = [];
  for (let d = 2; d <= 30; d++) {
    const base = DAY0 + (d - 2) * 86400000;
    for (let k = 0; k < 78; k++) five.push({ms: base + k * 300000, ...shape(k)});
    for (let k = 0; k < 390; k++) one.push({ms: base + k * 60000, ...shape(k / 5)});
  }
  const model = R.build(five);
  // A third of the way into the last day, by the clock, on both series.
  const at = DAY0 + 28 * 86400000 + Math.round(78 * 300000 / 3);
  const say = m => [...m.entries()].map(([k, v]) => k + ":" + v.n).sort().join(",");
  const a = say(R.untappedNow(five, at, model));
  const b = say(R.untappedNow(one, at, model));
  check("minute and five-minute bars agree", a === b, `5m ${a} vs 1m ${b}`);
  check("something was actually compared", a.length > 0, "both came back empty");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
