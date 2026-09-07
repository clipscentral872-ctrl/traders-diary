/* Where the videos live between visits.
 *
 * The file picker hands over a File once and the browser will not re-open it
 * later: a path is not something a page is allowed to keep. So "pick the
 * folder every single time" was not a design choice, it was the only thing
 * that worked, and it made a hundred megabytes of rendered review videos
 * something you had to go and fetch before you could watch any of them.
 *
 * IndexedDB will hold the blobs. Picked once, they are there on that device
 * from then on, and they are still exactly as private as before: nothing is
 * uploaded, nothing leaves the browser, and the store is per-origin so no
 * other site can read it.
 *
 * Storage is asked to be persistent, because a browser is otherwise free to
 * throw a big store away when it wants space back, and losing the library
 * silently is worse than being told it could not be kept.
 */

import * as P from "./profile.js";
const STORE = "videos";
const VERSION = 1;

let dbp = null;
let openedFor = null;

function open() {
  // A different journal is a different library, so the handle is dropped
  // when the journal changes rather than quietly serving the last one's.
  if (dbp && openedFor !== P.dbName()) { dbp = null; }
  openedFor = P.dbName();
  if (dbp) return dbp;
  dbp = new Promise((ok, fail) => {
    let req;
    try { req = indexedDB.open(P.dbName(), VERSION); }
    catch (e) { fail(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, {keyPath: "name"});
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
    // Private browsing in some browsers opens the request and then never
    // answers it. A store that is not going to work should say so rather
    // than leave the tab waiting.
    setTimeout(() => fail(new Error("storage did not answer")), 8000);
  });
  return dbp;
}

function tx(mode, run) {
  return open().then(db => new Promise((ok, fail) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => ok(req && req.result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error || new Error("storage refused the write"));
  }));
}

/** Whether this browser will hold anything at all. */
export async function available() {
  try { await open(); return true; } catch { return false; }
}

/**
 * Ask the browser to stop treating the library as disposable.
 *
 * Safari grants this once a site is on the home screen and refuses it before
 * that, which is worth knowing rather than worth retrying.
 */
export async function persist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

/** {used, quota} in bytes, or null where the browser will not say. */
export async function usage() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return {used: e.usage || 0, quota: e.quota || 0};
  } catch { return null; }
}

/** Keep one file. The blob is stored, not the File, so it outlives the pick. */
export function put(name, file) {
  return tx("readwrite", s => s.put({
    name, blob: file, size: file.size,
    // Where it sat in the folder that was picked, when the browser said. It
    // is what lets the library show the real folders rather than ones worked
    // out from the filenames.
    relative: file.webkitRelativePath || "",
    type: file.type || "video/mp4", added: Date.now(),
  }));
}

/** Everything held, without pulling the blobs into memory to find out. */
export function list() {
  return tx("readonly", s => s.getAll()).then(rows =>
    (rows || []).map(r => ({name: r.name, size: r.size, type: r.type,
                            relative: r.relative || "", added: r.added})));
}

/** One file's blob, or null. */
export function get(name) {
  return tx("readonly", s => s.get(name)).then(r => (r ? r.blob : null));
}

export function remove(name) {
  return tx("readwrite", s => s.delete(name));
}

export function clear() {
  return tx("readwrite", s => s.clear());
}
