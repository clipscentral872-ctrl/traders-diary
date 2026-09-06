/* The watchlist: the contracts this app carries, with what they last did.
 *
 * Small on purpose. A watchlist is for switching between things and seeing at
 * a glance which one is moving, not for analysis, so it carries the last
 * price, the change on the day, and nothing else.
 *
 * The change is measured from the previous New York day's close rather than
 * from the first bar on file, which would make it a change since whenever the
 * published history happens to begin: a number that looks meaningful and is
 * not.
 */

const SYMS = [
  ["NQ", "Nasdaq 100"],
  ["ES", "S&P 500"],
  ["YM", "Dow"],
  ["RTY", "Russell 2000"],
];

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
});
const dayOf = ms => NY.format(new Date(ms));

const px = v => v.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});

const cache = new Map();

async function quote(sym) {
  if (cache.has(sym)) return cache.get(sym);
  try {
    const r = await fetch(`bars/${sym}_1m.json`, {cache: "no-cache"});
    if (!r.ok) return null;
    const j = await r.json();
    // Walk back from the end, which is where the answer is, rather than
    // unpacking twelve thousand bars to look at the last two days of them.
    let last = null, lastDay = null, prevClose = null;
    for (let i = j.bars.length - 1; i >= 0; i--) {
      const b = j.bars[i];
      if (!b) continue;
      const ms = (j.t0 + i * j.step) * 1000;
      if (!last) { last = {ms, c: b[3]}; lastDay = dayOf(ms); continue; }
      if (dayOf(ms) !== lastDay) { prevClose = b[3]; break; }
    }
    if (!last) return null;
    const out = {sym, last: last.c, ms: last.ms,
                 change: prevClose == null ? null : last.c - prevClose,
                 pct: prevClose ? (last.c - prevClose) / prevClose * 100 : null};
    cache.set(sym, out);
    return out;
  } catch { return null; }
}

/**
 * Draw the list into a container.
 *
 * @param box       the element to fill
 * @param current   which symbol is on the chart
 * @param onPick    called with a symbol when one is clicked
 */
export async function render(box, current, onPick) {
  if (!box) return;
  if (!box.dataset.wired) {
    box.dataset.wired = "1";
    box.addEventListener("click", e => {
      const row = e.target.closest(".wl");
      if (row && onPick) onPick(row.dataset.sym);
    });
  }

  const quotes = await Promise.all(SYMS.map(([s]) => quote(s)));
  box.innerHTML = SYMS.map(([sym, name], i) => {
    const q = quotes[i];
    const on = sym === current ? " on" : "";
    if (!q) {
      return `<button class="wl${on}" data-sym="${sym}">`
        + `<span class="wls">${sym}</span><span class="wln">${name}</span>`
        + `<span class="wlp">&mdash;</span></button>`;
    }
    const up = (q.change ?? 0) >= 0;
    const move = q.change == null ? ""
      : `<span class="wlc ${up ? "win" : "loss"}">`
        + `${up ? "+" : ""}${q.change.toFixed(2)}`
        + (q.pct == null ? "" : ` (${up ? "+" : ""}${q.pct.toFixed(2)}%)`)
        + "</span>";
    return `<button class="wl${on}" data-sym="${sym}">`
      + `<span class="wls">${sym}</span><span class="wln">${name}</span>`
      + `<span class="wlp">${px(q.last)}</span>${move}</button>`;
  }).join("");
}

/** Forget the cached quotes, so the next render fetches fresh ones. */
export const refresh = () => cache.clear();
