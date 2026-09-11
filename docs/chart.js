/* An interactive chart, the way a charting platform behaves.
 *
 * The charts here used to be pictures: correct, and dead. You could not put
 * the cursor on a candle and read it, drag the chart back to see what led up
 * to something, or stretch the price axis to get a move out of a flat line.
 * Those three things are most of what using a chart actually is.
 *
 * What this gives every chart in the app:
 *
 *   Crosshair that follows the cursor with the bar's open, high, low, close
 *   under it, and price and time tags pinned on the axes.
 *   Drag the chart to pan, wheel to zoom about the cursor.
 *   Wheel or drag the price scale to stretch or flatten the move. Doing so
 *   takes the scale off auto, and A, or a double-click on it, puts it back.
 *   Drag the time scale to fit more bars in or spread them out.
 *   Double-click the chart, or the reset button, to fit everything again.
 *   Touch: one finger pans, two fingers pinch, on the same code paths.
 *
 * It draws to a canvas and owns none of the page around it, so the diary, the
 * demo and the replay share one chart rather than three that drift apart.
 */

const DPR = () => Math.min(3, globalThis.devicePixelRatio || 1);

const PAD = {left: 6, right: 78, top: 10, bottom: 26};
// The page's own face, so the chart does not read as a picture pasted
// into it. Numbers are tabular here by being a single width in Inter.
const FONT = '11px Inter,-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,sans-serif';
const MIN_BARS = 12;          // how far zooming in is allowed to go
const MAX_BARS = 3000;        // and out
// Empty slots left to the right of the newest bar, the way a chart leaves
// room to see where the price is heading rather than pinning it to the edge.
const RIGHT_MARGIN = 5;

/* Round numbers for a scale, the way every charting platform labels one.
 *
 * Labels spaced evenly across whatever range happened to be on screen came
 * out as 29,612.74 and 29,565.25: accurate, and useless to read. A person
 * reads a scale by its round numbers, and TradingView tightens them as you
 * zoom: tens, then fives, then fours. */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

/** Round prices inside lo..hi, roughly `want` of them. */
export function priceTicks(lo, hi, want) {
  const step = niceStep((hi - lo) / Math.max(1, want));
  const out = [];
  // Counted in whole steps, not added up, so a long run of 0.05s does not
  // drift into 1.1500000000000001.
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++)
    out.push(Math.round(k * step * 1e6) / 1e6);
  return out;
}

