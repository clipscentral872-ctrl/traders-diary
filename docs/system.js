/* The automated system's own record, read live from where it publishes it.
 *
 * The system is a separate thing running on a schedule against live bars. It
 * commits its state to a public repository, and raw.githubusercontent serves
 * that with permission for any page to read it, so this needs no server of its
 * own and no copy that can go stale.
 *
 * Everything here is reporting, never control. This page cannot start it, stop
 * it, or place an order, and it is not connected to anyone's money.
 */

const $ = id => document.getElementById(id);

const REPO = "clipscentral872-ctrl/aitrader-tjr-demo";

/* The small file the system now publishes for this page, and the full state
   it publishes for itself. The full one is 800 KB and four fifths of that is
   the poller's own log of every setup it was offered, which this page only
   ever added up into six numbers. The summary carries the six numbers. The
   full file stays the fallback, because a summary that has not been written
   yet must not mean an empty screen. */
const SUMMARY = "state/demo_summary.json";
const FULL = "state/demo_state.json";

/* Two hosts, because one was not enough.
 *
 * raw.githubusercontent went down for every file in every repository on the
 * morning this was written, and with a single source and no retry the tab
 * simply died. jsDelivr answers from the same commit and sends the CORS
 * header, but it caches for hours, so it is the reserve rather than the
 * source: it is there to answer at all, and what it returns is stamped, so
 * the page can say how old it is instead of pretending it is live. */
const HOSTS = [
  n => `https://raw.githubusercontent.com/${REPO}/main/${n}`,
  n => `https://cdn.jsdelivr.net/gh/${REPO}@main/${n}`,
];

// The last thing that loaded, kept so an outage shows yesterday's record
// rather than an error where the record should be. Public data about a
// simulated account, so it sits outside the journal and needs no PIN.
const KEEP = "td.system.last";

const money = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

const stat = (label, value, cls = "") =>
  `<div class="stat"><span class="sl">${label}</span>`
  + `<span class="sv ${cls}">${value}</span></div>`;

const row = (state, label, detail) =>
  `<li class="stand ${state}"><span class="sl2">${esc(label)}</span>`
  + `<span class="sd">${detail}</span></li>`;

function summarise(trades) {
  const pnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  const rs = trades.map(t => t.r).filter(r => typeof r === "number");
  const mean = rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : null;
  return {n: trades.length, pnl, wins, losses: trades.length - wins,
          rate: trades.length ? wins / trades.length * 100 : 0, exp: mean};
}

/* The file keeps the first book at the top level and the second nested under
   it, which is easy to read the wrong way round and did get read the wrong way
   round once. Naming both explicitly here is what stops that repeating. */
function books(d) {
  const out = [{key: "main", name: "Small target", node: d,
                shape: "targets 0.6 to 0.8 times what it risks"}];
  if (d.wide) out.push({key: "wide", name: "Wide target", node: d.wide,
                        shape: "targets 1.3 to 2.2 times what it risks"});
  return out;
}

function renderBooks(d) {
  $("sysbooks").innerHTML = books(d).map(b => {
    const s = summarise(b.node.trades || []);
    const eq = b.node.equity;
    return `<div class="card hud sysbook">
      <h3>${esc(b.name)}</h3>
      <p class="srcnote">It ${esc(b.shape)}.</p>
      <div class="stats hud">${[
        stat("trades", String(s.n)),
        stat("record", `${s.wins}W / ${s.losses}L`),
        stat("net", s.n ? money(s.pnl) : "&mdash;",
             s.n ? (s.pnl >= 0 ? "win" : "loss") : ""),
        stat("expectancy", s.exp === null ? "&mdash;"
             : (s.exp >= 0 ? "+" : "") + s.exp.toFixed(2) + "R",
             (s.exp || 0) >= 0 ? "win" : "loss"),
        stat("equity", typeof eq === "number"
             ? "$" + Math.round(eq).toLocaleString("en-US") : "&mdash;"),
        stat("open now", b.node.position ? "yes" : "flat"),
      ].join("")}</div>
      ${s.n < 30 ? `<p class="srcnote warnnote">${s.n} trade`
        + `${s.n === 1 ? "" : "s"} settles nothing. A few hundred are needed `
        + `before this column means anything at all.</p>` : ""}
    </div>`;
  }).join("");
}

