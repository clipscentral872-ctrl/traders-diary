/* Check the chart's scales land on round numbers, the way TradingView's do.
 *
 * The price labels used to be spaced evenly across whatever range happened
 * to be on screen, so they read 29,612.74 and 29,565.25. The time scale
 * printed a first time and a last time and nothing between. A scale is read
 * by its round numbers, so that is what these check.
 *
 *   node tools/test_chart.mjs
 */
import {niceStep, priceTicks, timeEvery} from "../docs/chart.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`
    + (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

console.log("\na step is always a round number");
check("3.7 becomes 5", niceStep(3.7), 5);
check("1.9 becomes 2", niceStep(1.9), 2);
check("2.3 becomes 2.5", niceStep(2.3), 2.5);
check("12 becomes 20", niceStep(12), 20);
check("0.37 becomes 0.5", niceStep(0.37), 0.5);
check("100 stays 100", niceStep(100), 100);
check("nothing sensible still gives a step", niceStep(0), 1);

console.log("\nprice labels sit on round prices, inside the range");
{
  // The range from the screenshot: the old scale labelled it 29,453.81,
  // 29,506.79, 29,559.76 and so on.
  const lo = 29453.81, hi = 29718.69;
  const t = priceTicks(lo, hi, 6);
  const step = t[1] - t[0];
  check("every label is a multiple of the step",
        t.every(v => Math.abs(v / step - Math.round(v / step)) < 1e-9), true);
  check("and the step is round", [10, 20, 25, 50, 100].includes(step), true);
  check("none falls outside the range", t.every(v => v >= lo && v <= hi), true);
  check("and there are about as many as asked for",
        t.length >= 4 && t.length <= 8, true);
}
{
  // NQ zoomed in, the range at 0:34 of Chris's recording. TradingView
  // labelled it in fours; this scale uses fives, which read just as round.
  // What matters is that the labels tighten as you zoom, and stay round.
  const t = priceTicks(29406, 29462, 14);
  check("zoomed in, the labels tighten to fives", t.slice(0, 3), [29410, 29415, 29420]);
}
{
  // Small steps are counted, not added, so they do not drift.
  check("a run of 0.05s stays exact", priceTicks(1.1, 1.3, 4), [1.1, 1.15, 1.2, 1.25, 1.3]);
}

console.log("\ntime labels land on round intervals");
check("five-minute bars, labels 14 bars apart: every two hours",
      timeEvery(5, 14), 120);
check("five-minute bars, labels 3 bars apart: every quarter hour",
      timeEvery(5, 3), 15);
check("hourly bars, 2 apart: every two hours", timeEvery(60, 2), 120);
check("minute bars, every bar room for one: every minute", timeEvery(1, 1), 1);
check("far out on four-hour bars: once a day", timeEvery(240, 10), 1440);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
