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
    tile("win rate", s.win_rate.toFixed(0) + "%", "",
         `${s.wins} of ${s.trades}, average win ${plain(s.avg_win)} against `
         + `${plain(Math.abs(s.avg_loss))} lost`),
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

/* The one number that answers "how am I doing", said once and large.
 *
 * Not four numbers competing at the same size. An account balance and a win
 * rate and an expectancy all shouting at once is how a dashboard ends up
 * saying nothing. */
function hero() {
  const live = (window.TRADES || []).filter(t => (t.source || "live") === "live");
  const box = $("hmain");
  if (!box) return;
  if (!live.length) {
    box.innerHTML = '<span class="hk">Your record</span>'
      + '<span class="hv">Nothing yet</span>'
      + '<span class="hsub">Import your six TradingView exports on the Diary '
      + 'tab and everything here fills in.</span>';
    return;
  }
  const s = E.summarise(live);
  const days = new Set(live.map(t => t.open_t.slice(0, 10))).size;
  box.innerHTML = '<span class="hk">Your record</span>'
    + `<span class="hv ${s.pnl >= 0 ? "win" : "loss"}">${money(s.pnl)}</span>`
    + `<span class="hsub">${s.trades} trades over ${days} `
    + `day${days === 1 ? "" : "s"}, ${s.wins}W / ${s.losses}L`
    + (s.expectancy_r === null ? ""
       : `, ${(s.expectancy_r >= 0 ? "+" : "") + s.expectancy_r.toFixed(2)}R a trade`)
    + "</span>";
}

/* The shape of the account, which a row of numbers cannot show. Drawn small
   and without axes on purpose: this is for the shape, and the Diary tab has
   the real curve with its scale. */
function spark() {
  const cv = $("hspark");
  if (!cv) return;
  const live = (window.TRADES || [])
    .filter(t => (t.source || "live") === "live")
    .slice().sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
  const note = $("hcnote");
  const dpr = Math.min(3, devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  const css = n => getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim();

  if (live.length < 2) {
    if (note) note.textContent = live.length ? "one trade so far" : "";
    return;
  }
  const base = window.START == null ? 0 : window.START;
  const eq = [base];
  for (const t of live) eq.push(eq[eq.length - 1] + t.pnl);
  const lo = Math.min(...eq), hi = Math.max(...eq);
  const pad = (hi - lo) * 0.12 || 1;
  const Y = v => H - 4 - (v - lo + pad) / (hi - lo + pad * 2) * (H - 8);
  const X = i => 2 + i / (eq.length - 1) * (W - 4);

  // The starting balance, so a curve that never got back to it is obvious.
  x.strokeStyle = css("--line");
  x.setLineDash([3, 3]);
  x.beginPath(); x.moveTo(0, Y(base)); x.lineTo(W, Y(base)); x.stroke();
  x.setLineDash([]);

  const end = eq[eq.length - 1];
  const col = end >= base ? css("--win") : css("--loss");
  const grad = x.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, end >= base ? "rgba(43,224,138,.22)" : "rgba(255,92,110,.2)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  x.beginPath();
  x.moveTo(X(0), Y(eq[0]));
  eq.forEach((v, i) => x.lineTo(X(i), Y(v)));
  x.lineTo(X(eq.length - 1), H);
  x.lineTo(X(0), H);
  x.closePath();
  x.fillStyle = grad;
  x.fill();

  x.beginPath();
  eq.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v)));
  x.strokeStyle = col;
  x.lineWidth = 2;
  x.stroke();

  x.beginPath();
  x.arc(X(eq.length - 1), Y(end), 3.5, 0, Math.PI * 2);
  x.fillStyle = col;
  x.fill();

  if (note) note.textContent = plain(base) + " to " + plain(end);
}

export async function show() {
  hero();
  $("dashyou").innerHTML = yours() + demo();
  $("dashleak").innerHTML = leak();
  spark();
  await Promise.all([levelsInPlay(), system()]);
}

addEventListener("resize", () => {
  const pane = document.querySelector('.tabpane[data-tab="home"]');
  if (pane && !pane.hidden) spark();
});

/** Redraw the parts that depend on the trade record, after an import. */
export function refreshRecord() {
  if (!$("dashyou")) return;
  hero();
  $("dashyou").innerHTML = yours() + demo();
  $("dashleak").innerHTML = leak();
  spark();
}
