/* The things you draw on the chart yourself.
 *
 * A box round a range, a line along the highs, a level you care about, the
 * retracement of a leg. Everything a platform gives you for marking up a
 * chart, and the reason marking up a chart is worth doing: a level you drew
 * yesterday and can still see today is the only way to know whether you were
 * right about it.
 *
 * Held in TIME AND PRICE, never in pixels. A drawing pinned to pixels moves
 * when you scroll and is gone when you change timeframe, which makes it
 * worse than nothing. In time and price it sits on the same candles at five
 * minutes and at four hours, which is the whole point.
 *
 * Kept per contract, in this browser, alongside everything else here.
 */

const KEY = "tradersdiary.draw";

/* The tools, in the order they sit on the rail. Each says how many points it
   needs and how it is drawn; nothing else in here knows about any of them. */
export const TOOLS = [
  {id: "cursor", name: "Cursor", pts: 0,
   icon: 'M4 3l14 8-6 1.6L9.6 19z'},
  {id: "trend", name: "Trend line", pts: 2,
   icon: 'M4 19L20 5'},
  {id: "hline", name: "Horizontal line", pts: 1,
   icon: 'M3 12h18'},
  {id: "hray", name: "Horizontal ray", pts: 1,
   icon: 'M4 12h13M17 12l-3-3M17 12l-3 3'},
  {id: "vline", name: "Vertical line", pts: 1,
   icon: 'M12 3v18'},
  {id: "box", name: "Rectangle", pts: 2,
   icon: 'M4 6h16v12H4z'},
  {id: "fib", name: "Fibonacci", pts: 2,
   icon: 'M3 5h18M3 10h18M3 15h13M3 20h9'},
  {id: "gann", name: "Gann box", pts: 2,
   icon: 'M4 4h16v16H4zM4 20L20 4M4 4l16 16M12 4v16M4 12h16'},
];

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const GANN = [0.25, 0.5, 0.75];
const HIT = 7;              // how close a click has to be, in pixels

let all = load();
let tool = "cursor";
let sym = "NQ";
let live = null;            // the one being drawn right now
let picked = null;          // the one selected
let onChange = () => {};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(all)); }
  catch { /* full or blocked; the drawings are still on screen */ }
}

const mine = () => (all[sym] = all[sym] || []);

export function setSymbol(s) { sym = s || "NQ"; picked = null; live = null; }
export function setTool(t) { tool = t; live = null; picked = null; }
export const getTool = () => tool;
export function setOnChange(fn) { onChange = fn || (() => {}); }
export const count = () => mine().length;

/** Everything for this contract, gone. */
export function clear() {
  all[sym] = [];
  picked = live = null;
  save();
  onChange();
}

/** Just the selected one. */
export function removeSelected() {
  if (!picked) return false;
  all[sym] = mine().filter(d => d !== picked);
  picked = null;
  save();
  onChange();
  return true;
}

export const hasSelection = () => !!picked;

/* ------------------------------------------------------------- geometry */

/** A drawing's two corners in pixels, or null when it is off screen. */
function box(d, s) {
  const x1 = s.xOfMs(d.a.ms), x2 = s.xOfMs(d.b ? d.b.ms : d.a.ms);
  const y1 = s.yOfPrice(d.a.price), y2 = s.yOfPrice(d.b ? d.b.price : d.a.price);
  if ([x1, x2, y1, y2].some(v => v == null || !Number.isFinite(v))) return null;
  return {x1, y1, x2, y2};
}

const near = (px, py, x1, y1, x2, y2) => {
  // Distance from a point to a segment, which is what "did I click the line"
  // actually asks.
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy) <= HIT;
};

