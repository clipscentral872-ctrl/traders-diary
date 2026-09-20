/**
 * A folder the journal reads its exports out of, so importing is just
 * exporting.
 *
 * Chris exports from Tradovate at the end of a session and the file lands in
 * Downloads. Dragging it here afterwards is the only manual step left, and it
 * is the step that gets skipped on the days that matter. So the journal can be
 * pointed at that folder once, and from then on it picks up anything new by
 * itself whenever it is opened.
 *
 * NOTHING LEAVES THE DEVICE. The browser hands this page a handle to one
 * folder the person chose; the files are read in the page exactly as a dropped
 * file is. There is no server in this app to send them to.
 *
 * Only files that look like a broker or platform export are opened, by name
 * and extension, so pointing it at Downloads does not mean reading Downloads.
 *
 * Chrome and Edge on a laptop only. Safari and every phone lack the File
 * System Access API, and there the drop box is still the way; `supported()`
 * says which world you are in so the button can be hidden rather than broken.
 */

const DB = "tradersdiary.fs";
const STORE = "handles";
const KEY = "exports";

/** Files worth opening: a CSV whose name looks like an export. */
export const LOOKS_LIKE_EXPORT =
  /(tradovate|tradingview|paper-trading|order|fill|activity|position|account)/i;

export const supported = () => typeof window.showDirectoryPicker === "function";

/* ------------------------------------------------------------ the handle */

/* A folder handle cannot go in localStorage: it is a live object, and only
   IndexedDB can keep one across a reload. This is the smallest store that
   will hold it. */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function put(value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

async function get() {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const q = tx.objectStore(STORE).get(KEY);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}

/** Ask for a folder. Must be called from a click: the browser insists. */
export async function choose() {
  const handle = await window.showDirectoryPicker({id: "tdexports", mode: "read"});
  await put(handle);
  return handle;
}

/** The folder chosen before, if there is one. */
export const remembered = () => get().catch(() => null);

export async function forget() {
  await put(null).catch(() => {});
}

/**
 * Whether this folder can be read right now: "granted", "prompt" or "denied".
 *
 * A browser restart drops the permission back to "prompt", and asking again
 * needs a click, which is why the button stays on screen after the folder is
 * chosen rather than disappearing.
 */
export async function permission(handle, ask = false) {
  if (!handle || !handle.queryPermission) return "denied";
  const opts = {mode: "read"};
  let state = await handle.queryPermission(opts);
  if (state === "prompt" && ask) state = await handle.requestPermission(opts);
  return state;
}

/* -------------------------------------------------------------- the scan */

/** What makes a file the same file: its name, size and last change. */
export const fileKey = f => `${f.name}|${f.size}|${f.lastModified}`;

/**
 * Every export in the folder this journal has not read yet, newest first.
 *
 * @param handle the folder
 * @param seen   keys already imported, as an object from the journal
 * @param limit  how many to take at once, so pointing it at a folder with a
 *               year of exports does not read a year of exports
 */
export async function newFiles(handle, seen = {}, limit = 12) {
  if (!handle || !handle.values) return [];
  const out = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== "file") continue;
    if (!/\.csv$/i.test(entry.name) || !LOOKS_LIKE_EXPORT.test(entry.name)) continue;
    let file;
    try { file = await entry.getFile(); } catch { continue; }
    if (!file.size) continue;                  // an export that came out empty
    if (seen[fileKey(file)]) continue;
    out.push(file);
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out.slice(0, limit);
}
