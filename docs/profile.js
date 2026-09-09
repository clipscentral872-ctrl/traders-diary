/* Whose journal this is.
 *
 * The app holds everything in this browser and nothing on a server, so two
 * people on two devices were never going to mix. Two people on ONE device
 * would have, and more to the point there was no sense of the journal
 * belonging to anyone: it was just whatever the browser happened to hold.
 *
 * A PIN fixes both. You set one the first time you open the app and that PIN
 * is your journal from then on. Everything gets stored under it: trades,
 * demo account, drawings, replay practice, videos, settings. Somebody else
 * on the same phone enters their own PIN and gets their own empty journal
 * with none of yours in it, and neither of you can see the other's.
 *
 * The PIN is not stored anywhere. What is stored, per journal, is a small
 * blob encrypted with it. Opening the app tries to decrypt those blobs with
 * what you typed, and the one that opens is yours. AES-GCM authenticates, so
 * a wrong PIN fails outright rather than producing rubbish.
 *
 * BE HONEST ABOUT WHAT THIS IS. Four digits is ten thousand guesses. It
 * keeps two people's journals apart on a shared device and it keeps a casual
 * look through browser storage from reading your trades. It is not a vault,
 * and anyone with the device and real intent would get in. The reason it is
 * four digits is that you type it every time you open the app on a phone.
 */
import * as LOCK from "./lock.js";

const LIST = "tradersdiary.profiles";
const LEGACY = "tradersdiary.";

let active = null;          // {id, name} once a PIN has been accepted
let pin = null;             // held in memory only, never written down

/** Every journal on this device. Names only: no PIN is recoverable from it. */
export function list() {
  try { return JSON.parse(localStorage.getItem(LIST)) || []; }
  catch { return []; }
}

function writeList(rows) {
  try { localStorage.setItem(LIST, JSON.stringify(rows)); }
  catch { /* nothing else will work either, and the gate will say so */ }
}

const rand = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
};

/* ------------------------------------------------------------- the keys */

/**
 * Where a named thing lives for the journal that is open.
 *
 * Null when none is. Falling back to the old unprefixed key looked harmless
 * and was the exact bug this module exists to prevent: a write made before a
 * PIN was accepted landed in a shared, unencrypted bucket that the next
 * person's journal would then adopt as its own. Nothing is stored without a
 * journal to store it in.
 */
export const key = name => active ? `tradersdiary.${active.id}.${name}` : null;

export function get(name) {
  const k = key(name);
  if (!k) return null;
  try { return localStorage.getItem(k); } catch { return null; }
}

export function set(name, value) {
  const k = key(name);
  if (!k) return false;
  try { localStorage.setItem(k, value); return true; }
  catch { return false; }
}

export function remove(name) {
  const k = key(name);
  if (!k) return;
  try { localStorage.removeItem(k); } catch { /* fine */ }
}

/** The videos are in IndexedDB, which needs a database name rather than a key. */
export const dbName = () => active ? `tradersdiary.${active.id}.vault`
                                   : "tradersdiary.novault";

export const current = () => active;
export const isOpen = () => !!active;
export const passcode = () => pin;

/* --------------------------------------------------------- opening one */

/**
 * Open the journal this PIN belongs to.
 *
 * @returns the profile, or null when no journal on this device uses it
 */
export async function open(code) {
  for (const p of list()) {
    try {
      const body = await LOCK.unlock(p.check, code);
      if (body && body.who === p.id) {
        active = {id: p.id, name: p.name};
        pin = code;
        return active;
      }
    } catch { /* not this one */ }
  }
  return null;
}

/**
 * Start a new journal on this PIN.
 *
 * Refused when one already uses it, because two journals behind one PIN
 * means one of them can never be reached again.
 */
export async function create(code, name) {
  if (await open(code)) return null;
  const id = rand();
  const check = await LOCK.lock({who: id}, code);
  const rows = list();
  rows.push({id, name: name || "My journal", check,
             created: new Date().toISOString().slice(0, 10)});
  writeList(rows);
  active = {id, name: name || "My journal"};
  pin = code;
  return active;
}

/**
 * Move the open journal onto a new PIN.
 *
 * Only the check blob changes here. The record itself is re-encrypted by the
 * caller, which does both or neither: a journal whose PIN opens it but whose
 * trades were left under the old one is worse than no change at all.
 */
/**
 * Change the PIN this journal opens with.
 *
 * Returns an undo, because the caller has a second thing to write after this
 * and that write can fail. Re-keying the journal and then failing to store
 * the re-locked record leaves a journal whose PIN opens it and whose trades
 * it cannot read: the old PIN no longer gets in, and the record inside is
 * still encrypted with it. That is losing the record, and there is no reset.
 *
 * Null when there is no journal to re-key, so a falsy return still means it
 * did not happen.
 */
export async function rekey(code) {
  if (!active) return null;
  const rows = list();
  const row = rows.find(r => r.id === active.id);
  if (!row) return null;
  const was = row.check;
  const wasPin = pin;
  // The id is taken now, not read back later. Undo runs on the failure path,
  // and reading `active` there would throw if the journal had been closed in
  // between. A recovery that can itself crash is not a recovery.
  const id = active.id;
  row.check = await LOCK.lock({who: active.id}, code);
  writeList(rows);
  pin = code;
  return {
    undo() {
      const back = list();
      const r = back.find(x => x.id === id);
      if (!r) return false;
      r.check = was;
      writeList(back);
      if (active && active.id === id) pin = wasPin;
      return true;
    },
  };
}

/** Forget the PIN, without touching anything stored. */
export function close() {
  active = null;
  pin = null;
}

/**
 * Take over a journal left by the version before profiles existed.
 *
 * Chris's own trades are under the unprefixed keys, encrypted with the
 * passcode he already set. Rather than ask him to export and import his own
 * record to get past a change he did not ask for, the old keys are moved
 * across the first time the PIN that opens them is used.
 */
const MOVE = ["v1", "demo", "draw", "replay", "tz", "showtz", "seeded"];

export function adoptLegacy() {
  if (!active) return 0;
  let moved = 0;
  for (const name of MOVE) {
    let v = null;
    try { v = localStorage.getItem(LEGACY + name); } catch { continue; }
    if (v == null) continue;
    // Never over the top of something already here: an adoption that
    // overwrites a real journal is worse than one that does nothing.
    if (get(name) != null) continue;
    if (set(name, v)) {
      try { localStorage.removeItem(LEGACY + name); } catch { /* fine */ }
      moved++;
    }
  }
  return moved;
}

/** Is there an old unprefixed journal sitting here? */
export function hasLegacy() {
  try { return localStorage.getItem(LEGACY + "v1") != null; }
  catch { return false; }
}
