/**
 * The chart's indicators, listed in its legend the way TradingView lists
 * them: a row each, with an eye to hide it and show it again.
 *
 * The choice is kept with the journal and holds on every chart at once, the
 * way a TradingView layout keeps it, so hiding the volume on the Replay hides
 * it on the Demo too and it stays hidden after the app is closed.
 */
import * as P from "./profile.js";

export const LIST = [
  {id: "vol", name: "Volume"},
  {id: "vwap", name: "VWAP", colour: "#D6336C"},
  {id: "levels", name: "Session levels"},
];

/** The colour an indicator draws in, for its line and its value. */
export const colour = id => (LIST.find(x => x.id === id) || {}).colour;

const KEY = "indicators";
let on = null;
const subs = new Set();

function read() {
  if (on) return on;
  let saved = {};
  try { saved = JSON.parse(P.get(KEY)) || {}; } catch { /* none kept yet */ }
  // Everything on until you say otherwise, as a new TradingView chart is.
  on = Object.fromEntries(LIST.map(x => [x.id, saved[x.id] !== false]));
  return on;
}

export const isOn = id => !!read()[id];

export function set(id, value) {
  read()[id] = !!value;
  P.set(KEY, JSON.stringify(on));
  subs.forEach(f => f());
}

export const toggle = id => set(id, !isOn(id));

/** Called whenever one is switched, so every chart can repaint. */
export function onChange(f) { subs.add(f); }

/** Read again once a journal is open; before that there is nothing to read. */
export function reopen() {
  on = null;
  subs.forEach(f => f());
}

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const SHUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><path d="M4 20 20 4"/></svg>';

/**
 * The rows, as markup to append to a legend.
 *
 * @param values  what each one reads at the bar under the cursor, by id
 * @param only    which of them this chart has at all
 */
export function rows(values = {}, only = LIST.map(x => x.id)) {
  return '<div class="pinds">' + LIST.filter(x => only.includes(x.id)).map(x => {
    const shown = isOn(x.id);
    const v = values[x.id];
    return `<div class="pind${shown ? "" : " off"}">`
      + `<span class="pn">${x.name}</span>`
      + (shown && v != null && v !== ""
         ? `<span class="pv"${x.colour ? ` style="color:${x.colour}"` : ""}>${v}</span>`
         : "")
      + `<button class="peye" type="button" data-ind="${x.id}"`
      + ` aria-pressed="${shown}" title="${shown ? "Hide" : "Show"} ${x.name}"`
      + ` aria-label="${shown ? "Hide" : "Show"} ${x.name}">`
      + (shown ? EYE : SHUT) + "</button></div>";
  }).join("") + "</div>";
}

/** Listen on a legend for the eyes in it. Once per legend. */
export function wire(box) {
  if (!box || box.dataset.inds) return;
  box.dataset.inds = "1";
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-ind]");
    if (b) toggle(b.dataset.ind);
  });
}
