/* The one screen that answers "where am I".
 *
 * It used to answer it with fourteen tiles, which is the same as not
 * answering it. This version says one number large, four small ones under it,
 * the single habit costing the most, six doors into the rest of the app, and
 * one line of what the market is doing. Nothing else.
 *
 * Two rules it still holds to, because a dashboard is where honesty usually
 * dies:
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
import * as P from "./profile.js";

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

const mine = () => (window.TRADES || [])
  .filter(t => (t.source || "live") === "live");

function fig(label, value, cls = "", note = "") {
  return `<div class="fig"><span class="fk">${esc(label)}</span>`
       + `<span class="fv ${cls}">${value}</span>`
       + (note ? `<span class="fn">${esc(note)}</span>` : "") + "</div>";
}

/* ------------------------------------------------------------ the face */

/* The one number that answers "how am I doing", said once and large.
 *
 * Not four numbers competing at the same size. An account balance and a win
 * rate and an expectancy all shouting at once is how a dashboard ends up
 * saying nothing. */
function hero() {
  const live = mine();
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

/** The three numbers worth carrying, small, plus the demo account. */
function figures() {
  const live = mine();
  const box = $("dashyou");
  if (!box) return;

  let d = null;
  try { d = JSON.parse(P.get("demo")); } catch { /* fresh */ }
  const demoFig = !d || typeof d.balance !== "number"
    ? fig("Demo", "not started", "", "open the Demo tab")
    : fig("Demo", plain(d.balance), d.balance - 100000 >= 0 ? "win" : "loss",
           d.pos ? `${d.pos.side.toLowerCase()} ${d.pos.qty} ${d.pos.symbol} open`
                 : `${money(d.balance - 100000)} over `
                   + `${(d.trades || []).length} trades`);

  if (!live.length) { box.innerHTML = demoFig; return; }

  const s = E.summarise(live);
  const scored = live.filter(t => t.got_r !== null && t.got_r !== undefined);
  box.innerHTML = [
    fig("Win rate", s.win_rate.toFixed(0) + "%", "", `${s.wins} of ${s.trades}`),
    fig("Expectancy", s.expectancy_r === null ? "no R"
         : (s.expectancy_r >= 0 ? "+" : "") + s.expectancy_r.toFixed(2) + "R",
         (s.expectancy_r || 0) >= 0 ? "win" : "loss",
         scored.length < live.length
           ? `on ${scored.length} of ${live.length}` : "a trade"),
    fig("Worst drawdown", plain(s.max_dd), "loss",
         `${s.worst_streak} losses in a row`),
    demoFig,
  ].join("");
}

/** The one habit costing the most, named rather than buried in a list. */
function leak() {
  const box = $("dashleak");
  if (!box) return;
  box.innerHTML = "";
  const live = mine();
  if (live.length < 3) return;
  const counts = new Map();
  for (const t of live)
    for (const f of (t.flags || []))
      if (FLAG_WORDS[f]) counts.set(f, (counts.get(f) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2) return;
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
  box.innerHTML = `<div class="dleak"><span class="dlt">Costing you most</span>`
    + `<p><b>${n} times:</b> ${esc(FLAG_WORDS[flag])}.${esc(cost)}</p></div>`;
}

/* ------------------------------------------------------------- the doors */

/* Line art rather than emoji: emoji render differently on every device and
   land at whatever size the font decides, which is the one thing a row of
   six identical cards cannot survive. */
const GLYPH = {
  diary: '<path d="M3 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H3zM21 5h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h7z"/>',
  demo: '<path d="M4 20V9M10 20V4M16 20v-7M4 13l6-6 6 6 5-6"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 3v4h4"/><path d="M11 9l5 3-5 3z"/>',
  videos: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3z"/>',
  system: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  learn: '<path d="M12 7 2 4l10-2 10 2zM4 8v7c0 2 4 4 8 4s8-2 8-4V8"/>',
};

const DOORS = [
  ["diary", "Diary", "Import a session, watch your trades back"],
  ["demo", "Demo", "Place a trade on today's market"],
  ["replay", "Replay", "Cut a past session and trade it out"],
  ["videos", "Videos", "Your winners and losers, side by side"],
  ["system", "System", "What the robot has been doing"],
  ["learn", "Learn", "The method, and what it has cost you"],
];

function doors() {
  const box = $("dashjumps");
  if (!box) return;
  box.innerHTML = DOORS.map(([go, name, sub]) =>
    `<button class="jump" data-go="${go}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[go]}</svg>`
    + `<b>${name}</b><span>${esc(sub)}</span></button>`).join("");
}

/* ---------------------------------------------------------- what is on */

function nrow(k, v, cls, note) {
  return `<div class="nrow"><span class="nk">${esc(k)}</span>`
       + `<span class="nv ${cls || ""}">${v}</span>`
       + `<span class="nn">${esc(note || "")}</span></div>`;
}

/* One line each, in the order that matters: what the price is, what is still
   untapped and how often that gets taken, and whether the robot is alive.
   The full working is on the Learn and System tabs. */
async function now() {
  const box = $("dashnow");
  if (!box) return;
  box.innerHTML = nrow("Loading", "&hellip;", "", "");
  const rows = [];

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
    const last = bars[bars.length - 1];
    const age = Math.round((Date.now() - last.ms) / 60000);
    rows.push(nrow("NQ", last.c.toLocaleString("en-US"), "",
                   age > 240 ? "market shut" : age + " min old"));

    const odds = RV.untappedNow(bars, null, RV.build(unpack(five)));
    if (!odds.size) {
      rows.push(nrow("Levels", "both taken", "",
                     "yesterday's high and low are gone"));
    } else {
      for (const [side, o] of odds) {
        rows.push(nrow(side === "above" ? "Prev high" : "Prev low",
          RV.pct(o.p) + (o.thin ? " ?" : ""), o.p >= 0.5 ? "win" : "",
          `${Math.round(Math.abs(o.price - last.c))} points away, `
          + `at ${o.price.toLocaleString("en-US")}`));
      }
    }
  } catch {
    rows.push(nrow("NQ", "not loaded", "", "the published bars would not read"));
  }

  try {
    const r = await fetch("https://raw.githubusercontent.com/"
      + "clipscentral872-ctrl/aitrader-tjr-demo/main/state/demo_state.json",
      {cache: "no-cache"});
    if (!r.ok) throw new Error("no state");
    const st = await r.json();
    const n = ((st.trades || []).length)
      + (((st.wide || {}).trades || []).length);
    rows.push(nrow("The robot", (st.polls || 0).toLocaleString("en-US"), "",
      `checks made, ${n} trade${n === 1 ? "" : "s"} taken, still unproven`));
  } catch {
    rows.push(nrow("The robot", "not reachable", "",
                   "its live state would not load"));
  }

  box.innerHTML = rows.join("");
}

/* ----------------------------------------------------------- the shape */

/* The shape of the account, behind the number rather than beside it. Drawn
   without axes on purpose: this is for the shape, and the Diary tab has the
   real curve with its scale. */
function spark() {
  const cv = $("hspark");
  if (!cv) return;
  const live = mine().slice().sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
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

  // The curve lives in the bottom half of the panel, so the number sitting
  // over it stays readable whichever way the account went.
  const top = H * 0.46;
  const Y = v => H - 2 - (v - lo + pad) / (hi - lo + pad * 2) * (H - top - 2);
  const X = i => i / (eq.length - 1) * W;

  // The starting balance, so a curve that never got back to it is obvious.
  x.strokeStyle = css("--line");
  x.setLineDash([3, 4]);
  x.beginPath(); x.moveTo(0, Y(base)); x.lineTo(W, Y(base)); x.stroke();
  x.setLineDash([]);

  const end = eq[eq.length - 1];
  const up = end >= base;
  const col = up ? css("--win") : css("--loss");
  // The fill fades from the curve's own high point, not from a fixed line: a
  // curve that lives near the bottom of the panel got a gradient that had
  // already faded to nothing by the time it reached it.
  const grad = x.createLinearGradient(0, Math.min(...eq.map(Y)), 0, H);
  grad.addColorStop(0, up ? "rgba(43,224,138,.26)" : "rgba(255,92,110,.24)");
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
  figures();
  leak();
  doors();
  spark();
  await now();
}

addEventListener("resize", () => {
  const pane = document.querySelector('.tabpane[data-tab="home"]');
  if (pane && !pane.hidden) spark();
});

/** Redraw the parts that depend on the trade record, after an import. */
export function refreshRecord() {
  if (!$("dashyou")) return;
  hero();
  figures();
  leak();
  spark();
}
