/* The one screen that answers "where am I".
 *
 * Everything on it already exists somewhere else in the app. The point is not
 * new information, it is that opening this and reading four tiles should be
 * enough to know whether anything needs your attention, without going hunting
 * through five tabs to assemble it.
 *
 * Two rules it holds to, because a dashboard is where honesty usually dies:
 *
 *   A tile with nothing behind it says so rather than showing a zero. "0
 *   trades, 0%, $0" reads like a flat month; "nothing imported yet" reads
 *   like what it is.
 *
 *   Nothing is dressed up. The biggest repeating mistake in your record is
 *   printed as plainly as the profit, and the profit does not get a bigger
 *   font than the drawdown.
 */
import * as E from "./engine.js";
import * as RV from "./revisit.js";

const $ = id => document.getElementById(id);

const money = v => (v < 0 ? "-" : "+") + "$"
  + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
const plain = v => "$" + Math.round(v).toLocaleString("en-US");
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

const FLAG_WORDS = {
  "trailed early": "tightening the stop before your own rule says to",
  "slipped": "stops filling worse than they were set",
  "cut short": "coming out before a target price then reached",
  "closed early": "closing by hand well short of the target",
  "right, stopped early": "right direction, stop inside the noise",
  "target far out": "targets set beyond what you manage the trade for",
  "stop wrong side": "a stop moved past the entry, firing at once",
  "stopped fast": "stopped inside a minute",
  "no R": "trades with no stop on record",
  "stopped into the news": "stopped in the last minute before a data release",
};

function tile(label, value, cls = "", note = "") {
  return `<div class="dtile"><span class="dl">${esc(label)}</span>`
       + `<span class="dv ${cls}">${value}</span>`
       + (note ? `<span class="dn">${esc(note)}</span>` : "") + "</div>";
}

/** Your own record, in three numbers and one sentence. */
function yours() {
  const live = (window.TRADES || []).filter(t => (t.source || "live") === "live");
  if (!live.length) {
    return tile("your record", "nothing yet", "",
                "Import your TradingView exports on the Diary tab.");
  }
  const s = E.summarise(live);
  const scored = live.filter(t => t.got_r !== null && t.got_r !== undefined);
  return [
    tile("your record", money(s.pnl), s.pnl >= 0 ? "win" : "loss",
         `${s.trades} trades, ${s.wins}W / ${s.losses}L`),
    tile("expectancy", s.expectancy_r === null ? "no R yet"
         : (s.expectancy_r >= 0 ? "+" : "") + s.expectancy_r.toFixed(2) + "R",
         (s.expectancy_r || 0) >= 0 ? "win" : "loss",
         scored.length < live.length
           ? `measured on ${scored.length} of ${live.length}`
           : `over ${live.length} trades`),
    tile("worst drawdown", plain(s.max_dd), "loss",
         `${s.worst_streak} losing trades in a row at worst`),
  ].join("");
}

