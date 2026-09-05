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

const SRC = "https://raw.githubusercontent.com/clipscentral872-ctrl/"
          + "aitrader-tjr-demo/main/state/demo_state.json";

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
function renderSeen(d) {
  const seen = d.seen || [];
  if (!seen.length) {
    $("sysseen").innerHTML = stat("setups logged", "0");
    $("sysseenline").textContent =
      "Nothing logged yet. This fills in as the system polls.";
    return;
  }
  const t = {all: 0, fresh: 0, long: 0, short: 0, fl: 0, fs: 0};
  for (const s of seen) {
    t.all += s.all || 0; t.fresh += s.fresh || 0;
    t.long += s.long || 0; t.short += s.short || 0;
    t.fl += s.fresh_long || 0; t.fs += s.fresh_short || 0;
  }
  const pct = t.all ? t.fresh / t.all * 100 : 0;
  $("sysseen").innerHTML = [
    stat("setups offered", t.all.toLocaleString("en-US")),
    stat("actually new", t.fresh.toLocaleString("en-US")),
    stat("that is", pct.toFixed(3) + "%"),
    stat("new, long", String(t.fl)),
    stat("new, short", String(t.fs)),
    stat("observations", seen.length.toLocaleString("en-US")),
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

function renderStanding(d, when) {
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

  if (when)
    rows.push(row("ok", "Last reported " + when,
      "Read live from where the system publishes it, so this cannot quietly go "
      + "out of date."));

  $("sysstand").innerHTML = rows.join("");
}

let loaded = false;

export async function show() {
  if (loaded) return;
  loaded = true;
  $("sysline").textContent = "Reading the live state...";
  let d;
  try {
    const r = await fetch(SRC, {cache: "no-cache"});
    if (!r.ok) throw new Error("HTTP " + r.status);
    d = await r.json();
  } catch (e) {
    loaded = false;               // let a later visit try again
    $("sysline").textContent =
      "Could not reach the system's record just now (" + e.message + "). "
      + "It publishes to a public repository, so this needs a connection. "
      + "Everything else in this app works offline.";
    $("sysstand").innerHTML = row("warn", "Live state unavailable",
      "The rest of this tab fills in once the record can be read.");
    return;
  }

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

  renderStanding(d, when);
  renderBooks(d);
  renderSeen(d);
}
