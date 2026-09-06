/* How often an untapped level actually gets tapped before the day closes.
 *
 * The question this answers is the one the whole method rests on: there is an
 * obvious high sitting there untouched, and you want to know whether price is
 * likely to go and take it. Not because a number decides the trade, but
 * because "it usually gets tapped" and "it usually does not" are very
 * different backdrops and most people never check which one they are in.
 *
 * It is built from the bars this site publishes, in the browser, and it is
 * measured rather than asserted:
 *
 *   Every observation is a level that was still untapped at some bar, filed
 *   by how far away it was and how much of the session was left. At the day's
 *   close each one is resolved as hit or miss. The estimate for a bucket is
 *   simply hits over total in that bucket.
 *
 *   A thin bucket is pulled toward the overall base rate rather than being
 *   believed. Three observations that all hit is not a 100% level, and
 *   printing 100% would be a lie with a number on it.
 *
 *   Nothing looks ahead. At every bar only bars up to that bar are used, and
 *   a day's own levels come from the day before it.
 *
 * The sample size is always returned beside the probability, because with a
 * thin sample the sample size IS the answer.
 */

// Distance to the level as a share of the average daily range. A level half
// an ADR away is a different proposition from one a tenth away, and the range
// is what makes that comparable across contracts and across quiet and violent
// weeks.
const DIST_EDGES = [0.1, 0.25, 0.5, 0.75, 1.0];

// How much of the session has gone. Time left is the other half of the
// question: the same distance early in the day and ten minutes before the
// close are not the same bet.
const TIME_BUCKETS = 4;

// How hard a thin bucket is pulled toward the base rate. Twenty means a
// bucket needs about twenty observations before it mostly speaks for itself.
export const SHRINK = 20;

// Below this, the number is shown with a warning rather than as a finding.
export const MIN_SAMPLES = 30;

// How many previous days the average range is taken over. Long enough to be
// stable, short enough to follow a market that has changed gear.
const ADR_DAYS = 20;

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
});

// Intl formatting is slow enough to matter here: this is called once per bar
// and there are tens of thousands of them, on every redraw. Stepping the
// replay chart with it uncached froze the tab. The answer only depends on the
// timestamp, so it is worked out once and kept.
const _dateCache = new Map();
const nyDate = ms => {
  let v = _dateCache.get(ms);
  if (v !== undefined) return v;
  const p = NY.formatToParts(new Date(ms));
  const g = k => p.find(x => x.type === k).value;
  v = `${g("year")}-${g("month")}-${g("day")}`;
  // Bounded, so a long session cannot grow this without limit.
  if (_dateCache.size > 200000) _dateCache.clear();
  _dateCache.set(ms, v);
  return v;
};

/** Index of the last bar at or before `ms`, or -1. Binary, not a scan. */
function upTo(bars, ms) {
  if (ms == null) return bars.length - 1;
  let lo = 0, hi = bars.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ms <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const distBucket = d => {
  for (let i = 0; i < DIST_EDGES.length; i++) if (d < DIST_EDGES[i]) return i;
  return DIST_EDGES.length;
};

/**
 * Build the model from a run of bars.
 *
 * @param bars ascending [{ms,o,h,l,c}]
 * @returns {{buckets: Map, base: number, days: number, adr: number, obs: number}}
 */
export function build(bars) {
  const empty = {buckets: new Map(), base: 0, days: 0, adr: 0, obs: 0};
  if (!bars || bars.length < 50) return empty;

  // Split into New York trading days.
  const days = [];
  let cur = null, curDate = null;
  for (const b of bars) {
    const d = nyDate(b.ms);
    if (d !== curDate) { cur = {date: d, bars: []}; days.push(cur); curDate = d; }
    cur.bars.push(b);
  }
  // A part-day at either end has no honest previous day or no close to
  // resolve against, so it is dropped rather than half-counted.
  if (days.length < 5) return empty;

  const dayHigh = d => Math.max(...d.bars.map(b => b.h));
  const dayLow = d => Math.min(...d.bars.map(b => b.l));

  const ranges = days.map(d => dayHigh(d) - dayLow(d));

  // The range used to normalise a day's distances comes from the days BEFORE
  // it, never from the whole history. Using a global average let a violent
  // week months later change how a quiet Tuesday was filed, which is a peek
  // at the future dressed up as a unit of measure. The lookahead test caught
  // exactly this.
  const trailingAdr = i => {
    const from = Math.max(0, i - ADR_DAYS);
    const win = ranges.slice(from, i);
    if (!win.length) return 0;
    return win.reduce((s, x) => s + x, 0) / win.length;
  };

  const avgBars = days.reduce((s, d) => s + d.bars.length, 0) / days.length;
  const buckets = new Map();
  let hits = 0, obs = 0;

  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1], today = days[i];
    const adr = trailingAdr(i);
    if (!(adr > 0)) continue;
    // Levels a trader would already have had at this day's open.
    const levels = [
      {price: dayHigh(prev), above: true},
      {price: dayLow(prev), above: false},
    ];

    // When each level was first tapped today, or never.
    const tappedAt = levels.map(() => -1);
    today.bars.forEach((b, k) => {
      levels.forEach((lv, j) => {
        if (tappedAt[j] >= 0) return;
        if (lv.above ? b.h >= lv.price : b.l <= lv.price) tappedAt[j] = k;
      });
    });

    today.bars.forEach((b, k) => {
      const elapsed = Math.min(TIME_BUCKETS - 1,
        Math.floor(k / Math.max(1, avgBars) * TIME_BUCKETS));
      levels.forEach((lv, j) => {
        // Only levels still untapped at this bar are a question at all.
        if (tappedAt[j] >= 0 && tappedAt[j] <= k) return;
        const key = distBucket(Math.abs(lv.price - b.c) / adr) + "|" + elapsed;
        const rec = buckets.get(key) || {hit: 0, n: 0};
        rec.n++;
        // Hit means it was tapped later the same day, before the close.
        if (tappedAt[j] > k) { rec.hit++; hits++; }
        buckets.set(key, rec);
        obs++;
      });
    });
  }

  const adrNow = (() => {
    const win = ranges.slice(Math.max(0, ranges.length - ADR_DAYS));
    return win.length ? win.reduce((s, x) => s + x, 0) / win.length : 0;
  })();
  return {buckets, base: obs ? hits / obs : 0, days: days.length,
          adr: adrNow, obs};
}

