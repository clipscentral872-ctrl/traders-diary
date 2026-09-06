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
 *   Drag the price axis to stretch or flatten the move.
 *   Double-click, or the reset button, to fit everything again.
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

export function createChart(canvas, opts = {}) {
  const state = {
    bars: [],
    // The window on the data: `right` is the index just past the last visible
    // bar, `count` is how many are shown. Kept in bar space rather than pixels
    // so a resize does not move the view.
    right: 0,
    count: 140,
    // Vertical. `zoom` of 1 fits the visible range; above 1 stretches it.
    // `shift` moves the middle, in fractions of the fitted range.
    zoom: 1,
    shift: 0,
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

  function visible() {
    const end = Math.max(1, Math.min(state.right, lastIndex()));
    const start = Math.max(0, end - state.count);
    return {start, end, bars: state.bars.slice(start, end)};
  }

  function priceRange(bars) {
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
    const p = state.position, t = state.trade;
    for (const v of [p && p.stop, p && p.target, p && p.entry,
                     t && t.stop, t && t.target, t && t.entry, t && t.exit])
      if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (hi === lo) { hi += 1; lo -= 1; }

    const mid = (hi + lo) / 2;
    const half = (hi - lo) / 2 * 1.12 / state.zoom;
    const move = state.shift * half * 2;
    return {lo: mid - half + move, hi: mid + half + move};
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

    grid(x, r, Y, v);
    if (opts.beforeCandles) opts.beforeCandles({x, Y, plot, css, visible: v, range: r});
    zones(x, Y);
    levels(x, Y);
    candles(x, Y, v);
    tradeMarks(x, Y, v);
    axes(x, r, Y, v);
    crosshair(x, Y, v, r);
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

  function grid(x, r, Y) {
    x.strokeStyle = css("--line-soft");
    x.lineWidth = 1;
    for (let g = 0; g <= 5; g++) {
      const yy = Math.round(plot.y + plot.h * g / 5) + 0.5;
      x.beginPath(); x.moveTo(plot.x, yy); x.lineTo(plot.x + plot.w, yy); x.stroke();
    }
  }

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
    const live = state.position && opts.onLevelMove;
    for (const [key, v, col, dash] of [
      ["stop", src.stop, css("--loss-faded"), [5, 4]],
      ["target", src.target, css("--win-faded"), [5, 4]],
      ["entry", src.entry, css("--text"), []],
    ]) {
      if (typeof v !== "number") continue;
      const hot = live && key !== "entry"
        && (state.grab === key || state.nearLevel === key);
      x.strokeStyle = hot ? css(key === "stop" ? "--loss" : "--win") : col;
      x.lineWidth = hot ? 2 : 1;
      x.setLineDash(dash);
      x.beginPath();
      x.moveTo(plot.x, Y(v) + 0.5); x.lineTo(plot.x + plot.w, Y(v) + 0.5);
      x.stroke();
      x.setLineDash([]);
      x.lineWidth = 1;

      // A line you can move should look like one. The grip only appears on
      // the two that are actually draggable, so the entry does not invite a
      // drag that would do nothing.
      if (live && key !== "entry") {
        const gy = Math.round(Y(v));
        x.fillStyle = hot ? css(key === "stop" ? "--loss" : "--win") : col;
        x.fillRect(plot.x + plot.w - 26, gy - 5, 20, 10);
        x.fillStyle = css("--ground");
        for (let g = 0; g < 3; g++)
          x.fillRect(plot.x + plot.w - 22 + g * 5, gy - 2, 1.5, 4);
      }
    }
  }

  function levels(x, Y) {
    if (!state.levels.length) return;
    x.font = FONT.replace("11px", "10px");
    x.textBaseline = "middle";
    for (const m of state.levels) {
      const y = Y(m.price);
      if (y < plot.y - 4 || y > plot.y + plot.h + 4) continue;
      x.strokeStyle = x.fillStyle = m.colour || css("--faint");
      x.globalAlpha = 0.45;
      x.setLineDash([2, 4]);
      x.beginPath();
      x.moveTo(plot.x, Math.round(y) + 0.5);
      x.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      x.stroke();
      x.setLineDash([]);
      x.globalAlpha = 0.9;
      x.fillText(m.label, plot.x + 5, y - 7);
      x.globalAlpha = 1;
    }
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

  function axes(x, r, Y, v) {
    x.font = FONT;
    x.textBaseline = "middle";
    x.fillStyle = css("--muted");
    for (let g = 0; g <= 5; g++) {
      const p = r.hi - (r.hi - r.lo) * g / 5;
      x.fillText(fmtPrice(p), plot.x + plot.w + 8, plot.y + plot.h * g / 5);
    }
    const b = v.bars[v.bars.length - 1];
    tag(x, Y(b.c), fmtPrice(b.c), css("--accent"), css("--ground"));

    x.fillStyle = css("--faint");
    x.textBaseline = "alphabetic";
    const stamp = opts.timeLabel || (ms => new Date(ms).toISOString().slice(11, 16));
    const first = stamp(v.bars[0].ms);
    const lastT = stamp(b.ms);
    x.fillText(first, plot.x, H - 8);
    x.fillText(lastT, plot.x + plot.w - x.measureText(lastT).width, H - 8);
  }

  function crosshair(x, Y, v, r) {
    const c = state.cross;
    if (!c) return;
    const k = Math.max(0, Math.min(v.bars.length - 1, indexAt(c.x)));
    const b = v.bars[k];
    if (!b) return;
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
    if (opts.timeLabel) timeTag(x, cx, opts.timeLabel(b.ms));
    if (opts.onHover) opts.onHover(b, v.start + k);
  }

  /* ------------------------------------------------------------- gestures */

  function clampView() {
    state.count = Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round(state.count)));
    const end = lastIndex();
    state.right = Math.max(Math.min(state.count, end),
                           Math.min(state.right, end));
    state.follow = state.right >= end;
  }

  function zoomAt(px, factor) {
    const v = visible();
    const anchor = v.start + Math.max(0, Math.min(state.count - 1, indexAt(px)));
    const before = state.count;
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

  let drag = null;
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {x: t.clientX - r.left, y: t.clientY - r.top};
  };

  function down(e) {
    const p = pos(e);
    // Nothing on a chart with no size can be pointed at meaningfully.
    if (!plot.w || !plot.h) return;
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
    drag = {...p, count: state.count, right: state.right,
            zoom: state.zoom, shift: state.shift, axis: onAxis(p.x), moved: false};
    canvas.style.cursor = drag.axis ? "ns-resize" : "grabbing";
  }

  function move(e) {
    const p = pos(e);
    if (!drag) {
      const near = levelAt(p);
      if (near !== state.nearLevel) {
        state.nearLevel = near;
        canvas.style.cursor = near ? "ns-resize" : "crosshair";
      }
      state.cross = p.x < plot.x + plot.w ? p : null;
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

    if (drag.axis) {
      // Dragging the price axis stretches the move rather than moving it.
      state.zoom = Math.max(0.25, Math.min(12, drag.zoom * (1 + dy / 220)));
    } else {
      state.right = Math.round(drag.right - dx / barWidth());
      state.shift = drag.shift + dy / plot.h * 0.9;
      clampView();
    }
    state.cross = null;
    draw();
  }

  function up() {
    if (drag && drag.level && opts.onLevelDrop) opts.onLevelDrop(drag.level);
    drag = null;
    state.grab = null;
    canvas.style.cursor = state.nearLevel ? "ns-resize" : "crosshair";
    draw();
  }

  function wheel(e) {
    e.preventDefault();
    zoomAt(pos(e).x, e.deltaY > 0 ? 1.12 : 1 / 1.12);
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
    if (!drag) { state.cross = null; state.hoverIndex = null; draw(); if (opts.onHover) opts.onHover(null); }
  });
  canvas.addEventListener("wheel", wheel, {passive: false});
  canvas.addEventListener("dblclick", () => api.fit());
  canvas.addEventListener("touchstart", touchStart, {passive: true});
  canvas.addEventListener("touchmove", touchMove, {passive: false});
  canvas.addEventListener("touchend", () => { pinch = null; up(); });

  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(canvas);

  /* ----------------------------------------------------------------- api */

  const api = {
    setData(bars, {keepView = false} = {}) {
      const wasFollowing = state.follow;
      state.bars = bars || [];
      if (!keepView || state.right === 0) {
        state.right = lastIndex();
        state.follow = true;
      } else if (wasFollowing) {
        state.right = lastIndex();
      }
      clampView();
      draw();
      return api;
    },
    /** Replay: nothing at or past this index has happened yet. */
    setLimit(i) {
      state.limit = i;
      if (state.follow) state.right = lastIndex();
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
    setPosition(p) { state.position = p || null; draw(); return api; },
    setTrade(t) { state.trade = t || null; draw(); return api; },
    /** Fit everything again, which is what double-click and reset do. */
    fit(count) {
      state.zoom = 1;
      state.shift = 0;
      state.count = count || Math.min(180, Math.max(MIN_BARS, lastIndex()));
      state.right = lastIndex();
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