/* Minutes between time labels, from a short list of round intervals, so a
   label lands on the hour or the quarter hour rather than wherever the
   thirty-seventh bar happened to fall. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440];
export function timeEvery(minutesPerSlot, slotsPerLabel) {
  const want = minutesPerSlot * slotsPerLabel;
  return TIME_STEPS.find(v => v >= want) || 1440;
}

export function createChart(canvas, opts = {}) {
  const state = {
    bars: [],
    // The window on the data: `right` is the index just past the last visible
    // bar, `count` is how many are shown. Kept in bar space rather than pixels
    // so a resize does not move the view.
    right: 0,
    count: 140,
    /* The price scale, in one of two modes, the way TradingView has it.
     * Auto fits whatever bars are on screen and refits as you pan. Manual is
     * a fixed range of prices, entered the moment you scale or drag the
     * price yourself, and it stays exactly where you put it as you pan until
     * you press A or double-click the scale. Refitting underneath somebody
     * who has just set the scale by hand undoes what they did on the next
     * pan, which is what this did before. */
    auto: true,
    manual: null,        // {lo, hi} while the scale is manual
    hoverAxis: false,    // the cursor is over the price scale, so A shows
    follow: true,          // stay pinned to the newest bar until dragged back
    limit: null,           // replay: nothing at or past this index exists yet
    levels: [],
    position: null,
    trade: null,
    cross: null,
    hoverIndex: null,
    grab: null,          // "stop" or "target" while one is being dragged
    nearLevel: null,     // and which one the cursor is hovering
    picking: false,      // choosing where to cut the chart for a replay
  };

  let W = 0, H = 0, plot = {x: 0, y: 0, w: 0, h: 0}, scale = null;

  /* ------------------------------------------------------------ geometry */

  const lastIndex = () =>
    state.limit == null ? state.bars.length : Math.min(state.limit, state.bars.length);

  /* `right` can run past the last bar into empty space, the way a chart
   * leaves room to the right of the price. The bars keep their slots from
   * the left, so the gap is simply the slots with nothing in them yet. */
  function visible() {
    const last = lastIndex();
    const right = Math.max(1, Math.round(state.right));
    const start = Math.max(0, Math.min(last - 1, right - Math.round(state.count)));
    const end = Math.max(start + 1, Math.min(right, last));
    return {start, end, bars: state.bars.slice(start, end)};
  }

  function priceRange(bars) {
    // A scale set by hand stays set, whatever is on screen.
    if (!state.auto && state.manual) return {...state.manual};
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
    const p = state.position, t = state.trade;
    for (const v of [p && p.stop, p && p.target, p && p.entry,
                     t && t.stop, t && t.target, t && t.entry, t && t.exit])
      if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (hi === lo) { hi += 1; lo -= 1; }

    const mid = (hi + lo) / 2;
    const half = (hi - lo) / 2 * 1.12;
    return {lo: mid - half, hi: mid + half};
  }

  const xOf = i => plot.x + (i + 0.5) * (plot.w / Math.max(1, state.count));
  const barWidth = () => plot.w / Math.max(1, state.count);
  /* Which bar is under this x.
   *
   * Guarded, because a chart on a tab that has not been shown yet has no
   * width, and dividing by a bar width of zero gives NaN. That NaN then went
   * out through onPick as the bar to cut at, and the replay ended up on bar
   * NaN of 13,736 saying it was still loading. */
  const indexAt = px => {
    const bw = barWidth();
    return bw > 0 && Number.isFinite(px) ? Math.floor((px - plot.x) / bw) : 0;
  };

  /* ---------------------------------------------------------------- draw */

  const css = (() => {
    let cache = null, root = null;
    return n => {
      if (!cache) { root = getComputedStyle(document.documentElement); cache = {}; }
      return cache[n] !== undefined ? cache[n]
           : (cache[n] = root.getPropertyValue(n).trim());
    };
  })();

  /* Where things are, without drawing anything.
   *
   * Split out because hit testing needs `plot` to be current the moment a
   * pointer moves, while the picture itself can wait for the next frame. */
  function layout() {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    if (!W || !H) return false;
    plot = {x: PAD.left, y: PAD.top,
            w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom};
    return true;
  }

  let ctx = null;
  let frame = 0;

  /* Ask for a repaint. Several asks in the same frame are one repaint.
   *
   * This used to paint synchronously on every mousemove, and worse, it set
   * canvas.width every time, which throws away the drawing buffer and
   * allocates a new one. A mouse fires those faster than a screen refreshes,
   * so most of that work was drawing frames nobody ever saw, and the whole
   * app felt like it was dragging something heavy behind the cursor. */
  function draw() {
    if (!layout()) return;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }

  function paint() {
    const cs = DPR();
    if (!layout()) return;
    // Only when it actually changed. Assigning the same number still wipes
    // the buffer, which is the expensive part.
    const cw = Math.round(W * cs), ch = Math.round(H * cs);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      ctx = null;
    }
    const x = ctx || (ctx = canvas.getContext("2d"));
    x.setTransform(cs, 0, 0, cs, 0, 0);
    x.clearRect(0, 0, W, H);

    const v = visible();
    if (!v.bars.length) return;
    const r = priceRange(v.bars);
    if (!r) return;
    scale = {r, start: v.start};
    const Y = p => plot.y + plot.h - (p - r.lo) / (r.hi - r.lo) * plot.h;

    // Worked out once a frame and shared, because the grid and the labels
    // both need them and each costs a clock lookup per slot.
    const tt = timeTicks(v);
    grid(x, r, Y, v, tt);
    if (opts.beforeCandles) opts.beforeCandles({x, Y, plot, css, visible: v, range: r});
    zones(x, Y);
    volume(x, v);
    levels(x, Y);
    candles(x, Y, v);
    tradeMarks(x, Y, v);
    // Anything drawn ON the chart rather than under it: the boxes, lines and
    // levels you put there yourself. Above the candles because they are
    // notes about the candles, below the crosshair because the crosshair is
    // where the cursor is and must never be hidden.
    if (opts.overlay) opts.overlay(api);
    axes(x, r, Y, v, tt);
    // After the candles and after the axis, so an order is never buried by
    // the price it is waiting for, nor by the last-price tag.
    orders(x, Y);
    crosshair(x, Y, v, r);
    autoButton(x);
    cutter(x, v);
  }

  /* Choosing where to cut. A vertical line with a pair of scissors, which is
     what every platform shows for this, because "click somewhere on the
     chart" is otherwise an instruction with no visible target. */
  function cutter(x, v) {
    if (!state.picking || !state.cross) return;
    const k = Math.max(0, Math.min(v.bars.length - 1, indexAt(state.cross.x)));
    const b = v.bars[k];
    if (!b) return;
    const cx = Math.round(xOf(k)) + 0.5;

    // Everything after the cut is what would be hidden, shown greyed so the
    // choice is visible before it is made.
    x.save();
    x.fillStyle = "rgba(5,7,12,.62)";
    x.fillRect(cx, plot.y, plot.x + plot.w - cx, plot.h);
    x.strokeStyle = css("--accent");
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(cx, plot.y);
    x.lineTo(cx, plot.y + plot.h);
    x.stroke();

    // The scissors, drawn rather than a glyph so it does not depend on a font.
    const cy = plot.y + 15;
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(cx - 5, cy - 6); x.lineTo(cx + 4, cy + 5);
    x.moveTo(cx + 5, cy - 6); x.lineTo(cx - 4, cy + 5);
    x.stroke();
    x.beginPath();
    x.arc(cx - 5, cy + 7, 2.6, 0, Math.PI * 2);
    x.arc(cx + 5, cy + 7, 2.6, 0, Math.PI * 2);
    x.stroke();

    x.font = '600 10.5px "Chakra Petch", sans-serif';
    x.fillStyle = css("--accent");
    x.textBaseline = "middle";
    const label = (opts.timeLabel || (ms => String(ms)))(b.ms);
    const w = x.measureText(label).width;
    const lx = cx + 9 + w > plot.x + plot.w ? cx - 9 - w : cx + 9;
    x.fillText(label, lx, plot.y + plot.h - 12);
    x.restore();
  }

  // At the round prices and round times the labels sit on, so a line on
  // the chart can be read against the scale.
  function grid(x, r, Y, v, tt) {
    x.strokeStyle = css("--line-soft");
    x.lineWidth = 1;
    for (const p of priceTicks(r.lo, r.hi, Math.max(2, Math.floor(plot.h / 42)))) {
      const yy = Math.round(Y(p)) + 0.5;
      x.beginPath(); x.moveTo(plot.x, yy); x.lineTo(plot.x + plot.w, yy); x.stroke();
    }
    for (const t of tt) {
      const xx = Math.round(t.x) + 0.5;
      x.beginPath(); x.moveTo(xx, plot.y); x.lineTo(xx, plot.y + plot.h); x.stroke();
    }
  }

  /* The shading only. The lines and their labels are drawn over the candles
     by orders(), the way a chart with an order on it does it: the risk and
     the reward are behind the price, the orders themselves are in front. */
  function zones(x, Y) {
    const src = state.position || state.trade;
    if (!src || typeof src.entry !== "number") return;
    const box = (a, b, fill) => {
      if (typeof a !== "number" || typeof b !== "number") return;
      x.fillStyle = fill;
      x.fillRect(plot.x, Math.min(Y(a), Y(b)), plot.w, Math.abs(Y(a) - Y(b)));
    };
    box(src.entry, src.stop, css("--loss-zone"));
    box(src.entry, src.target, css("--win-zone"));
  }

  const ROUND = (x, l, t, w, h, r) => {
    if (x.roundRect) { x.beginPath(); x.roundRect(l, t, w, h, r); return; }
    x.beginPath();
    x.moveTo(l + r, t);
    x.arcTo(l + w, t, l + w, t + h, r);
    x.arcTo(l + w, t + h, l, t + h, r);
    x.arcTo(l, t + h, l, t, r);
    x.arcTo(l, t, l + w, t, r);
    x.closePath();
  };

  /* The badge on the end of an order line.
   *
   * White on the colour rather than a theme token: the fill is a saturated
   * red or green in both themes, and white is what reads on it. */
  function badge(x, y, text, colour, hot) {
    x.font = FONT;
    const w = Math.round(x.measureText(text).width) + 16;
    const left = plot.x + plot.w - w - 5;
    const top = Math.round(y) - 8;
    x.globalAlpha = hot ? 1 : 0.9;
    x.fillStyle = colour;
    ROUND(x, left, top, w, 16, 3);
    x.fill();
    x.globalAlpha = 1;
    x.fillStyle = "#fff";
    x.textBaseline = "middle";
    x.fillText(text, left + 8, Math.round(y) + 1);
  }

  /* The stop and the target, labelled the way TradingView labels them.
   *
   * A dashed line the whole width, a badge on the end of it saying what the
   * order is worth in money, and the price tagged on the axis in the same
   * colour. Dragging a line whose only readout is a number in a panel
   * somewhere else is guesswork; this puts both where the finger is. */
  function orders(x, Y) {
    const src = state.position || state.trade;
    if (!src || typeof src.entry !== "number") return;
    const live = !!(state.position && opts.onLevelMove);
    for (const [key, v, col, hue, dash, worth] of [
      ["entry", src.entry, css("--text"), css("--text"), [], null],
      ["stop", src.stop, css("--loss-faded"), css("--loss"), [5, 4], src.stopMoney],
      ["target", src.target, css("--win-faded"), css("--win"), [5, 4], src.targetMoney],
    ]) {
      if (typeof v !== "number") continue;
      const y = Y(v);
      if (y < plot.y - 20 || y > plot.y + plot.h + 20) continue;
      const hot = live && key !== "entry"
        && (state.grab === key || state.nearLevel === key);
      x.strokeStyle = hot ? hue : col;
      x.lineWidth = hot ? 2 : 1;
      x.setLineDash(dash);
      x.beginPath();
      x.moveTo(plot.x, Math.round(y) + 0.5);
      x.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      x.stroke();
      x.setLineDash([]);
      x.lineWidth = 1;
      if (key !== "entry" && worth) badge(x, y, worth, hue, hot);
      tag(x, y, fmtPrice(v), hue, key === "entry" ? css("--ground") : "#fff");
    }
  }

  function levels(x, Y) {
    if (!state.levels.length) return;
    x.font = FONT.replace("11px", "10px");
    x.textBaseline = "middle";

    /* Two levels at nearly the same price printed their names on top of each
       other, which turned "Prev Day High" and "New York High" into one
       unreadable smear. The lines still sit where the prices are; only the
       labels are nudged apart, in price order so the nudging cannot imply the
       wrong one is higher. */
    const on = state.levels
      .map(m => ({m, y: Y(m.price)}))
      .filter(o => o.y >= plot.y - 4 && o.y <= plot.y + plot.h + 4)
      .sort((a, b) => a.y - b.y);
    let lastLabel = -Infinity;
    for (const o of on) {
      const {m, y} = o;
      x.strokeStyle = x.fillStyle = m.colour || css("--faint");
      x.globalAlpha = 0.45;
      x.setLineDash([2, 4]);
      x.beginPath();
      x.moveTo(plot.x, Math.round(y) + 0.5);
      x.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      x.stroke();
      x.setLineDash([]);
      x.globalAlpha = 0.9;
      const ly = Math.max(y - 7, lastLabel + 11);
      x.fillText(m.label, plot.x + 5, ly);
      lastLabel = ly;
      x.globalAlpha = 1;
    }
  }

  /* Volume along the bottom, behind the price, the way TradingView shows it.
   *
   * On its own scale: the tallest bar in view fills the bottom fifth of the
   * pane, so it reads as the rhythm of the session rather than competing
   * with the candles for height. Coloured like its candle and drawn faint,
   * because it is context for the price rather than the price. Bars from
   * before the files carried volume have none, and draw nothing. */
  function volume(x, v) {
    let top = 0;
    for (const b of v.bars) if (b.v > top) top = b.v;
    if (!top) return;
    const w = Math.max(1, Math.min(barWidth() * 0.7, 24));
    const room = plot.h * 0.2;
    const base = plot.y + plot.h;
    x.globalAlpha = 0.28;
    v.bars.forEach((b, k) => {
      if (!b.v) return;
      const bh = Math.max(1, b.v / top * room);
      x.fillStyle = css(b.c >= b.o ? "--candle-up" : "--candle-dn");
      x.fillRect(xOf(k) - w / 2, base - bh, w, bh);
    });
    x.globalAlpha = 1;
  }

  function candles(x, Y, v) {
    const bw = barWidth();
    const body = Math.max(1, Math.min(bw * 0.66, 22));
    v.bars.forEach((b, k) => {
      const cx = xOf(k);
      const up = b.c >= b.o;
      x.strokeStyle = x.fillStyle = css(up ? "--candle-up" : "--candle-dn");
      // Past the exit of a finished trade, dim the candles rather than boxing
      // them off, so what happened next is visible without competing.
      const dim = state.trade && state.trade.exitIndex != null
        && v.start + k > state.trade.exitIndex;
      x.globalAlpha = dim ? 0.32 : 1;
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(Math.round(cx) + 0.5, Y(b.h));
      x.lineTo(Math.round(cx) + 0.5, Y(b.l));
      x.stroke();
      const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
      x.fillRect(cx - body / 2, y1, body, Math.max(1, y2 - y1));
      x.globalAlpha = 1;
    });
  }

  function tradeMarks(x, Y, v) {
    const t = state.trade;
    if (!t) return;
    const mark = (idx, price, colour, label) => {
      if (idx == null || idx < v.start || idx >= v.end) return;
      const cx = xOf(idx - v.start), cy = Y(price);
      x.fillStyle = colour;
      x.beginPath(); x.arc(cx, cy, 4.5, 0, Math.PI * 2); x.fill();
      x.strokeStyle = css("--ground");
      x.lineWidth = 1.5;
      x.beginPath(); x.arc(cx, cy, 4.5, 0, Math.PI * 2); x.stroke();
      x.font = '600 10px "Chakra Petch", sans-serif';
      x.textBaseline = "bottom";
      x.fillStyle = colour;
      x.fillText(label, cx + 7, cy - 3);
    };
    mark(t.entryIndex, t.entry, css("--text"), "in");
    mark(t.exitIndex, t.exit, t.pnl >= 0 ? css("--win") : css("--loss"), "out");
  }

  /** A label on the price axis, the way a chart names the level you are on. */
  function tag(x, yy, text, bg, fg) {
    x.font = FONT;
    const w = x.measureText(text).width + 10;
    const px = plot.x + plot.w + 3;
    x.fillStyle = bg;
    x.fillRect(px, yy - 8, Math.min(w, PAD.right - 5), 16);
    x.fillStyle = fg;
    x.textBaseline = "middle";
    x.fillText(text, px + 5, yy);
  }

  /** The same, on the time axis. Centred on the cursor and kept inside the
   *  plot, because a label half off the edge is worse than no label. */
  function timeTag(x, cx, text) {
    x.font = FONT;
    const w = x.measureText(text).width + 12;
    const left = Math.max(plot.x,
      Math.min(plot.x + plot.w - w, cx - w / 2));
    const top = plot.y + plot.h + 3;
    x.fillStyle = css("--text");
    x.fillRect(left, top, w, 17);
    x.fillStyle = css("--ground");
    x.textBaseline = "middle";
    x.textAlign = "center";
    x.fillText(text, left + w / 2, top + 8.5);
    x.textAlign = "left";
  }

  const fmtPrice = p => p.toLocaleString("en-US",
    {minimumFractionDigits: 2, maximumFractionDigits: 2});

  function axes(x, r, Y, v, tt) {
    x.font = FONT;
    x.textBaseline = "middle";
    x.fillStyle = css("--muted");
    const b = v.bars[v.bars.length - 1];
    const lastY = Y(b.c);
    for (const p of priceTicks(r.lo, r.hi, Math.max(2, Math.floor(plot.h / 42)))) {
      const yy = Y(p);
      // Never half off the top or the bottom of the scale.
      if (yy < plot.y + 6 || yy > plot.y + plot.h - 6) continue;
      // Nor half under the last-price tag. TradingView drops the round label
      // there rather than print a number peeking out from behind the one
      // that matters.
      if (Math.abs(yy - lastY) < 11) continue;
      x.fillText(fmtPrice(p), plot.x + plot.w + 8, yy);
    }
    tag(x, lastY, fmtPrice(b.c), css("--accent"), css("--ground"));

    x.textBaseline = "alphabetic";
    if (tt.length) {
      for (const t of tt) {
        // A new day is its date, in bold, the way a time scale marks one.
        x.font = t.bold ? FONT.replace("11px", "600 11px") : FONT;
        x.fillStyle = t.bold ? css("--text") : css("--muted");
        const w = x.measureText(t.text).width;
        const lx = Math.max(plot.x, Math.min(plot.x + plot.w - w, t.x - w / 2));
        x.fillText(t.text, lx, H - 8);
      }
      x.font = FONT;
      return;
    }
    // A chart given no way to read the clock still says where it starts and
    // where it ends.
    x.fillStyle = css("--faint");
    const stamp = opts.timeLabel || (ms => new Date(ms).toISOString().slice(11, 16));
    const first = stamp(v.bars[0].ms);
    const lastT = stamp(b.ms);
    x.fillText(first, plot.x, H - 8);
    x.fillText(lastT, plot.x + plot.w - x.measureText(lastT).width, H - 8);
  }

  function crosshair(x, Y, v, r) {
    const c = state.cross;
    if (!c) return;
    // Out into the empty space on the right as well, the way TradingView's
    // crosshair runs on past the last bar.
    const k = Math.max(0, Math.min(Math.round(state.count) - 1, indexAt(c.x)));
    const b = k < v.bars.length ? v.bars[k] : null;
    const cx = xOf(k);
    x.save();
    x.strokeStyle = css("--faint");
    x.setLineDash([3, 3]);
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(Math.round(cx) + 0.5, plot.y);
    x.lineTo(Math.round(cx) + 0.5, plot.y + plot.h);
    x.moveTo(plot.x, Math.round(c.y) + 0.5);
    x.lineTo(plot.x + plot.w, Math.round(c.y) + 0.5);
    x.stroke();
    x.restore();

    // Both readouts, the way TradingView does it: the price where the cursor
    // is, and the time of the bar under it, each on its own axis in a solid
    // label. A crosshair with no numbers on it is decoration.
    const price = r.hi - (c.y - plot.y) / plot.h * (r.hi - r.lo);
    tag(x, c.y, fmtPrice(price), css("--text"), css("--ground"));
    const ms = b ? b.ms : v.bars[v.bars.length - 1].ms
      + (k - (v.bars.length - 1)) * barStep(v.bars);
    // The whole date on the time scale, "Thu 10 Sep '26  03:15", as
    // TradingView prints it, rather than a bare time that could be any day.
    if (opts.timeParts) timeTag(x, cx, fullStamp(ms));
    else if (opts.timeLabel) timeTag(x, cx, opts.timeLabel(ms));
    // The bar before goes too, so a readout can show the change the way a
    // chart legend does.
    if (opts.onHover)
      opts.onHover(b, v.start + k, b ? state.bars[v.start + k - 1] || null : null);
  }

  /* ------------------------------------------------------------- gestures */

  function clampView() {
    /* Fractional on purpose.
     *
     * Rounding here threw away every trackpad step small enough to matter:
     * a one percent nudge on twenty bars is 20.2, which rounds straight back
     * to 20, so a slow careful scroll did nothing at all while a fast one
     * flew. The count is rounded where a whole number is actually needed,
     * which is choosing which bars to slice. */
    state.count = Math.max(MIN_BARS, Math.min(MAX_BARS, state.count));
    const end = lastIndex();
    // Into the empty space on the right, but never so far that the last bar
    // leaves the screen: a chart scrolled to nothing is a blank canvas.
    const room = Math.floor(state.count * 0.8);
    state.right = Math.max(Math.min(state.count, end),
                           Math.min(state.right, end + room));
    state.follow = state.right >= end;
  }

  function zoomAt(px, factor) {
    const v = visible();
    const anchor = v.start + Math.max(0, Math.min(state.count - 1, indexAt(px)));
    const before = state.count;
    // Fractional, not rounded, so a run of small trackpad steps accumulates
    // instead of each one being rounded away to nothing.
    state.count = Math.max(MIN_BARS, Math.min(MAX_BARS, state.count * factor));
    // Keep whatever was under the cursor under the cursor.
    const frac = before ? (anchor - v.start) / before : 0.5;
    state.right = Math.round(anchor + (1 - frac) * state.count);
    clampView();
    draw();
  }

  const onAxis = px => px > plot.x + plot.w;

  /** Which draggable level is under this point, if any.
   *
   *  Only when a position is actually open: dragging a line that belongs to a
   *  finished trade would be editing history. */
  function levelAt(p) {
    const src = state.position;
    if (!src || !opts.onLevelMove || !scale) return null;
    if (p.x < plot.x || p.x > plot.x + plot.w) return null;
    const {r} = scale;
    const Y = v => plot.y + plot.h - (v - r.lo) / (r.hi - r.lo) * plot.h;
    let best = null, bestD = 9;      // a fat enough target for a fingertip
    for (const key of ["stop", "target"]) {
      const v = src[key];
      if (typeof v !== "number") continue;
      const d = Math.abs(Y(v) - p.y);
      if (d < bestD) { best = key; bestD = d; }
    }
    return best;
  }

  const priceAt = y => {
    if (!scale) return null;
    const {r} = scale;
    return r.hi - (y - plot.y) / plot.h * (r.hi - r.lo);
  };

  /* Take the scale off auto, starting from exactly what is on screen, so
     the first touch never makes the chart jump. */
  function freeze() {
    if (state.auto && scale) state.manual = {...scale.r};
    state.auto = false;
  }
  function unfreeze() { state.auto = true; state.manual = null; }

  /* Stretch or flatten the price about the middle of what is showing. Above
     1 flattens, with more price on screen; below 1 stretches it taller. */
  function scalePrice(factor) {
    if (!scale) return;
    freeze();
    const r = state.manual || scale.r;
    const mid = (r.lo + r.hi) / 2;
    const half = Math.max(1e-6, (r.hi - r.lo) / 2 * factor);
    state.manual = {lo: mid - half, hi: mid + half};
    draw();
  }

  /* The A at the foot of the price scale.
   *
   * TradingView shows it while you hover the scale, lit when auto is on.
   * Here it also stays up whenever the scale is manual, because a frozen
   * scale with no visible way back is how somebody ends up reloading the
   * page to get their chart to fit again. */
  const autoBox = () => ({x: plot.x + plot.w + 8, y: plot.y + plot.h - 24, w: 20, h: 18});
  const inAuto = p => {
    const b = autoBox();
    return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  };
  function autoButton(x) {
    if (state.auto && !state.hoverAxis) return;
    const b = autoBox();
    x.save();
    x.fillStyle = state.auto ? css("--accent") : css("--raised") || "#fff";
    x.strokeStyle = state.auto ? css("--accent") : css("--line");
    x.lineWidth = 1;
    x.fillRect(b.x, b.y, b.w, b.h);
    x.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    // White on the lit button: the fill is the accent in both themes.
    x.fillStyle = state.auto ? "#fff" : css("--text");
    x.font = FONT.replace("11px", "600 11px");
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText("A", b.x + b.w / 2, b.y + b.h / 2 + 1);
    x.restore();
  }

  /* The shortest gap between two bars, which is the bar's own length. Gaps
     for the weekend and the daily break are longer, so the shortest is the
     honest one. */
  function barStep(bars) {
    let s = Infinity;
    for (let i = 1; i < Math.min(bars.length, 60); i++) {
      const d = bars[i].ms - bars[i - 1].ms;
      if (d > 0 && d < s) s = d;
    }
    return Number.isFinite(s) ? s : 60000;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":"
                + String(m % 60).padStart(2, "0");

  function fullStamp(ms) {
    const t = opts.timeParts(ms);
    const [yy, mm, dd] = t.day.split("-").map(Number);
    const wd = DAYS[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
    return `${wd} ${dd} ${MONTHS[mm - 1]} '${String(yy).slice(2)}  ${hm(t.min)}`;
  }

  /* Time labels at round times, the way a time scale reads: every quarter
   * hour zoomed in, every few hours zoomed out, the date where a day begins
   * and the month where a month does. This used to print the first time and
   * the last time and nothing between, which says nothing about where on the
   * chart anything happened. Carried on into the empty space on the right,
   * because that space is time too. Needs the caller's clock, since the
   * scale has to agree with every other time in the app. */
  function timeTicks(v) {
    if (!opts.timeParts || !v.bars.length) return [];
    const bw = barWidth();
    if (!(bw > 0)) return [];
    const minPx = 64;
    const step = barStep(v.bars);
    const stepMin = Math.max(1, Math.round(step / 60000));
    const every = timeEvery(stepMin, Math.max(1, Math.ceil(minPx / bw)));
    const lastBar = v.bars[v.bars.length - 1];
    const out = [];
    let prev = null, lastX = -Infinity;
    const slots = Math.round(state.count);
    for (let k = 0; k < slots; k++) {
      const ms = k < v.bars.length ? v.bars[k].ms
        : lastBar.ms + (k - (v.bars.length - 1)) * step;
      const t = opts.timeParts(ms);
      const newDay = prev !== null && t.day !== prev.day;
      const newMonth = newDay && t.day.slice(5, 7) !== prev.day.slice(5, 7);
      prev = t;
      const on = newDay
        || (every < 1440 && (every <= stepMin || t.min % every === 0));
      if (!on) continue;
      const cx = xOf(k);
      if (cx - lastX < minPx) continue;
      out.push({x: cx, bold: newDay,
                text: newMonth ? MONTHS[+t.day.slice(5, 7) - 1]
                  : newDay ? String(+t.day.slice(8, 10)) : hm(t.min)});
      lastX = cx;
    }
    return out;
  }

  let drag = null;
  let pressed = null;   // a press the drawing layer took
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {x: t.clientX - r.left, y: t.clientY - r.top};
  };

  function down(e) {
    const p = pos(e);
    // No size check here on purpose. A browser can report a zero-width
    // viewport for a moment, and refusing every press in that state means
    // the chart quietly stops responding. The NaN this was guarding against
    // is caught where it was produced instead, in indexAt and in cutAt.
    // The drawing layer gets first refusal. It takes the press when a tool is
    // armed or when one of its own shapes was hit, and declines otherwise so
    // the chart still pans normally.
    // The A button, before anything else can take the press.
    if ((!state.auto || state.hoverAxis) && inAuto(p)) {
      unfreeze();
      draw();
      return;
    }
    if (opts.onPress && opts.onPress(p.x, p.y)) {
      // Remembered so the release knows whether the press travelled. A drag
      // that went somewhere finishes a drawing; one that did not is still
      // the first of two clicks.
      pressed = {x: p.x, y: p.y, moved: false};
      return;
    }
    if (state.picking) {
      const v = visible();
      const k = Math.max(0, Math.min(v.bars.length - 1, indexAt(p.x)));
      state.picking = false;
      canvas.style.cursor = "crosshair";
      if (opts.onPick) opts.onPick(v.start + k);
      draw();
      return;
    }
    const grab = levelAt(p);
    if (grab) {
      // Dragging a level must not also pan the chart underneath it.
      state.grab = grab;
      drag = {...p, level: grab};
      canvas.style.cursor = "ns-resize";
      if (e.preventDefault) e.preventDefault();
      return;
    }
    // Where the press lands decides what the drag does: the price scale
    // stretches price, the time scale stretches time, the chart pans.
    const onTime = !onAxis(p.x) && p.y > plot.y + plot.h;
    drag = {...p, count: state.count, right: state.right,
            r: scale ? {...scale.r} : null, axis: onAxis(p.x), time: onTime,
            vert: false, moved: false};
    canvas.style.cursor = drag.axis ? "ns-resize" : onTime ? "ew-resize" : "grabbing";
  }

  function move(e) {
    const p = pos(e);
    if (pressed && !pressed.moved
        && Math.hypot(p.x - pressed.x, p.y - pressed.y) > 4)
      pressed.moved = true;
    if (opts.onDrag && opts.onDrag(p.x, p.y)) {
      state.cross = p.x < plot.x + plot.w ? p : null;
      draw();
      return;
    }
    if (!drag) {
      const near = levelAt(p);
      const axis = onAxis(p.x);
      const time = !axis && p.y > plot.y + plot.h;
      state.hoverAxis = axis;
      state.nearLevel = near;
      canvas.style.cursor = near || axis ? (inAuto(p) ? "pointer" : "ns-resize")
        : time ? "ew-resize" : "crosshair";
      state.cross = p.x < plot.x + plot.w && p.y <= plot.y + plot.h ? p : null;
      draw();
      return;
    }

    if (drag.level) {
      const price = priceAt(p.y);
      if (price != null) opts.onLevelMove(drag.level, price);
      draw();
      return;
    }

    const dx = p.x - drag.x, dy = p.y - drag.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;

    if (drag.axis && drag.r) {
      /* The price scale, TradingView's way round: pull it down to flatten
       * the move, push it up to stretch it. It went the other way here, so
       * the same hand movement did opposite things on the two charts. */
      state.auto = false;
      const f = Math.exp(dy / 200);
      const mid = (drag.r.lo + drag.r.hi) / 2;
      const half = Math.max(1e-6, (drag.r.hi - drag.r.lo) / 2 * f);
      state.manual = {lo: mid - half, hi: mid + half};
    } else if (drag.time) {
      // The time scale: drag right to spread the bars out, left to fit more
      // in, keeping the right-hand edge where it is.
      state.count = drag.count * Math.exp(-dx / 180);
      state.right = drag.right;
      clampView();
    } else {
      state.right = Math.round(drag.right - dx / barWidth());
      /* Up and down moves the price too, and a scale moved by hand is no
       * longer fitted, so it goes manual, starting from exactly what was on
       * screen at that moment so nothing jumps. Only past a few pixels, so a
       * sideways pan with a wobble in it does not freeze the scale. */
      if (!drag.vert && Math.abs(dy) > 6 && scale) {
        drag.vert = true;
        drag.vr = {...scale.r};
        drag.vy = p.y;
      }
      if (drag.vert) {
        const per = (drag.vr.hi - drag.vr.lo) / plot.h;
        const d = p.y - drag.vy;
        state.auto = false;
        state.manual = {lo: drag.vr.lo + d * per, hi: drag.vr.hi + d * per};
      }
      clampView();
    }
    state.cross = null;
    draw();
  }

  function up() {
    if (pressed) {
      const was = pressed;
      pressed = null;
      if (opts.onRelease) opts.onRelease(was.moved);
    }
    if (drag && drag.level && opts.onLevelDrop) opts.onLevelDrop(drag.level);
    drag = null;
    state.grab = null;
    canvas.style.cursor = state.nearLevel ? "ns-resize" : "crosshair";
    draw();
  }

  /* The wheel, and the trackpad, which are not the same input at all.
   *
   * A mouse wheel sends a handful of large notches. A trackpad sends dozens
   * of small ones per flick, at the refresh rate. A fixed twelve percent per
   * event is a reasonable notch and, multiplied by thirty events in a swipe,
   * is a chart that shoots from a day to a year and back before your finger
   * has stopped.
   *
   * So the step follows the size of the movement rather than ignoring it,
   * and browsers that report lines or pages instead of pixels are converted
   * first. A mouse notch of a hundred pixels comes out near eight percent,
   * about what it was; a small trackpad nudge comes out under one, which is
   * what makes a flick read as one smooth movement instead of a jump.
   *
   * Exponential rather than linear because zoom is multiplicative: two equal
   * pushes should scale equally, whichever direction they are in.
   */
  const SENSITIVITY = 0.0009;
  const MAX_STEP = 260;        // px of a single event that can count

  function wheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;

    /* Over the price scale the wheel stretches or flattens the price, the
     * way it does on TradingView: up to stretch the move taller, down to
     * flatten it. It used to zoom time wherever the cursor was, including
     * over the one part of the chart where nobody means that. */
    if (onAxis(pos(e).x)) {
      if (!dy) return;
      scalePrice(Math.exp(Math.max(-MAX_STEP, Math.min(MAX_STEP, dy)) * SENSITIVITY));
      return;
    }

    // A sideways flick pans, the way it does everywhere else, and does not
    // also zoom on the way past.
    if (Math.abs(dx) > Math.abs(dy)) {
      const bw = barWidth();
      if (bw > 0) {
        state.right = Math.round(state.right + dx / bw);
        clampView();
        draw();
      }
      return;
    }
    if (!dy) return;
    const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, dy));
    zoomAt(pos(e).x, Math.exp(step * SENSITIVITY));
  }

  // Two fingers pinch, one finger pans. Same maths as the mouse paths.
  let pinch = null;
  const spread = t => Math.hypot(t[0].clientX - t[1].clientX,
                                 t[0].clientY - t[1].clientY);
  function touchStart(e) {
    if (e.touches.length === 2) { pinch = {d: spread(e.touches), count: state.count}; return; }
    pinch = null;
    down(e);
  }

  // A fingertip is bigger than a cursor, so the grip is met halfway: a tap
  // near a level arms it before the drag begins.
  canvas.addEventListener("touchstart", e => {
    if (e.touches.length === 1) state.nearLevel = levelAt(pos(e));
  }, {passive: true});
  function touchMove(e) {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const d = spread(e.touches);
      if (d > 0) {
        state.count = pinch.count * (pinch.d / d);
        clampView();
        draw();
      }
      return;
    }
    if (drag) { e.preventDefault(); move(e); }
  }

  canvas.style.cursor = "crosshair";
  canvas.style.touchAction = "none";
  canvas.addEventListener("mousedown", down);
  addEventListener("mousemove", e => {
    if (drag) move(e);
    else if (e.target === canvas) move(e);
  });
  addEventListener("mouseup", up);
  canvas.addEventListener("mouseleave", () => {
    if (!drag) { state.cross = null; state.hoverIndex = null; state.hoverAxis = false; draw(); if (opts.onHover) opts.onHover(null); }
  });
  canvas.addEventListener("wheel", wheel, {passive: false});
  // Double-click the price scale to put it back on auto, as TradingView
  // does. Anywhere else, fit the whole chart again.
  canvas.addEventListener("dblclick", e => {
    if (onAxis(pos(e).x)) { unfreeze(); draw(); return; }
    api.fit();
  });
  canvas.addEventListener("touchstart", touchStart, {passive: true});
  canvas.addEventListener("touchmove", touchMove, {passive: false});
  canvas.addEventListener("touchend", () => { pinch = null; up(); });

  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(canvas);

  /* ----------------------------------------------------------------- api */

  /* Time and price to pixels, and back.
   *
   * Drawings are held in time and price, never in pixels, so they stay where
   * you put them through a zoom, a pan, and a change of timeframe. A box
   * pinned to pixels is a box that moves when you scroll, which is worse
   * than no box.
   */
  function msToX(ms) {
    const v = visible();
    if (!v.bars.length) return null;
    // Between bars as well as on them, so a line does not snap to the open.
    const first = v.bars[0].ms, last = v.bars[v.bars.length - 1].ms;
    if (v.bars.length === 1) return xOf(0);
    const step = (last - first) / (v.bars.length - 1);
    return xOf((ms - first) / (step || 1));
  }

  function xToMs(px) {
    const v = visible();
    if (!v.bars.length) return null;
    const first = v.bars[0].ms, last = v.bars[v.bars.length - 1].ms;
    const step = v.bars.length > 1
      ? (last - first) / (v.bars.length - 1) : 60000;
    const i = (px - plot.x) / Math.max(1e-6, barWidth()) - 0.5;
    return first + i * step;
  }

  const priceToY = p => scale
    ? plot.y + plot.h - (p - scale.r.lo) / (scale.r.hi - scale.r.lo) * plot.h
    : null;

  const yToPrice = y => scale
    ? scale.r.hi - (y - plot.y) / plot.h * (scale.r.hi - scale.r.lo)
    : null;

  const api = {
    setData(bars, {keepView = false} = {}) {
      const wasFollowing = state.follow;
      state.bars = bars || [];
      if (!keepView || state.right === 0) {
        state.right = lastIndex() + RIGHT_MARGIN;
        state.follow = true;
        // New data is a new contract or timeframe, so it is fitted again.
        state.auto = true;
        state.manual = null;
      } else if (wasFollowing) {
        state.right = lastIndex() + RIGHT_MARGIN;
      }
      clampView();
      draw();
      return api;
    },
    /** Replay: nothing at or past this index has happened yet. */
    setLimit(i) {
      state.limit = i;
      if (state.follow) state.right = lastIndex() + RIGHT_MARGIN;
      clampView();
      draw();
      return api;
    },
    setLevels(list) { state.levels = list || []; draw(); return api; },
    /** Choose where to cut the chart. The next click on it picks a bar. */
    pick(on) {
      state.picking = !!on;
      canvas.style.cursor = on ? "crosshair" : "crosshair";
      draw();
      return api;
    },
    get picking() { return state.picking; },

    /* What a drawing layer needs and nothing more: where a time and a price
       land on screen, where a click lands in time and price, the canvas to
       paint on, and the box it is allowed to paint in. */
    get surface() {
      return {
        ctx: ctx || (ctx = canvas.getContext("2d")),
        plot, css,
        xOfMs: msToX, yOfPrice: priceToY,
        msOfX: xToMs, priceOfY: yToPrice,
        span: (() => { const v = visible(); return v.bars.length
          ? {from: v.bars[0].ms, to: v.bars[v.bars.length - 1].ms} : null; })(),
      };
    },
    repaint() { draw(); return api; },
    setPosition(p) { state.position = p || null; draw(); return api; },
    setTrade(t) { state.trade = t || null; draw(); return api; },
    /** Fit everything again, which is what double-click and reset do. */
    fit(count) {
      state.auto = true;
      state.manual = null;
      state.count = count || Math.min(180, Math.max(MIN_BARS, lastIndex()));
      // Asked to fit everything: widen by the margin, so the first bar does
      // not fall off the left to make room for the space on the right.
      if (state.count >= lastIndex()) state.count = lastIndex() + RIGHT_MARGIN;
      state.right = lastIndex() + RIGHT_MARGIN;
      state.follow = true;
      clampView();
      draw();
      return api;
    },
    zoomIn() { zoomAt(plot.x + plot.w / 2, 1 / 1.3); return api; },
    zoomOut() { zoomAt(plot.x + plot.w / 2, 1.3); return api; },
    panBy(bars) {
      state.right = Math.round(state.right + bars);
      clampView();
      draw();
      return api;
    },
    /** Centre the view on a bar, used when jumping to a trade. */
    focus(index, count) {
      if (count) state.count = count;
      state.right = Math.round(index + state.count * 0.35);
      clampView();
      draw();
      return api;
    },
    draw,
    get view() { return {...visible(), count: state.count, follow: state.follow}; },
    destroy() { if (ro) ro.disconnect(); },
  };
  return api;
}