/* The log of every setup the system was offered, taken or not. This is the
   part that answered why its early record was almost all longs: it was not
   direction, it was the same setup being re-entered before one-setup-one-trade
   existed. */
/* The six totals, whichever file they arrived in.
 *
 * The summary carries them ready-made. The full state carries four thousand
 * rows to add up. Both have to end at the same numbers, because either one
 * can be what got through. */
export function seenTotals(d) {
  if (d.seen_totals) return {...d.seen_totals};
  const t = {all: 0, fresh: 0, long: 0, short: 0,
             fresh_long: 0, fresh_short: 0, observations: 0};
  for (const s of d.seen || []) {
    for (const k of ["all", "fresh", "long", "short",
                     "fresh_long", "fresh_short"])
      t[k] += s[k] || 0;
    t.observations++;
  }
  return t;
}

function renderSeen(d) {
  const t = seenTotals(d);
  if (!t.observations) {
    $("sysseen").innerHTML = stat("setups logged", "0");
    $("sysseenline").textContent =
      "Nothing logged yet. This fills in as the system polls.";
    return;
  }
  t.fl = t.fresh_long;
  t.fs = t.fresh_short;
  const pct = t.all ? t.fresh / t.all * 100 : 0;
  $("sysseen").innerHTML = [
    stat("setups offered", t.all.toLocaleString("en-US")),
    stat("actually new", t.fresh.toLocaleString("en-US")),
    stat("that is", pct.toFixed(3) + "%"),
    stat("new, long", String(t.fl)),
    stat("new, short", String(t.fs)),
    stat("observations", t.observations.toLocaleString("en-US")),
  ].join("");

  // A split of 15 to 9 looks lopsided and is not: on 24 coin flips that
  // happens about a third of the time. Saying which side is ahead without
  // saying whether it means anything is how a run gets mistaken for a bias,
  // and that mistake is the reason this log exists at all.
  const n = t.fl + t.fs;
  const lead = Math.max(t.fl, t.fs);
  const settled = n >= 30 && (lead / n) > 0.72;
  const verdict = !n ? ""
    : settled
      ? ` At ${n} that lean is starting to look real and is worth digging into.`
      : ` At ${n} new setups that is not enough to call a lean either way, `
        + `however lopsided it looks.`;

  $("sysseenline").textContent =
    `Nearly every setup on offer is one the system has already seen, so the `
    + `count that matters is the new ones: ${t.fresh} of `
    + `${t.all.toLocaleString("en-US")}, ${t.fl} long and ${t.fs} short.`
    + verdict
    + ` This log is what settled the question of the early all-long record. `
    + `It was not direction. Before a setup could only be traded once, a single `
    + `long that stayed on offer was re-entered poll after poll while each `
    + `short was taken once.`;
}

function renderStanding(d, when, stale) {
  const bs = books(d);
  const total = bs.reduce((s, b) => s + (b.node.trades || []).length, 0);
  const rows = [];

  rows.push(row("no", "Not connected to any money",
    "This page reads the system's published record and can do nothing else. It "
    + "cannot start it, stop it, or place an order, and the system itself trades "
    + "a simulated account."));

  rows.push(row("no", "Nothing here has passed the full test",
    "The strategy fails walk-forward because the folds are too thin, and fails "
    + "the second-source check because no independent futures feed is available "
    + "for free. One configuration ever showed support: EURUSD at a 0.5R target, "
    + "+0.147R, about $500 a month on $50,000. Everything else tested came out "
    + "negative or indistinguishable from zero."));

  rows.push(row(total >= 200 ? "ok" : "warn",
    `The system has taken ${total} trade${total === 1 ? "" : "s"}`,
    total >= 200
      ? "Enough to read, though one period is still one market regime."
      : "A few hundred are needed across both books before the comparison "
        + "settles anything. Until then this is a record of what happened, not "
        + "evidence of what tends to happen."));

  rows.push(row("no", "A filter was built, tested and rejected",
    "The exhaustion rule was measured properly rather than kept because it "
    + "sounded right. On the denser feed the trades it refused were winners, so "
    + "it was left switched off. A news blackout was tested the same way and "
    + "also rejected: the trades it refused made more than the ones it kept."));

  /* When it was reported, and how it got here. A number with no date on it
     is worse than no number, because it looks current whatever happened on
     the way to the screen. */
  const old = when ? ago(when) : null;
  if (when)
    rows.push(row(stale ? "warn" : "ok",
      "Last reported " + when + (old ? ` (${old})` : ""),
      stale
        ? `This is ${stale}, because the system's own host could not be `
          + `reached just now. The date above is the system's, not this `
          + `page's, so what you are reading is exactly that old.`
        : "Read live from where the system publishes it, so this cannot "
          + "quietly go out of date."));
  else if (stale)
    rows.push(row("warn", "Read from a fallback",
      `This is ${stale}. The system's own host could not be reached just now.`));

  $("sysstand").innerHTML = rows.join("");
}