/** Which drawing is under this point, newest first so the top one wins. */
function at(px, py, s) {
  const list = mine();
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    const b = box(d, s);
    if (!b) continue;
    const {x1, y1, x2, y2} = b;
    if (d.tool === "hline" && Math.abs(py - y1) <= HIT) return d;
    if (d.tool === "hray" && px >= x1 - HIT && Math.abs(py - y1) <= HIT) return d;
    if (d.tool === "vline" && Math.abs(px - x1) <= HIT) return d;
    if (d.tool === "trend" && near(px, py, x1, y1, x2, y2)) return d;
    if (d.tool === "box" || d.tool === "fib" || d.tool === "gann") {
      const l = Math.min(x1, x2), r = Math.max(x1, x2);
      const t = Math.min(y1, y2), bo = Math.max(y1, y2);
      // The edges, not the fill: a click inside a big box should still be
      // able to reach a line drawn across it.
      if (px >= l - HIT && px <= r + HIT && py >= t - HIT && py <= bo + HIT
          && (Math.abs(px - l) <= HIT || Math.abs(px - r) <= HIT
              || Math.abs(py - t) <= HIT || Math.abs(py - bo) <= HIT
              || d.tool !== "box"))
        return d;
    }
  }
  return null;
}

/* --------------------------------------------------------------- drawing */

function stroke(x, c, w, dash) {
  x.strokeStyle = c;
  x.lineWidth = w;
  x.setLineDash(dash || []);
}

function label(x, s, px, py, text, colour) {
  x.font = '10px Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",sans-serif';
  const w = x.measureText(text).width + 8;
  x.fillStyle = s.css("--ground");
  x.globalAlpha = 0.85;
  x.fillRect(px, py - 7, w, 14);
  x.globalAlpha = 1;
  x.fillStyle = colour;
  x.textBaseline = "middle";
  x.fillText(text, px + 4, py);
}

function one(d, s, on) {
  const b = box(d, s);
  if (!b) return;
  const x = s.ctx;
  const {x1, y1, x2, y2} = b;
  const c = on ? s.css("--accent") : (d.colour || s.css("--text"));
  const L = s.plot.x, R = s.plot.x + s.plot.w;
  const T = s.plot.y, B = s.plot.y + s.plot.h;
  x.save();

  if (d.tool === "hline" || d.tool === "hray") {
    stroke(x, c, on ? 2 : 1.4, d.tool === "hray" ? [] : [6, 4]);
    x.beginPath();
    x.moveTo(d.tool === "hray" ? x1 : L, y1);
    x.lineTo(R, y1);
    x.stroke();
    label(x, s, R - 62, y1 - 10, fmt(d.a.price), c);
  } else if (d.tool === "vline") {
    stroke(x, c, on ? 2 : 1.4, [6, 4]);
    x.beginPath();
    x.moveTo(x1, T);
    x.lineTo(x1, B);
    x.stroke();
  } else if (d.tool === "trend") {
    stroke(x, c, on ? 2.4 : 1.8);
    x.beginPath();
    x.moveTo(x1, y1);
    x.lineTo(x2, y2);
    x.stroke();
  } else if (d.tool === "box") {
    const l = Math.min(x1, x2), t = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    x.fillStyle = c;
    x.globalAlpha = 0.10;
    x.fillRect(l, t, w, h);
    x.globalAlpha = 1;
    stroke(x, c, on ? 2 : 1.4);
    x.strokeRect(l, t, w, h);
  } else if (d.tool === "fib") {
    // Drawn from the first point to the second, so 0 is where you started
    // and 1 is where you finished. Dragging the other way flips it, which is
    // how you mark a retracement of a fall rather than of a rise.
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    stroke(x, c, 1);
    x.globalAlpha = 0.55;
    x.beginPath();
    x.moveTo(x1, y1);
    x.lineTo(x2, y2);
    x.stroke();
    x.globalAlpha = 1;
    for (const f of FIB) {
      const yy = y1 + (y2 - y1) * f;
      const pr = d.a.price + (d.b.price - d.a.price) * f;
      stroke(x, c, f === 0.5 || f === 0.618 ? 1.6 : 1,
             f === 0 || f === 1 ? [] : [4, 3]);
      x.beginPath();
      x.moveTo(lo, yy);
      x.lineTo(hi, yy);
      x.stroke();
      label(x, s, lo + 3, yy - 8, f.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
            + "  " + fmt(pr), c);
    }
  } else if (d.tool === "gann") {
    const l = Math.min(x1, x2), r = Math.max(x1, x2);
    const t = Math.min(y1, y2), bo = Math.max(y1, y2);
    stroke(x, c, on ? 2 : 1.4);
    x.strokeRect(l, t, r - l, bo - t);
    stroke(x, c, 1, [3, 3]);
    x.globalAlpha = 0.7;
    x.beginPath();
    for (const f of GANN) {
      x.moveTo(l + (r - l) * f, t);
      x.lineTo(l + (r - l) * f, bo);
      x.moveTo(l, t + (bo - t) * f);
      x.lineTo(r, t + (bo - t) * f);
    }
    x.stroke();
    // The diagonals, which are the part of a Gann box anyone actually uses.
    stroke(x, c, 1.2, []);
    x.beginPath();
    x.moveTo(x1, y1);
    x.lineTo(x2, y2);
    x.moveTo(l, bo);
    x.lineTo(r, t);
    x.stroke();
    x.globalAlpha = 1;
  }

  if (on) {
    x.setLineDash([]);
    x.fillStyle = s.css("--accent");
    for (const [hx, hy] of (d.b ? [[x1, y1], [x2, y2]] : [[x1, y1]])) {
      x.beginPath();
      x.arc(hx, hy, 3.5, 0, Math.PI * 2);
      x.fill();
    }
  }
  x.restore();
}