/**
 * The chance this untapped level gets tapped before the day closes.
 *
 * @param model   from build()
 * @param level   {price, above}
 * @param close   the current price
 * @param elapsed how far through the session, 0 to 1
 * @returns {{p, n, thin, base}} or null when there is no model
 */
export function chance(model, level, close, elapsed) {
  if (!model || !model.obs || !(model.adr > 0)) return null;
  const e = Math.min(TIME_BUCKETS - 1,
    Math.max(0, Math.floor(elapsed * TIME_BUCKETS)));
  const key = distBucket(Math.abs(level.price - close) / model.adr) + "|" + e;
  const rec = model.buckets.get(key) || {hit: 0, n: 0};
  // Pulled toward the base rate in proportion to how little the bucket knows.
  const p = (rec.hit + SHRINK * model.base) / (rec.n + SHRINK);
  return {p, n: rec.n, thin: rec.n < MIN_SAMPLES, base: model.base};
}

/**
 * The chance for each previous-day level that is still untapped right now.
 *
 * Only the previous day's high and low, because those are what the model was
 * built on. Quoting a number at a session level the model never saw would be
 * borrowing authority it has not earned.
 *
 * @param bars  ascending bars for the contract
 * @param atMs  the moment being asked about; nothing after it is used
 * @param model from build()
 * @returns Map of "above"|"below" to {price, p, n, thin}
 */
export function untappedNow(bars, atMs, model) {
  const out = new Map();
  if (!model || !model.obs || !bars || !bars.length) return out;

  const hi = upTo(bars, atMs);
  if (hi < 0) return out;

  // Repeated redraws land on the same bar, so the whole answer is memoised
  // against it rather than recomputed for every frame.
  const ck = bars.length + "@" + bars[hi].ms;
  if (_untappedCache.key === ck) return _untappedCache.val;

  const today = nyDate(bars[hi].ms);
  let start = hi;
  while (start > 0 && nyDate(bars[start - 1].ms) === today) start--;
  if (start === 0) { _untappedCache = {key: ck, val: out}; return out; }

  const prevDate = nyDate(bars[start - 1].ms);
  let pstart = start - 1;
  while (pstart > 0 && nyDate(bars[pstart - 1].ms) === prevDate) pstart--;

  const prev = bars.slice(pstart, start);
  if (!prev.length) { _untappedCache = {key: ck, val: out}; return out; }
  const levels = [
    {key: "above", price: Math.max(...prev.map(b => b.h)), above: true},
    {key: "below", price: Math.min(...prev.map(b => b.l)), above: false},
  ];

  const todayBars = bars.slice(start, hi + 1);
  const close = bars[hi].c;
  // Roughly how far through the session, by bar count against a normal day.
  const elapsed = Math.min(1, todayBars.length / 78);

  for (const lv of levels) {
    const tapped = todayBars.some(b =>
      lv.above ? b.h >= lv.price : b.l <= lv.price);
    if (tapped) continue;
    const c = chance(model, lv, close, elapsed);
    if (c) out.set(lv.key, {price: lv.price, ...c});
  }
  _untappedCache = {key: ck, val: out};
  return out;
}

let _untappedCache = {key: null, val: new Map()};

/** A probability as words a person can act on.
 *
 *  Rounding 0.004 to "0%" reads as impossible, and nothing measured from a
 *  sample is impossible. The ends are named rather than rounded away. */
export const pct = p =>
  p < 0.01 ? "under 1%" : p > 0.99 ? "over 99%" : (p * 100).toFixed(0) + "%";