let loaded = false;

/** One file from one host, or null. Never throws, so the caller can just try
 *  the next thing on the list. */
async function grab(url) {
  try {
    const r = await fetch(url, {cache: "no-cache"});
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

/** The record, from wherever it can be got. */
async function fetchState() {
  for (const name of [SUMMARY, FULL])
    for (const host of HOSTS) {
      const d = await grab(host(name));
      if (d) return {d, live: host === HOSTS[0]};
    }
  return null;
}

/* Kept small whichever file arrived.
 *
 * The full state is 800 KB and most of it is the poller's own workings. Put
 * in localStorage as it stands it would be the largest thing this app has
 * ever written, to hold six numbers it had already worked out. */
export const slim = d => ({
  equity: d.equity, position: d.position,
  trades: (d.trades || []).map(t => ({pnl: t.pnl, r: t.r})),
  wide: d.wide ? {
    equity: d.wide.equity, position: d.wide.position,
    trades: (d.wide.trades || []).map(t => ({pnl: t.pnl, r: t.r})),
  } : undefined,
  polls: d.polls, started: d.started, updated: d.updated,
  seen_totals: seenTotals(d),
});

const remember = d => {
  try { localStorage.setItem(KEEP, JSON.stringify(slim(d))); }
  catch { /* private mode, or full */ }
};
const recall = () => {
  try { return JSON.parse(localStorage.getItem(KEEP)); } catch { return null; }
};

/** How long ago, said the way a person would say it. */
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export async function show() {
  if (loaded) return;
  loaded = true;
  $("sysline").textContent = "Reading the live state...";

  const got = await fetchState();
  /* An outage shows the last record rather than an error where the record
     should be. It says which it is doing: a figure with no date on it is
     worse than no figure, because it looks current. */
  const d = got ? got.d : recall();
  if (!d) {
    loaded = false;               // let a later visit try again
    $("sysline").textContent =
      "Could not reach the system's record, and nothing has been read on this "
      + "device yet to fall back on. It publishes to a public repository, so "
      + "this needs a connection. Everything else in this app works offline.";
    $("sysstand").innerHTML = row("warn", "Live state unavailable",
      "The rest of this tab fills in once the record can be read.");
    return;
  }
  if (got) remember(d);

  const stale = !got ? "from the last time this device could reach it"
    : got.live ? null
    : "from a cache, so it can be a few hours behind";

  const polls = d.polls || 0;
  const bs = books(d);
  const open = bs.filter(b => b.node.position);
  const when = d.updated || null;

  $("sysstats").innerHTML = [
    stat("polls", polls.toLocaleString("en-US")),
    stat("books", String(bs.length)),
    stat("trades", String(bs.reduce((s, b) => s + (b.node.trades || []).length, 0))),
    stat("in a position", open.length ? open.map(b => b.name).join(", ") : "flat"),
  ].join("");

  $("sysline").textContent = open.length
    ? `Live now: ${open.map(b => {
        const p = b.node.position;
        return `${b.name} is ${p.side} ${p.symbol} from ${p.entry}`;
      }).join("; ")}.`
    : `Both books are flat. The system only takes a setup that has not been `
      + `taken before, which is rare: most polls see nothing new.`;

  renderStanding(d, when, stale);
  renderBooks(d);
  renderSeen(d);
}
