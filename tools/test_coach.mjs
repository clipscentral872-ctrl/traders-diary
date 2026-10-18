/**
 * Does the coach find what is there, and keep quiet about what is not?
 *
 * The danger with a feature like this is not that it misses something. It is
 * that it invents a pattern out of four trades and says it with a percentage
 * beside it. So the first thing tested is silence: given a thin record it
 * must say what it is waiting for rather than what it thinks.
 *
 * Then the finding Chris asked for by name. A record built so the stop is
 * provably the problem, tight stops hit and wide ones not, has to produce
 * that finding and a wider number to use.
 *
 * The numbers are invented. This repository is public.
 *
 *   node tools/test_coach.mjs
 */
import {lessons} from "../docs/coach.js";
import * as C from "../docs/clock.js";

C.setZone("America/New_York");
C.setExportOffset(() => -4);

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

let n = 0;
/** One trade. Defaults to a clean 20 point MNQ long that won. */
const t = (over = {}) => {
  n++;
  const day = String(4 + (n % 20)).padStart(2, "0");
  return {
    symbol: "MNQ", side: "Long", qty: 2, source: "live",
    open_t: `2026-10-${day} 10:0${n % 10}:00`,
    close_t: `2026-10-${day} 11:0${n % 10}:00`,
    entry: 25000, exit: 25040, pnl: 160, stop: 24980,
    risk_pts: 20, planned_rr: 2, got_r: 2, exit_type: "Limit", flags: [],
    ...over,
  };
};
const find = (r, id) => [...r.ready, ...r.waiting].find(l => l.id === id);

console.log("\nit refuses to speak from a handful of trades");
{
  const r = lessons([t(), t(), t()]);
  check("nothing is reported as a finding", r.ready.length === 0,
        JSON.stringify(r.ready.map(l => l.id)));
  check("and it says what it is waiting for", r.waiting.length > 0);
  const stop = find(r, "stop-distance");
  check("naming the number it needs", /of the 12 this needs/.test(stop.finding),
        stop.finding);
}

console.log("\nthe finding he asked for: the stop is the problem");
{
  const list = [];
  // Eight tight stops, nearly all hit.
  for (let i = 0; i < 8; i++)
    list.push(t({risk_pts: 20, stop: 24980,
                 exit: i < 7 ? 24980 : 25040,
                 pnl: i < 7 ? -80 : 160,
                 got_r: i < 7 ? -1 : 2,
                 exit_type: i < 7 ? "Stop" : "Limit"}));
  // Eight wide stops, nearly all survived.
  for (let i = 0; i < 8; i++)
    list.push(t({risk_pts: 45, stop: 24955,
                 exit: i < 2 ? 24955 : 25090,
                 pnl: i < 2 ? -180 : 360,
                 got_r: i < 2 ? -1 : 2,
                 exit_type: i < 2 ? "Stop" : "Limit"}));

  const l = find(lessons(list), "stop-distance");
  check("it is reported as a finding", l.evidence.length > 0);
  check("and names the noise", /inside the noise/.test(l.title), l.title);
  check("with both groups' hit rates", l.evidence.length >= 2,
        JSON.stringify(l.evidence));
  check("and tells him to size down to pay for the wider stop",
        /size down/.test(l.suggestion), l.suggestion);
}

console.log("\nand it does not cry wolf when the stop is fine");
{
  const list = [];
  for (let i = 0; i < 8; i++)
    list.push(t({risk_pts: 20, exit_type: i < 4 ? "Stop" : "Limit",
                 got_r: i < 4 ? -1 : 2, pnl: i < 4 ? -80 : 160}));
  for (let i = 0; i < 8; i++)
    list.push(t({risk_pts: 45, exit_type: i < 3 ? "Stop" : "Limit",
                 got_r: i < 3 ? -1 : 2, pnl: i < 3 ? -180 : 360}));
  const l = find(lessons(list), "stop-distance");
  check("it says the distance is not the problem",
        /No, as far as this can tell/.test(l.finding), l.finding);
}

console.log("\nthe proper answer, from the candles");
{
  const list = [];
  // Stopped out at 20 points, but price only ran 30 to 38 past the entry.
  for (let i = 0; i < 8; i++)
    list.push(t({risk_pts: 20, exit_type: "Stop", got_r: -1, pnl: -80,
                 mae_r: -(30 + i) / 20}));
  const l = find(lessons(list), "stop-mae");
  check("it reads the excursion", l.evidence.length > 0, JSON.stringify(l));
  check("and says a wider stop would have survived",
        /wider stop would have survived/.test(l.title), l.title);
  check("naming a distance to use", /points? would have stayed in/.test(l.suggestion)
        || /\d+ points/.test(l.suggestion), l.suggestion);
  check("and the size that pays for it", /MNQ/.test(l.suggestion), l.suggestion);

  // The same shape where the stop was already outside the noise.
  const fine = [];
  for (let i = 0; i < 8; i++)
    fine.push(t({risk_pts: 60, exit_type: "Stop", got_r: -1, pnl: -240,
                 mae_r: -(61 + i) / 60}));
  const ok = find(lessons(fine), "stop-mae");
  check("and when it is already wide enough it says so",
        /where it should be/.test(ok.title), ok.title);
}

console.log("\nthe rest of the record");
{
  const list = [];
  for (let i = 0; i < 8; i++)
    list.push(t({side: "Long", got_r: 2, pnl: 160}));
  for (let i = 0; i < 8; i++)
    list.push(t({side: "Short", got_r: -1, pnl: -80, exit_type: "Stop"}));
  const r = lessons(list);
  const d = find(r, "direction");
  check("a weak side is named", /weaker side/.test(d.title), d.title);
  check("with both sides' numbers", d.evidence.length === 2);

  // Trades before the open against trades after it.
  const hours = [];
  for (let i = 0; i < 8; i++)
    hours.push(t({open_t: `2026-10-1${i % 5} 06:30:00`, pnl: -120, got_r: -1,
                  exit_type: "Stop"}));
  for (let i = 0; i < 8; i++)
    hours.push(t({open_t: `2026-10-1${i % 5} 10:30:00`, pnl: 160}));
  const h = find(lessons(hours), "hour");
  check("the part of the session that costs money is named",
        /costing you/.test(h.title), h.title);
  check("and for before the open it says why",
        /built on the New York open/.test(h.suggestion), h.suggestion);
}

console.log("\nevery lesson says how many trades it stands on");
{
  const list = [];
  for (let i = 0; i < 20; i++) list.push(t());
  const r = lessons(list);
  check("a count on every one",
        [...r.ready, ...r.waiting].every(l => typeof l.n === "number"),
        JSON.stringify([...r.ready, ...r.waiting].map(l => [l.id, l.n])));
  check("and practice trades are left out",
        lessons([...list, t({source: "replay"})]).trades === 20);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
