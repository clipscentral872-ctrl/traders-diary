/* Loading bars, and building the timeframes that are not published.
 *
 * Yahoo gives one minute, five minutes and one hour. Fifteen minutes and four
 * hours are built here from the ones below them, which is cheaper than
 * publishing four more files and is how the desktop version already does it.
 *
 * The part that is easy to get wrong, and was got wrong before: a resampled
 * bar has to sit on a CLOCK boundary. Grouping every three five-minute bars
 * from wherever the file happens to start gives 09:32, 09:47, 10:02, which
 * looks like a fifteen-minute chart and lines up with nothing, so every level
 * read off it is in the wrong place.
 *
 * Four hours is anchored to 18:00 New York, the futures session open, because
 * a four-hour grid measured from midnight UTC cuts the session in places that
 * mean nothing to anyone trading it.
 */

export const TIMEFRAMES = [
  {key: "5m", label: "5m", from: "5m", group: 1},
  {key: "15m", label: "15m", from: "5m", group: 3},
  {key: "1h", label: "1h", from: "1h", group: 1},
  {key: "4h", label: "4h", from: "1h", group: 4},
  {key: "1m", label: "1m", from: "1m", group: 1},
];

const MIN = 60000;
const SESSION_OPEN_H = 18;      // New York, when the futures week's day starts

const files = new Map();
const pending = new Map();
const built = new Map();

async function rawFile(sym, tf) {
  const key = sym + "_" + tf;
  if (files.has(key)) return files.get(key);
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const r = await fetch(`bars/${key}.json`, {cache: "no-cache"});
    if (!r.ok) throw new Error(`no published bars for ${sym} ${tf}`);
    const j = await r.json();
    const out = [];
    j.bars.forEach((b, i) => {
      if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                       o: b[0], h: b[1], l: b[2], c: b[3],
                       // Volume when the file carries it. Archives written
                       // before it did, and the seed copies, read as none
                       // rather than as zero, so the chart draws nothing
                       // instead of a row of empty bars.
                       v: b.length > 4 ? b[4] : null});
    });
    files.set(key, out);
    pending.delete(key);
    return out;
  })();
  pending.set(key, p);
  return p;
}

/** Offset from UTC to New York at this moment, in minutes. Honours daylight
 *  saving, which a fixed number does not. */
const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", second: "2-digit",
});
function nyOffsetMin(ms) {
  const p = NY_PARTS.formatToParts(new Date(ms));
  const g = k => +p.find(x => x.type === k).value;
  const asUTC = Date.UTC(g("year"), g("month") - 1, g("day"),
                         g("hour") % 24, g("minute"), g("second"));
  return Math.round((asUTC - ms) / MIN);
}

/**
 * Fold bars into buckets of `n` source bars, aligned to the clock.
 *
 * @param bars   ascending source bars
 * @param stepMs the source timeframe in milliseconds
 * @param n      how many to fold together
 * @param anchorSession true to line the grid up with the 18:00 New York open
 */
export function resample(bars, stepMs, n, anchorSession) {
  if (n <= 1 || !bars.length) return bars;
  const size = stepMs * n;
  const out = [];
  let cur = null, curKey = null;

  for (const b of bars) {
    // Which bucket this bar belongs to, measured on the clock rather than on
    // its position in the file.
    let t = b.ms;
    if (anchorSession) {
      // Shift so that 18:00 New York is a grid line, then shift back.
      t += (nyOffsetMin(b.ms) - SESSION_OPEN_H * 60) * MIN;
    }
    const shift = t - b.ms;
    const key = Math.floor(t / size) * size;
    if (key !== curKey) {
      if (cur) out.push(cur);
      curKey = key;
      // A bar is stamped with the START of its bucket, not with the first
      // source bar that happened to land in it. Those are the same for a full
      // bucket and differ for the partial one at the beginning of a file,
      // where taking the source bar's time put a "15 minute" bar at 09:35.
      cur = {ms: key - shift, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null};
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      // A built bar's volume is everything traded inside it.
      if (b.v != null) cur.v = (cur.v ?? 0) + b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** How long one bar of a published file lasts. */
export const STEP_MS = {"1m": MIN, "5m": 5 * MIN, "1h": 60 * MIN};

/**
 * For each bar of a finer series, the index of the coarser bar it falls in.
 *
 * The replay steps through the finer bars and draws the coarser ones, so it
 * needs to know, for the five-minute bar it has just played, which fifteen
 * minute candle that belongs to. Both series are ascending, so one pass does
 * it. A coarse bar owns every fine bar from its own start up to the start of
 * the next one.
 */
export function bucketIndex(fine, coarse) {
  const out = new Int32Array(fine.length);
  let k = 0;
  for (let j = 0; j < fine.length; j++) {
    while (k + 1 < coarse.length && coarse[k + 1].ms <= fine[j].ms) k++;
    out[j] = k;
  }
  return out;
}

/**
 * The coarse bar as it stood when fine bar j closed.
 *
 * Opened by the first fine bar of its bucket, its high and low so far, and
 * closed at bar j. This is the candle TradingView draws half formed during a
 * replay. Drawing the finished bar instead showed the rest of the hour before
 * it had happened: switch a replay at 10:25 from five minutes to the hour and
 * the 10:00 candle arrived complete, with 35 minutes of the future in it.
 * When j is the last fine bar of its bucket this is the finished bar.
 */
export function formingBar(fine, idx, j, ms) {
  const k = idx[j];
  let s = j;
  while (s > 0 && idx[s - 1] === k) s--;
  let h = -Infinity, l = Infinity, v = null;
  for (let q = s; q <= j; q++) {
    const b = fine[q];
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
    if (b.v != null) v = (v ?? 0) + b.v;
  }
  return {ms, o: fine[s].o, h, l, c: fine[j].c, v};
}

/**
 * The hour, and the bars to step it with, from the finest data held.
 *
 * The hourly file reaches back two years; the five minute one only as far as
 * it has been collecting. So the hour is the hourly file up to where the five
 * minute bars begin, and built from the five minute bars after that, and the
 * bars a replay steps through follow the same split. Stepping an hourly chart
 * an hour at a time skipped whatever happened inside the hour, fills
 * included, and showed the last finished hour's price as the market's.
 *
 * The split is on an hour boundary so no hour is half one and half the other.
 * Returns the fine bars, the hours, and the moment the five minute bars start.
 */
export function stitchHours(h1, m5) {
  const HOUR = 60 * MIN;
  if (!m5 || !m5.length) return {fine: h1, hours: h1, split: Infinity};
  const split = Math.ceil(m5[0].ms / HOUR) * HOUR;
  const old = h1.filter(b => b.ms < split);
  const recent = m5.filter(b => b.ms >= split);
  return {
    fine: old.concat(recent),
    hours: old.concat(resample(recent, 5 * MIN, 12, false)),
    split,
  };
}

/** Bars for a symbol at a timeframe, built if it is not one that is published. */
export async function load(sym, tf) {
  const spec = TIMEFRAMES.find(t => t.key === tf) || TIMEFRAMES[0];
  const base = await rawFile(sym, spec.from);
  if (spec.group === 1) return base;

  const key = sym + "_" + tf;
  if (built.has(key)) return built.get(key);
  const stepMs = spec.from === "1m" ? MIN : spec.from === "5m" ? 5 * MIN : 60 * MIN;
  const out = resample(base, stepMs, spec.group, spec.key === "4h");
  built.set(key, out);
  return out;
}

/** Drop everything held, so the next load fetches freshly published bars. */
export function clear() {
  files.clear();
  built.clear();
}
