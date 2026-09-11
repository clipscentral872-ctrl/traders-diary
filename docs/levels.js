/* Session highs and lows, computed in the browser from the bars on hand.
 *
 * These are the levels the method is built around: the ranges that stops rest
 * behind, and therefore the ones a sweep is a sweep OF.
 *
 * Two rules make this honest rather than decorative.
 *
 * The boundaries are New York time, not UTC. The market lives on Eastern time,
 * so fixed UTC hours end Asia an hour early half the year and cut the last
 * stretch off every range, which quietly moves every level built on one.
 *
 * A session only appears once it has CLOSED. A level you could not have known
 * yet is not drawn. Showing the New York high while New York is still trading
 * is drawing the answer on the exam paper, which is exactly what replaying
 * blind exists to avoid.
 */

// New York minutes-from-midnight. Asia wraps past midnight, which is why it is
// stored as a start later than its end.
export const SESSIONS = [
  {key: "asia", label: "Asia", from: 18 * 60, to: 3 * 60},
  {key: "london", label: "London", from: 3 * 60, to: 8 * 60 + 30},
  {key: "ny", label: "New York", from: 9 * 60 + 30, to: 16 * 60},
];

// Days of history to look at. Asia opens the evening before, and the
// previous day's range is wanted, so three covers every level drawn here.
const DAYS_BACK = 3;

export const FAMILY_COLOUR = {
  asia: "#8B7BE8", london: "#E8A33D", ny: "#35E0F0", day: "#7E90A8",
};

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

/** A timestamp as New York calendar date and minutes past midnight.
 *
 *  Memoised, because this is called once per bar and the replay redraws on
 *  every step. Over a two-month series that is tens of thousands of Intl
 *  formats per frame, which was enough to lock the tab up while stepping. */
const _parts = new Map();
function nyParts(ms) {
  let v = _parts.get(ms);
  if (v !== undefined) return v;
  const p = NY.formatToParts(new Date(ms));
  const g = k => p.find(x => x.type === k).value;
  const hour = parseInt(g("hour"), 10) % 24;
  v = {date: `${g("year")}-${g("month")}-${g("day")}`,
       mins: hour * 60 + parseInt(g("minute"), 10)};
  if (_parts.size > 200000) _parts.clear();
  _parts.set(ms, v);
  return v;
}

/** Index of the last bar at or before `ms`, or -1. */
function upTo(bars, ms) {
  if (ms == null) return bars.length - 1;
  let lo = 0, hi = bars.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ms <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// Redraws land on the same bar again and again, so the whole answer is kept
// against it rather than rebuilt per frame. One entry per series: the replay
// draws two contracts at once, and NQ and ES can hold the same number of bars
// ending at the same minute, which one entry keyed on those alone would have
// answered with the other contract's levels.
const _cache = new WeakMap();

/** Which trading day a bar belongs to for a session that wraps midnight.
 *  A bar at 19:00 belongs to the NEXT day's Asia session, the way a trader
 *  thinks of it: Sunday evening is Monday's Asia. */
function shiftDay(date, by) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/**
 * Every session range that had closed by `atMs`, plus the previous day's.
 *
 * @param bars  ascending [{ms,o,h,l,c}]
 * @param atMs  the moment being replayed; nothing after it is looked at
 */
export function levelsAt(bars, atMs) {
  if (!bars || !bars.length) return [];

  // Only bars up to the playhead. Everything after it is the future.
  const hi = upTo(bars, atMs);
  if (hi < 0) return [];

  const ck = bars.length + "@" + bars[hi].ms;
  const hit = _cache.get(bars);
  if (hit && hit.key === ck) return hit.val;

  const now = nyParts(bars[hi].ms);
  const sessions = new Map();     // "asia|2026-09-04" -> {h, l, closed}
  const days = new Map();         // "2026-09-04" -> {h, l}

  // Only the last few days are ever needed: the previous day's range, and
  // sessions that reach back to the evening before. Rescanning two months of
  // bars on every step was the whole cost, and none of it was used.
  let from = hi;
  {
    const seen = new Set([now.date]);
    while (from > 0 && seen.size <= DAYS_BACK) {
      const d = nyParts(bars[from - 1].ms).date;
      if (!seen.has(d)) {
        if (seen.size === DAYS_BACK) break;
        seen.add(d);
      }
      from--;
    }
  }

  for (let i = from; i <= hi; i++) {
    const b = bars[i];
    const {date, mins} = nyParts(b.ms);

    const d = days.get(date) || {h: -Infinity, l: Infinity};
    d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l);
    days.set(date, d);

    for (const s of SESSIONS) {
      const wraps = s.from > s.to;
      const inside = wraps ? (mins >= s.from || mins < s.to)
                           : (mins >= s.from && mins < s.to);
      if (!inside) continue;
      // An evening bar belongs to the next trading day's session.
      const owner = wraps && mins >= s.from ? shiftDay(date, 1) : date;
      const k = s.key + "|" + owner;
      const r = sessions.get(k) || {h: -Infinity, l: Infinity, key: s.key,
                                    label: s.label, day: owner};
      r.h = Math.max(r.h, b.h); r.l = Math.min(r.l, b.l);
      sessions.set(k, r);
    }
  }

  // A session has closed once the clock is past its end on its own day.
  const closed = r => {
    const s = SESSIONS.find(x => x.key === r.key);
    if (r.day < now.date) return true;
    if (r.day > now.date) return false;
    return now.mins >= s.to && !(s.from > s.to && now.mins >= s.from);
  };

  const out = [];
  const seen = new Set();
  // Newest first, so the most recent closed session of each kind wins.
  for (const r of [...sessions.values()].sort((a, b) => (a.day < b.day ? 1 : -1))) {
    if (seen.has(r.key) || !closed(r)) continue;
    if (!Number.isFinite(r.h) || !Number.isFinite(r.l)) continue;
    seen.add(r.key);
    // During the New York session the most recent CLOSED New York range is
    // yesterday's. Labelling that "New York High" reads as today's and is the
    // one way this could mislead, so a level from an earlier day says so.
    const name = r.day < now.date ? "Prev " + r.label : r.label;
    out.push({family: r.key, label: name + " High", price: r.h, day: r.day},
             {family: r.key, label: name + " Low", price: r.l, day: r.day});
  }

  const prevDays = [...days.keys()].filter(d => d < now.date).sort();
  if (prevDays.length) {
    const d = days.get(prevDays[prevDays.length - 1]);
    out.push({family: "day", label: "Prev Day High", price: d.h},
             {family: "day", label: "Prev Day Low", price: d.l});
  }
  _cache.set(bars, {key: ck, val: out});
  return out;
}
