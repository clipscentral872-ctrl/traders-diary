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
import {resample, bucketIndex, formingBar, stitchHours} from "../docs/series.js";

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

console.log("\nvolume adds up across a built bar");
{
  // Three five-minute bars into one fifteen: the volume is all three, not
  // the first one's or the last one's.
  const bars = fiveMin("2026-09-02T09:30:00Z", 6)
    .map((b, i) => ({...b, v: 100 * (i + 1)}));
  const out = resample(bars, 5 * MIN, 3, false);
  check("the first built bar holds all three", out[0].v === 100 + 200 + 300,
        String(out[0].v));
  check("and the second the next three", out[1].v === 400 + 500 + 600,
        String(out[1].v));
  // A file with no volume stays without it, rather than showing zero.
  const none = resample(fiveMin("2026-09-02T09:30:00Z", 3), 5 * MIN, 3, false);
  check("no volume in, none out", none[0].v == null, String(none[0].v));
}

console.log("\na candle forms from the bars played so far");
{
  const fine = fiveMin("2026-09-02T09:30:00Z", 9)
    .map((b, i) => ({...b, h: b.h + (i === 1 ? 10 : 0), v: 10 * (i + 1)}));
  const coarse = resample(fine, 5 * MIN, 3, false);
  const idx = bucketIndex(fine, coarse);
  check("each five minute bar knows its quarter hour",
        Array.from(idx).join() === "0,0,0,1,1,1,2,2,2", Array.from(idx).join());
  const one = formingBar(fine, idx, 0, coarse[0].ms);
  check("after one bar the candle is that bar",
        one.o === fine[0].o && one.h === fine[0].h && one.l === fine[0].l
        && one.c === fine[0].c && one.v === 10, JSON.stringify(one));
  const two = formingBar(fine, idx, 1, coarse[0].ms);
  check("after two it has the second bar's high and close",
        two.h === fine[1].h && two.c === fine[1].c && two.o === fine[0].o
        && two.v === 30, JSON.stringify(two));
  // Once its last bar is in, the forming candle is the finished one.
  let same = true;
  for (const j of [2, 5, 8]) {
    const f = formingBar(fine, idx, j, coarse[idx[j]].ms);
    const c = coarse[idx[j]];
    if (!(f.ms === c.ms && f.o === c.o && f.h === c.h && f.l === c.l
          && f.c === c.c && f.v === c.v)) same = false;
  }
  check("and when its bucket is complete it is the finished bar", same);
  const mid = formingBar(fine, idx, 4, coarse[1].ms);
  check("a candle in the middle starts at its own bucket, not the one before",
        mid.o === fine[3].o && mid.c === fine[4].c, JSON.stringify(mid));
}

console.log("\nthe hour is stitched from the finest bars held");
{
  const HOUR = 60 * MIN;
  const t0 = Date.parse("2026-09-01T10:00:00Z");
  const h1 = [];
  for (let i = 0; i < 6; i++)
    h1.push({ms: t0 + i * HOUR, o: 1, h: 2, l: 0, c: 1, v: 1});
  // Five minute bars from 12:20, part way into an hour.
  const m5 = [];
  for (let i = 0; i < 40; i++) {
    const v = 100 + i;
    m5.push({ms: t0 + 2 * HOUR + 20 * MIN + i * 5 * MIN, o: v, h: v + 1, l: v - 1, c: v, v: 2});
  }
  const {fine, hours, split} = stitchHours(h1, m5);
  check("the split is the first whole hour of five minute bars",
        split === t0 + 3 * HOUR, new Date(split).toISOString());
  check("hours before it come from the hourly file",
        hours.slice(0, 3).every(b => b.o === 1) && hours[2].ms === t0 + 2 * HOUR,
        JSON.stringify(hours.slice(0, 3)));
  check("hours after it are built from five minutes",
        hours[3].ms === t0 + 3 * HOUR && hours[3].o === m5[8].o
        && hours[3].c === m5[19].c && hours[3].v === 24,
        JSON.stringify(hours[3]));
  check("the fine bars are hours, then five minutes, in order",
        fine.length === 3 + 32 && fine[2].o === 1 && fine[3].ms === split
        && fine.every((b, i) => i === 0 || b.ms > fine[i - 1].ms));
  const idx = bucketIndex(fine, hours);
  check("an old hour is its own fine bar, a new one owns twelve",
        idx[2] === 2 && idx[3] === 3 && idx[14] === 3 && idx[15] === 4,
        Array.from(idx).slice(0, 16).join());
  const none = stitchHours(h1, []);
  check("with no five minute bars it is the hourly file",
        none.fine === h1 && none.hours === h1);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