const fmt = p => p == null ? "" : p.toLocaleString("en-US",
  {minimumFractionDigits: 2, maximumFractionDigits: 2});

/** Paint everything for this contract. Handed to the chart as its overlay. */
export function paint(chart) {
  const s = chart.surface;
  if (!s || !s.span) return;
  for (const d of mine()) one(d, s, d === picked);
  if (live) one(live, s, true);
}

/* ---------------------------------------------------------- interaction */

/**
 * A press on the chart.
 *
 * @returns true when the drawing layer took it, so the chart leaves it alone
 */
export function down(px, py, chart) {
  const s = chart.surface;
  if (!s || !s.span) return false;

  if (tool === "cursor") {
    const hit = at(px, py, s);
    if (hit === picked && !hit) return false;
    picked = hit;
    onChange();
    chart.repaint();
    return !!hit;          // a miss falls through to panning the chart
  }

  const ms = s.msOfX(px), price = s.priceOfY(py);
  if (ms == null || price == null) return false;
  const spec = TOOLS.find(t => t.id === tool);

  if (!live) {
    live = {tool, a: {ms, price}, b: spec.pts === 2 ? {ms, price} : null};
    if (spec.pts === 1) finish();
    return true;
  }
  live.b = {ms, price};
  finish();
  return true;
}

function finish() {
  if (!live) return;
  mine().push(live);
  picked = live;
  live = null;
  // One drawing per press of a tool, then back to the cursor. Leaving the
  // tool armed means the next click you meant as a selection draws another
  // box, which is how a chart ends up covered in them.
  tool = "cursor";
  save();
  onChange();
}

/** The mouse moving, while a two-point drawing is half made. */
export function move(px, py, chart) {
  if (!live || !live.b) return false;
  const s = chart.surface;
  if (!s) return false;
  const ms = s.msOfX(px), price = s.priceOfY(py);
  if (ms == null || price == null) return false;
  live.b = {ms, price};
  chart.repaint();
  return true;
}

/** Escape, or a right click: forget the half-made one. */
export function cancel() {
  if (!live && tool === "cursor") return false;
  live = null;
  tool = "cursor";
  onChange();
  return true;
}

/** True while a tool is armed, so the chart can show a crosshair and not pan. */
export const armed = () => tool !== "cursor" || !!live;
