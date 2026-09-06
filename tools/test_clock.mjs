/* Check the two clocks stay separate.
 *
 * The failure this exists to catch is quiet. Reading an export with the wrong
 * offset moves every trade by hours, and it still looks like a perfectly good
 * record: the shape is right, the numbers are right, and the times are wrong
 * in a way you would only notice by checking one against TradingView.
 *
 * The other half is daylight saving. New York is UTC-5 in January and UTC-4 in
 * July, so anything that treats it as a fixed number is right for half the
 * year and an hour out for the other half.
 *
 *   node tools/test_clock.mjs
 */
import * as C from "../docs/clock.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

console.log("\nreading a stored stamp uses the export offset, not the display zone");
{
  // Chris exports from South Africa, UTC+2. A trade stamped 15:31:56 there is
  // 13:31:56 UTC, which is 09:31:56 in New York in September.
  C.setExportOffset(2);
  C.setZone(C.NY);
  C.reset();
  const ms = C.msOf("2026-09-04 15:31:56");
  check("the instant is right",
        ms === Date.parse("2026-09-04T13:31:56Z"), new Date(ms).toISOString());
  check("and it prints as the New York time", C.hhmm(ms) === "09:31", C.hhmm(ms));
  check("on the right New York day", C.day(ms) === "2026-09-04", C.day(ms));
}

console.log("\nchanging the display zone does not change what a stamp means");
{
  C.setExportOffset(2);
  C.setZone(C.NY);
  C.reset();
  const a = C.msOf("2026-09-04 15:31:56");
  C.setZone("device");
  C.reset();
  const b = C.msOf("2026-09-04 15:31:56");
  check("the instant is unchanged", a === b, `${a} vs ${b}`);
  C.setZone(C.NY);
  C.reset();
}

console.log("\ndaylight saving is measured, not assumed");
{
  C.setZone(C.NY);
  C.reset();
  // 14:30 UTC is 09:30 in New York in July (EDT, -4) and 10:30 in December
  // (EST, -5). A fixed offset gets one of these wrong.
  const summer = Date.parse("2026-07-15T13:30:00Z");
  const winter = Date.parse("2026-12-15T14:30:00Z");
  check("summer is EDT", C.hhmm(summer) === "09:30", C.hhmm(summer));
  check("winter is EST", C.hhmm(winter) === "09:30", C.hhmm(winter));
  check("the summer offset is -240", C.zoneOffsetAt(summer) === -240,
        String(C.zoneOffsetAt(summer)));
  check("the winter offset is -300", C.zoneOffsetAt(winter) === -300,
        String(C.zoneOffsetAt(winter)));
  check("summer is named EDT", C.zoneName(summer) === "EDT", C.zoneName(summer));
  check("winter is named EST", C.zoneName(winter) === "EST", C.zoneName(winter));
}

console.log("\nthe session is bounded by the New York clock");
{
  C.setZone(C.NY);
  C.reset();
  const at = iso => Date.parse(iso);
  check("09:29 New York is not the session yet",
        !C.inRTH(at("2026-07-15T13:29:00Z")));
  check("09:30 is", C.inRTH(at("2026-07-15T13:30:00Z")));
  check("15:59 still is", C.inRTH(at("2026-07-15T19:59:00Z")));
  check("16:00 is not", !C.inRTH(at("2026-07-15T20:00:00Z")));
  check("and the overnight session is not",
        !C.inRTH(at("2026-07-15T04:00:00Z")));
  check("the same holds in winter, an hour later in UTC",
        C.inRTH(at("2026-12-15T14:30:00Z"))
        && !C.inRTH(at("2026-12-15T13:30:00Z")));
  check("09:30 is 570 minutes in", C.minutes(at("2026-07-15T13:30:00Z")) === 570,
        String(C.minutes(at("2026-07-15T13:30:00Z"))));
}

console.log("\nnothing is invented from nothing");
{
  check("no stamp, no instant", C.msOf("") === null && C.msOf(null) === null);
  check("nonsense in, null out", C.msOf("not a time") === null);
}

console.log("\nthe day boundary is the display zone's, not UTC's");
{
  C.setZone(C.NY);
  C.reset();
  // 01:00 UTC on the 5th is still the evening of the 4th in New York.
  const ms = Date.parse("2026-09-05T01:00:00Z");
  check("late evening stays on the previous day",
        C.day(ms) === "2026-09-04", C.day(ms));
  check("and prints as 21:00", C.hhmm(ms) === "21:00", C.hhmm(ms));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
