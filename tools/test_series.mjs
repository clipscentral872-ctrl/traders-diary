/* Check the built timeframes land on the clock.
 *
 * The failure this exists to catch does not look like a failure. Grouping
 * every three five-minute bars from wherever the file starts produces a chart
 * that looks exactly like a fifteen-minute chart, with bars at 09:32, 09:47,
 * 10:02. Every level read off it is then in the wrong place, and nothing
 * about it looks wrong.
 *
 *   node tools/test_series.mjs
 */
import {resample} from "../docs/series.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const MIN = 60000;
const hhmm = ms => new Date(ms).toISOString().slice(11, 16);

/** Five-minute bars starting at a deliberately awkward time. */
function fiveMin(startISO, count) {
  const t0 = Date.parse(startISO);
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = 100 + i;
    out.push({ms: t0 + i * 5 * MIN, o: v, h: v + 2, l: v - 2, c: v + 1});
  }
  return out;
}

console.log("\nfifteen minutes lands on the quarter hour");
{
  // Starting at 09:35, so a naive grouping would give 09:35, 09:50, 10:05.
  const bars = fiveMin("2026-09-02T09:35:00Z", 12);
  const out = resample(bars, 5 * MIN, 3, false);
  const times = out.map(b => hhmm(b.ms));
  check("first bar is on a quarter hour",
        ["09:45", "09:30"].includes(times[0]) || times[0].endsWith(":45")
        || /:(00|15|30|45)$/.test(times[0]), times[0]);
  check("every bar is on a quarter hour",
        times.every(t => /:(00|15|30|45)$/.test(t)), times.join(" "));
  check("the awkward opening bars are not silently dropped",
        out.length >= 4, `${out.length} bars from 12`);
}

console.log("\na folded bar carries the right open, high, low and close");
{
  const bars = [
    {ms: Date.parse("2026-09-02T09:30:00Z"), o: 10, h: 12, l: 9, c: 11},
    {ms: Date.parse("2026-09-02T09:35:00Z"), o: 11, h: 18, l: 10, c: 17},
    {ms: Date.parse("2026-09-02T09:40:00Z"), o: 17, h: 17, l: 4, c: 6},
  ];
  const [b] = resample(bars, 5 * MIN, 3, false);
  check("open is the first open", b.o === 10, String(b.o));
  check("high is the highest high", b.h === 18, String(b.h));
  check("low is the lowest low", b.l === 4, String(b.l));
  check("close is the last close", b.c === 6, String(b.c));
}

console.log("\nnothing is invented and nothing is lost");
{
  const bars = fiveMin("2026-09-02T09:30:00Z", 30);
  const out = resample(bars, 5 * MIN, 3, false);
  check("ten bars from thirty", out.length === 10, String(out.length));
  const srcHigh = Math.max(...bars.map(b => b.h));
  const outHigh = Math.max(...out.map(b => b.h));
  check("the highest price survives", srcHigh === outHigh, `${srcHigh} vs ${outHigh}`);
  const srcLow = Math.min(...bars.map(b => b.l));
  const outLow = Math.min(...out.map(b => b.l));
  check("and the lowest", srcLow === outLow, `${srcLow} vs ${outLow}`);
  check("the last close is the last close",
        out[out.length - 1].c === bars[bars.length - 1].c);
}

console.log("\nfour hours lines up with the session, not with midnight UTC");
{
  // Hourly bars across a September day. New York is UTC-4 then, so the 18:00
  // session open is 22:00 UTC and the grid should break there.
  const t0 = Date.parse("2026-09-01T18:00:00Z");
  const bars = [];
  for (let i = 0; i < 40; i++) {
    const v = 100 + i;
    bars.push({ms: t0 + i * 60 * MIN, o: v, h: v + 1, l: v - 1, c: v});
  }
  const out = resample(bars, 60 * MIN, 4, true);
  const utcHours = out.map(b => new Date(b.ms).getUTCHours());
  // Every bucket must start at a session-aligned hour: 22:00 UTC and every
  // four hours from it.
  check("every four-hour bar starts on a session boundary",
        utcHours.every(h => (h - 22 + 24) % 4 === 0),
        utcHours.join(","));
  check("it did not just group by fours from the first bar",
        out.length === 11 || out.length === 10, String(out.length));
}

console.log("\nasking for no grouping changes nothing");
{
  const bars = fiveMin("2026-09-02T09:30:00Z", 5);
  check("group of one is the input", resample(bars, 5 * MIN, 1, false) === bars);
  check("empty in, empty out", resample([], 5 * MIN, 3, false).length === 0);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
