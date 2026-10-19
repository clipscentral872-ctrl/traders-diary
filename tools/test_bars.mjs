/* Check what a trade stores about its own candles.
 *
 * Invented bars, because this repository is public and the record is not.
 * The shapes are what matter here anyway: how far either side of a trade
 * each window reaches, and which candle the entry is marked on.
 *
 *   node tools/test_bars.mjs
 */
import * as E from "../docs/engine.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`
    + (ok ? "" : `\n        got  ${JSON.stringify(got)}`
                 + `\n        want ${JSON.stringify(want)}`));
};

/* The two windows a trade carries.
 *
 * The tight one is what the video films and is deliberately short. The wide
 * one is what the Diary opens on, and it exists because a chart holding
 * exactly what it shows has nowhere to go when you drag it. Both are
 * checked here because the entry marker used to be placed by matching the
 * bar whose label equalled the entry minute, which on a five minute chart
 * never matches: an entry at 09:51 belongs to the 09:50 candle, and a miss
 * put the marker on the first candle on screen.
 */
{
  console.log("\nthe candles a trade keeps");
  const t0 = Date.parse("2026-01-05T14:00:00Z");
  const series = (stepMin, n) => Array.from({length: n}, (_, i) => ({
    ms: t0 + i * stepMin * 60000,
    o: 100 + i * 0.1, h: 100.5 + i * 0.1, l: 99.5 + i * 0.1, c: 100.2 + i * 0.1,
  }));
  const minute = series(1, 600), five = series(5, 120);
  // Entry at 18:00, out at 18:06, with the clock told it is already UTC.
  const t = {symbol: "NQ", open_t: "2026-01-05 18:00:00",
             close_t: "2026-01-05 18:06:00"};

  check("the first pass attaches something", E.attachBars(t, minute, 0, five), true);
  check("the tight window is ten minutes before and thirty after",
        t.bars.length, E.PAD_BEFORE + 6 + E.PAD_AFTER + 1);
  check("the entry sits where the entry was", t.bars[t.entry_i].t, "18:00");
  check("and the exit where the exit was", t.bars[t.exit_i].t, "18:06");

  check("the wide window is four hours either side",
        t.ctx.length, (E.CTX_BEFORE + E.CTX_AFTER + 5) / 5 + 1);
  check("it starts four hours before the entry", t.ctx[0].t, "14:00");
  check("the entry lands on its own five minute candle",
        t.ctx[t.ctx_entry_i].t, "18:00");

  // An entry inside a candle rather than on its edge.
  const mid = {symbol: "NQ", open_t: "2026-01-05 18:03:00",
               close_t: "2026-01-05 18:09:00"};
  E.attachBars(mid, minute, 0, five);
  check("an entry at 18:03 belongs to the 18:00 candle",
        mid.ctx[mid.ctx_entry_i].t, "18:00");

  check("a second pass does no work", E.attachBars(t, minute, 0, five), false);

  // A trade the five minute series cannot cover is not marked as finished,
  // so it picks the wide window up once those bars are published.
  const lonely = {symbol: "NQ", open_t: "2026-01-05 18:00:00",
                  close_t: "2026-01-05 18:06:00"};
  E.attachBars(lonely, minute, 0, []);
  check("no wide window means no version stamp", lonely.bars_v, undefined);
  check("and it fills in once the five minute bars arrive",
        E.attachBars(lonely, minute, 0, five), true);
  check("which gives it the wide window", lonely.ctx.length > 90, true);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
