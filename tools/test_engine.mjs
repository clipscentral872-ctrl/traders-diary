/* Check the browser engine against the Python one, on the same real exports.
 *
 * The point of this is not that the code looks equivalent. It is that both
 * implementations, given Chris's actual TradingView files, produce the same
 * trades, the same R, the same flags and the same written notes. A port that
 * quietly disagrees is worse than no port, because the phone would then teach
 * a different lesson from the laptop.
 *
 *   node tools/test_engine.mjs <exports-folder> <python-trades.json>
 */
import fs from "node:fs";
import path from "node:path";
import * as E from "../docs/engine.js";

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error("usage: node tools/test_engine.mjs <exports-folder> <trades.json>");
  process.exit(2);
}

const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".csv"))
  .map(f => ({name: f, text: fs.readFileSync(path.join(dir, f), "utf8")}));

// The bars the Python side already attached, keyed the way the browser gets
// them, so both sides analyse the same candles and any difference is logic.
const python = JSON.parse(fs.readFileSync(ref, "utf8"))
  .filter(t => (t.source || "live") === "live");

const barsBySymbol = {};
for (const t of python) {
  if (!t.bars) continue;
  const feed = E.FEED[t.symbol];
  const day = t.open_t.slice(0, 10);
  const seen = barsBySymbol[feed] || (barsBySymbol[feed] = new Map());
  for (const b of t.bars) {
    const ms = Date.parse(day + "T" + b.t + ":00Z") - 2 * 3600e3;
    if (!seen.has(ms)) seen.set(ms, {ms, o: b.o, h: b.h, l: b.l, c: b.c});
  }
}
for (const k of Object.keys(barsBySymbol))
  barsBySymbol[k] = [...barsBySymbol[k].values()].sort((a, b) => a.ms - b.ms);

const out = E.ingest(files, [], barsBySymbol, 2);

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`
    + (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

console.log(`\nreading ${files.length} export files against ${python.length} Python trades`);
check("same number of trades", out.trades.length, python.length);
check("the broker's own export agrees", out.gaps, []);
check("nothing left open", out.stillOpen, []);

const money = a => Math.round(a.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
check("same total P&L", money(out.trades), money(python));

const key = t => t.symbol + " " + t.open_t;
for (let i = 0; i < Math.min(out.trades.length, python.length); i++) {
  const a = out.trades[i], b = python[i];
  const tag = key(b);
  check(tag + " entry", a.entry, b.entry);
  check(tag + " exit", a.exit, b.exit);
  check(tag + " qty", a.qty, b.qty);
  check(tag + " P&L", a.pnl, b.pnl);
  check(tag + " stop", a.stop ?? null, b.stop ?? null);
  check(tag + " target", a.target ?? null, b.target ?? null);
  check(tag + " R", a.got_r ?? null, b.got_r ?? null);
  check(tag + " planned R", a.planned_rr ?? null, b.planned_rr ?? null);
  check(tag + " held minutes", a.held_min, b.held_min);
  check(tag + " MFE", a.mfe_r ?? null, b.mfe_r ?? null);
  check(tag + " MAE", a.mae_r ?? null, b.mae_r ?? null);
  check(tag + " kept %", a.kept_pct ?? null, b.kept_pct ?? null);
  check(tag + " flags", [...a.flags].sort(), [...b.flags].sort());
  check(tag + " note", a.note, b.note);
}

const sa = E.summarise(out.trades);
console.log(`\n  ${sa.trades} trades, $${sa.pnl.toLocaleString()}, `
  + `${sa.win_rate.toFixed(1)}% win rate, `
  + `expectancy ${sa.expectancy_r === null ? "none" : sa.expectancy_r.toFixed(3) + "R"} `
  + `over the ${sa.scored} with an R`);

console.log("\nimporting the same session again says the same thing");
{
  /* Chris imports on top of what is already there, every session, so the
   * SECOND ingest is the normal case rather than the odd one.
   *
   * withBars used to count what attachBars had just done, and attachBars
   * does nothing and returns false for a trade that already has its candles.
   * So a re-import reported every healthy trade as undrawable: sixteen
   * trades with charts, and a line saying sixteen could not be drawn
   * because the published bars only reach back ten days. */
  const again = E.ingest(files, out.trades, barsBySymbol, 2);
  const haveBars = again.trades.filter(t => t.bars && t.bars.length).length;
  check("nothing is added the second time", again.added, 0);
  check("the same trades are there", again.trades.length, out.trades.length);
  check("and the drawable count is what is actually drawable",
         again.withBars, haveBars);
  check("which is the same as the first time", again.withBars, out.withBars);
}

console.log("\na later, fuller activity log repairs trades already here");
{
  /* How Chris actually imports: a session at a time, often mid-session, so
   * the early trades arrive before the activity log that holds their stop.
   * Imported in one go these files give 13 of 16 trades an R. Imported in
   * pieces they gave 7, because a trade already present was skipped and the
   * fuller log that arrived later was thrown away. */
  const thin = files.filter(f => !/activity-log/i.test(f.name)
                                 || /2026-09-04/.test(f.name));
  const first = E.ingest(thin, [], barsBySymbol, 2);
  const withR = ts => ts.filter(t => t.got_r != null).length;
  const before = withR(first.trades);
  check("the thin import really is missing stops", before < withR(out.trades), true);

  /* Something only the stored trade has: the note Chris typed into it.
   *
   * Put on a trade that the fuller log DOES repair. The first version of
   * this test took the first trade with no R, which turned out to be one of
   * the three with no stop in any file, so nothing ever touched it and the
   * note survived by being ignored. That proved nothing about a repair. */
  const fullR = new Map(out.trades.map(t => [t.symbol + "|" + t.open_t, t.got_r]));
  const noted = first.trades.find(t => t.got_r == null
    && fullR.get(t.symbol + "|" + t.open_t) != null);
  check("there is a trade the fuller log repairs", !!noted, true);
  noted.mine = "saw the sweep, entered too early";

  const second = E.ingest(files, first.trades, barsBySymbol, 2);
  check("nothing new is added", second.added, 0);
  check("the repair is counted", second.repaired, withR(out.trades) - before);
  check("and ends where a single full import ends",
        withR(second.trades), withR(out.trades));
  check("with the same R on every trade",
        second.trades.map(t => t.got_r), out.trades.map(t => t.got_r));
  const kept = second.trades.find(t => t.symbol === noted.symbol
                                        && t.open_t === noted.open_t);
  check("that trade was repaired", kept.got_r != null, true);
  check("and the note you typed on it is still there", kept.mine,
        "saw the sweep, entered too early");

  // A stop already on record is never replaced, even by a longer log.
  const third = E.ingest(files, second.trades, barsBySymbol, 2);
  check("importing once more changes nothing", third.repaired, 0);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
