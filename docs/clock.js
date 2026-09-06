/* One clock for the whole app.
 *
 * There are two different jobs here and they used to share a single number,
 * which meant getting one right made the other wrong.
 *
 *   READING a stored stamp. TradingView writes its exports in whatever local
 *   time the machine was set to and never says which, so turning
 *   "2026-09-04 15:31:56" back into a real instant needs YOUR offset. That is
 *   a property of the file, not of how you like to read a chart.
 *
 *   SHOWING a time. The session is measured in New York: the open is 09:30
 *   there, the releases are 08:30 there, and that is what your TradingView
 *   charts print. Showing 15:31 for a bar that everyone else calls 09:31 is
 *   how you end up sure a level formed at a time it did not.
 *
 * So: stamps are read with the export offset, and every time on screen is
 * printed in the display zone, which is New York unless you change it.
 *
 * New York is a zone, not an offset. It is UTC-5 in January and UTC-4 in July
 * and it changes on dates the US picks, so this leans on Intl rather than on
 * arithmetic with a fixed number.
 */

export const NY = "America/New_York";

let zone = NY;
let exportOffset = () => 2;

/** Where times are shown. "device" follows whatever the phone is set to. */
export function setZone(z) { zone = z || NY; }
export const getZone = () => zone;

/** How stored stamps are read. Set from the Settings tab. */
export function setExportOffset(fn) {
  exportOffset = typeof fn === "function" ? fn : () => fn;
}

/* Intl formatters are expensive to build and cheap to reuse, and this runs
   once per candle on a chart with thousands of them. */
const CACHE = new Map();
function fmt(opts) {
  const tz = zone === "device" ? undefined : zone;
  const key = tz + "|" + JSON.stringify(opts);
  let f = CACHE.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB",
      Object.assign({hour12: false}, tz ? {timeZone: tz} : {}, opts));
    CACHE.set(key, f);
  }
  return f;
}

/** Drop every cached formatter, after the zone changes. */
export function reset() { CACHE.clear(); NAMES.clear(); }

/**
 * The real instant behind a stored stamp.
 *
 * @param stamp "2026-09-04 15:31:56", written in the export's local time
 * @returns milliseconds, or null if there is nothing to read
 */
export function msOf(stamp) {
  if (!stamp) return null;
  const iso = String(stamp).replace(" ", "T");
  const ms = Date.parse(iso.length > 19 ? iso : iso + "Z");
  if (!Number.isFinite(ms)) return null;
  return ms - exportOffset() * 3600e3;
}

const pick = (ps, k) => ps.find(p => p.type === k).value;

/** {y, m, d, hh, mm} in the display zone. */
export function parts(ms) {
  const p = fmt({year: "numeric", month: "2-digit", day: "2-digit",
                 hour: "2-digit", minute: "2-digit"}).formatToParts(new Date(ms));
  return {y: +pick(p, "year"), m: +pick(p, "month"), d: +pick(p, "day"),
          hh: +pick(p, "hour") % 24, mm: +pick(p, "minute")};
}

/** "14:35" */
export function hhmm(ms) {
  const p = parts(ms);
  return String(p.hh).padStart(2, "0") + ":" + String(p.mm).padStart(2, "0");
}

/** "2026-09-04", the calendar day in the display zone. */
export function day(ms) {
  const p = parts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "09-04 14:35", short enough for an axis. */
export function label(ms) {
  const p = parts(ms);
  return `${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} `
       + `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** "2026-09-04 14:35" */
export const full = ms => day(ms) + " " + hhmm(ms);

/** "EDT", or "" when the zone has no short name worth printing.
 *
 *  Formatted in en-US on purpose. en-GB calls it "GMT-4", which is true and
 *  useless: nobody trading this session calls it that, and it does not say
 *  whether the clocks have gone forward. */
const NAMES = new Map();
export function zoneName(ms = Date.now()) {
  const tz = zone === "device" ? undefined : zone;
  const key = tz + "|" + Math.floor(ms / 86400000);
  if (NAMES.has(key)) return NAMES.get(key);
  let out = "";
  try {
    const f = new Intl.DateTimeFormat("en-US",
      Object.assign({hour12: false, hour: "2-digit", timeZoneName: "short"},
                    tz ? {timeZone: tz} : {}));
    const n = f.formatToParts(new Date(ms))
      .find(x => x.type === "timeZoneName");
    out = n ? n.value : "";
  } catch { out = ""; }
  NAMES.set(key, out);
  return out;
}

/**
 * Offset from UTC of the display zone at this instant, in MINUTES.
 *
 * Positive east of Greenwich, so New York in summer is -240. Measured rather
 * than assumed: it changes twice a year on dates the US picks.
 */
export function zoneOffsetAt(ms) {
  const p = parts(ms);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  // The stored instant may carry seconds the parts do not, so round to the
  // minute before differencing or a 30-second bar shifts the answer.
  return Math.round((asUTC - Math.floor(ms / 60000) * 60000) / 60000);
}

/** Minutes since midnight in the display zone. The session is measured off
 *  this: 09:30 is 570, the close is 960. */
export function minutes(ms) {
  const p = parts(ms);
  return p.hh * 60 + p.mm;
}

export const RTH_OPEN = 9 * 60 + 30;
export const RTH_CLOSE = 16 * 60;

/** Is this bar inside the New York cash session? */
export function inRTH(ms) {
  const m = minutes(ms);
  return m >= RTH_OPEN && m < RTH_CLOSE;
}