/** The one habit costing the most, named rather than buried in a list. */
function leak() {
  const live = (window.TRADES || []).filter(t => (t.source || "live") === "live");
  if (live.length < 3) return "";
  const counts = new Map();
  for (const t of live)
    for (const f of (t.flags || []))
      if (FLAG_WORDS[f]) counts.set(f, (counts.get(f) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2) return "";
  const [flag, n] = top;

  // What it actually cost, where that is answerable. Only trades carrying the
  // flag AND an R, so the figure is not quietly averaging in unmeasurable ones.
  const hit = live.filter(t => (t.flags || []).includes(flag)
    && t.got_r !== null && t.got_r !== undefined);
  const rest = live.filter(t => !(t.flags || []).includes(flag)
    && t.got_r !== null && t.got_r !== undefined);
  const mean = a => a.reduce((s, t) => s + t.got_r, 0) / a.length;
  let cost = "";
  if (hit.length >= 2 && rest.length >= 2) {
    const gap = mean(rest) - mean(hit);
    cost = gap > 0.05
      ? ` Those trades average ${mean(hit).toFixed(2)}R against `
        + `${mean(rest).toFixed(2)}R for the rest, a gap of ${gap.toFixed(2)}R.`
      : ` They are not measurably worse than your other trades, so this is a `
        + `habit to watch rather than a proven leak.`;
  }
  return `<div class="dleak"><span class="dlt">Happening most</span>`
       + `<p><b>${n} times:</b> ${esc(FLAG_WORDS[flag])}.${esc(cost)}</p></div>`;
}

/** The demo account, and whether a position is live in it. */
function demo() {
  let a = null;
  try { a = JSON.parse(localStorage.getItem("tradersdiary.demo")); } catch { /* fresh */ }
  if (!a || typeof a.balance !== "number")
    return tile("demo account", "not started", "", "Open the Demo tab to begin.");
  const net = a.balance - 100000;
  const n = (a.trades || []).length;
  return tile("demo account", plain(a.balance), net >= 0 ? "win" : "loss",
    a.pos ? `in a ${a.pos.side.toLowerCase()} of ${a.pos.qty} ${a.pos.symbol}`
          : `${money(net)} over ${n} trade${n === 1 ? "" : "s"}`);
}

/** What is actually in play right now, and how often it usually gets taken. */
async function levelsInPlay() {
  const box = $("dashlevels");
  try {
    const [minute, five] = await Promise.all([
      fetch("bars/NQ_1m.json", {cache: "no-cache"}).then(r => r.json()),
      fetch("bars/NQ_5m.json", {cache: "no-cache"}).then(r => r.json()),
    ]);
    const unpack = j => {
      const out = [];
      j.bars.forEach((b, i) => {
        if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                         o: b[0], h: b[1], l: b[2], c: b[3]});
      });
      return out;
    };
    const bars = unpack(minute);
    const model = RV.build(unpack(five));
    const odds = RV.untappedNow(bars, null, model);
    const last = bars[bars.length - 1];
    const age = Math.round((Date.now() - last.ms) / 60000);

    if (!odds.size) {
      box.innerHTML = tile("NQ levels in play", "both taken", "",
        "Yesterday's high and low have both been tapped already.");
      return;
    }
    box.innerHTML = [...odds.entries()].map(([side, o]) => {
      const away = Math.abs(o.price - last.c);
      return tile(
        side === "above" ? "prev day high, untapped" : "prev day low, untapped",
        RV.pct(o.p) + (o.thin ? " ?" : ""),
        o.p >= 0.5 ? "win" : "",
        `${o.price.toLocaleString("en-US")}, ${Math.round(away)} points away`
        + ` / ${o.n.toLocaleString("en-US")} past cases`);
    }).join("") + tile("NQ price", last.c.toLocaleString("en-US"),
                       age > 240 ? "loss" : "",
                       age > 240 ? "market shut" : `${age} min old`);
  } catch {
    box.innerHTML = tile("levels in play", "not loaded", "",
      "The published bars could not be read.");
  }
}

/** The automated system, from its live state. */
async function system() {
  const box = $("dashsys");
  try {
    const r = await fetch("https://raw.githubusercontent.com/"
      + "clipscentral872-ctrl/aitrader-tjr-demo/main/state/demo_state.json",
      {cache: "no-cache"});
    if (!r.ok) throw new Error("no state");
    const st = await r.json();
    const books = [["main", st], ["wide", st.wide || {}]];
    const total = books.reduce((s, [, b]) => s + ((b.trades || []).length), 0);
    box.innerHTML = [
      tile("system polls", (st.polls || 0).toLocaleString("en-US"), "",
           "checks of the market it has made"),
      tile("system trades", String(total), "",
           "across both reward-to-risk books"),
      tile("still unproven", "yes", "loss",
           "nothing here has passed the full test"),
    ].join("");
  } catch {
    box.innerHTML = tile("the system", "not reachable", "",
      "Its live state could not be loaded just now.");
  }
}

export async function show() {
  $("dashyou").innerHTML = yours() + demo();
  $("dashleak").innerHTML = leak();
  await Promise.all([levelsInPlay(), system()]);
}

/** Redraw the parts that depend on the trade record, after an import. */
export function refreshRecord() {
  if (!$("dashyou")) return;
  $("dashyou").innerHTML = yours() + demo();
  $("dashleak").innerHTML = leak();
}
