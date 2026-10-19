/* The rendered videos of your sessions, played from this device.
 *
 * These are the Remotion cuts: every trade on its own, every trade of a day,
 * and the winners and losers split apart so a run of losses can be watched
 * back to back. That split is the point. The same mistake repeating is
 * obvious across five losses in a row and invisible when wins are shuffled in
 * between.
 *
 * They are NOT uploaded and NOT bundled with the app. On a public site that
 * is the only honest way to do it: the videos are a recording of your own
 * trading. They are picked once and then kept in this browser's own storage,
 * so they are there next time without going and fetching them again.
 *
 * The file picker gives no path, only names, so the grouping is read from the
 * filenames the renderer already writes.
 */
import * as V from "./vault.js";
import * as SH from "./shelf.js";
import * as P from "./profile.js";

const $ = id => document.getElementById(id);

let files = [];          // {name, size, path}
let at = [];             // which folder is open
let only = "all";        // all, win or loss
const urls = new Map();  // name -> object URL, made only when played

const pretty = name => name.replace(/\.mp4$/i, "").replace(/_/g, " ");
const mb = SH.mb;
const esc = t => String(t).replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

function say(text, bad) {
  const el = $("vmsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", !!bad);
  el.hidden = !text;
}

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

/* One folder's worth, and the trail back up.
 *
 * A flat list of forty one videos under five headings is a wall. This is the
 * same library shown the way anybody already knows how to look through a lot
 * of files.
 */
/**
 * The library, narrowed to what you asked for.
 *
 * Two questions get asked of this tab over and over: show me my losers, and
 * show me this account. The renderer already splits winners from losers in
 * the filenames, and the journal knows which account a trade belongs to, so
 * both are a filter rather than a hunt through folders.
 */
function visible() {
  let list = files;
  if (only !== "all") list = list.filter(f => SH.outcome(f.name) === only);

  const acc = window.ACCOUNT;
  if (acc && acc !== "all") {
    const mine = (window.TRADES || []).filter(t => (t.account || "") === acc
      && (t.source || "live") === "live");
    // With no trades on record the names cannot be traced to an account, and
    // hiding the whole library would be worse than showing it.
    if (mine.length) {
      const keys = new Set(mine.map(t => tradeKey(t)));
      const days = new Set(mine.map(t => String(t.open_t || "").slice(0, 10)));
      list = list.filter(f => {
        const perTrade = ["Winners", "Losers", "Per Trade"];
        if (/^Trade /i.test(f.name)
            || (f.path || []).some(d => perTrade.includes(d)))
          return [...keys].some(k => f.name.includes(k));
        const d = (f.name.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
        return d ? days.has(d) : true;
      });
    }
  }
  return list;
}

/** The same key the per trade renderer writes into a filename. */
function tradeKey(t) {
  const stamp = String(t.open_t || "");
  return `${t.symbol} ${stamp.slice(0, 10)} `
       + `${stamp.slice(11, 13)}${stamp.slice(14, 16)}${stamp.slice(17, 19)}`;
}

function filterBar() {
  const n = k => files.filter(f => k === "all" || SH.outcome(f.name) === k).length;
  return '<div class="vfilter" role="group" aria-label="Which videos">'
    + [["all", "Everything"], ["win", "Winners"], ["loss", "Losers"]]
      .map(([k, label]) => `<button class="vfb ${k}" data-only="${k}" `
        + `aria-pressed="${only === k}">${label}`
        + `<span class="sn">${n(k)}</span></button>`).join("")
    + "</div>";
}

/* The week just gone, as two films, at the top.
 *
 * Every week already gets a winners film and a losers film, each holding
 * that week's trades back to back. They were three folders down, which is
 * three clicks and a decision between six near identical names at the end
 * of it, on a Saturday, which is exactly when you want to press one thing
 * and watch. So the newest pair sits above the shelf with the week it
 * covers written on it. */
function weekRow() {
  const weeks = files.filter(f => /^Week of \d{4}-\d{2}-\d{2} - (Winners|Losers)/i
    .test(f.name));
  if (!weeks.length) return "";
  const newest = weeks.map(f => f.name.slice(8, 18)).sort().pop();
  const of = kind => weeks.find(f => f.name.startsWith("Week of " + newest)
    && SH.outcome(f.name) === kind);
  const win = of("win"), loss = of("loss");
  if (!win && !loss) return "";
  const btn = (f, label) => f
    ? `<button class="wkbtn ${SH.outcome(f.name)}" data-name="${esc(f.name)}">`
      + '<span class="shic vplay" aria-hidden="true"></span>'
      + `<span class="wkn">${label}</span>`
      + `<span class="wkm">${mb(f.size)}</span></button>`
    : "";
  return '<div class="weekrow"><span class="wkhead">The week of '
    + esc(newest) + ", in one go</span>"
    + btn(loss, "Every loser") + btn(win, "Every winner") + "</div>";
}

function render() {
  const box = $("vlib");
  if (!box) return;
  const wipe = $("vforget");
  if (wipe) wipe.hidden = !files.length;
  // With a library on the shelf, the shelf leads and the importer moves under
  // it. An empty tab needs the explanation and the drop zone first; a full one
  // needs them out of the way.
  const sec = $("vsec");
  if (sec) sec.classList.toggle("stocked", !!files.length);
  if (!files.length) { box.innerHTML = ""; return; }

  const {folders, files: here} = SH.listing(visible(), at);
  const trail = SH.crumbs(at).map((c, i, a) =>
    i === a.length - 1
      ? `<span class="crumb on">${esc(c.name)}</span>`
      : `<button class="crumb" data-go="${i}">${esc(c.name)}</button>`
        + '<span class="crumbsep">/</span>').join("");

  const rows = folders.map(f =>
    `<button class="shrow folder" data-open="${esc(f.name)}">`
    + `<span class="shic">${FOLDER_ICON}</span>`
    + `<span class="shn">${esc(f.name)}</span>`
    + `<span class="shm">${f.files} video${f.files === 1 ? "" : "s"}</span>`
    + `<span class="shs">${mb(f.bytes)}</span></button>`).join("")
  + here.map(f =>
    `<button class="shrow file ${SH.outcome(f.name)}" data-name="${esc(f.name)}">`
    + '<span class="shic vplay" aria-hidden="true"></span>'
    + `<span class="shn">${esc(SH.label(f.name, at))}</span>`
    + '<span class="shm"></span>'
    + `<span class="shs">${mb(f.size)}</span></button>`).join("");

  box.innerHTML = staleNote()
    + weekRow()
    + filterBar()
    + `<div class="shbar"><div class="shtrail">${trail}</div>`
    + (at.length ? '<button class="shup" data-up="1">Up one</button>' : "")
    + "</div>"
    + `<div class="shlist">${rows
        || '<p class="booknote">This folder is empty.</p>'}</div>`;
}

async function play(name) {
  let url = urls.get(name);
  if (!url) {
    const blob = await V.get(name).catch(() => null);
    if (!blob) {
      say("That video is no longer in this browser's storage. Add the folder "
        + "again to put it back.", true);
      return;
    }
    url = URL.createObjectURL(blob);
    urls.set(name, url);
  }
  $("vtitle").textContent = pretty(name);
  $("vvideo").src = url;
  $("vplayer").hidden = false;
  $("vvideo").play().catch(() => { /* the controls are there either way */ });
}

function close() {
  const v = $("vvideo");
  v.pause();
  v.removeAttribute("src");
  v.load();
  $("vplayer").hidden = true;
}

/** What the library holds, said in a way that means something. */
async function tally(extra) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const kept = await V.persist();
  const u = await V.usage();
  // Its own sentence. Tacked onto the end of the one before it, this read
  // "settles that., 2971.0 MB of room left".
  const room = u && u.quota
    ? ` ${mb(u.quota - u.used)} of room left.` : "";
  say(`${files.length} video${files.length === 1 ? "" : "s"}, ${mb(total)}`
    + (extra ? ". " + extra : "")
    + (kept
       ? ". Kept on this device until you remove them."
       : ". This browser has not promised to keep them, so it may clear them "
         + "if it needs the space. Adding the app to your home screen usually "
         + "settles that.")
    + room);
}

async function take(list) {
  const vids = [...list].filter(f => /\.(mp4|mov|webm|m4v)$/i.test(f.name));
  if (!vids.length) {
    say("No video files in that. The cuts are the .mp4 files under "
      + "AITrader\\For Learning.", true);
    return;
  }
  if (!(await V.available())) {
    say("This browser will not store files, most likely because it is in "
      + "private mode. Videos cannot be kept here.", true);
    return;
  }

  await V.persist();
  const have = new Set(files.map(f => f.name));
  let added = 0, failed = 0;
  say(`Storing ${vids.length} video${vids.length === 1 ? "" : "s"}...`);
  for (const file of vids) {
    if (have.has(file.name)) continue;
    try {
      await V.put(file.name, file);
      files.push({name: file.name, size: file.size,
                  path: SH.pathOf(file.name, file.webkitRelativePath)});
      have.add(file.name);
      added++;
    } catch {
      // Almost always the quota. Stop rather than half-fill the library and
      // say nothing about it.
      failed++;
      break;
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  try { P.set(FILLED, String(Date.now())); } catch { /* nothing kept */ }
  render();
  await tally(failed
    ? `Ran out of room after ${added}. Remove some and try the rest.`
    : added ? `${added} added.` : "Those were already here.");
}

/* When the shelf was last filled from the folder.
 *
 * The videos are copied into this browser when the folder is picked, so the
 * shelf is a snapshot and not a window. The library on disk rebuilds itself
 * every Saturday at six, which means the shelf is out of date from the
 * first Saturday after it was filled and nothing on screen would say so.
 * The app cannot see the disk, so it says the one thing it does know. */
const FILLED = "videos.filled";

function staleNote() {
  let when = 0;
  try { when = Number(P.get(FILLED)) || 0; } catch { when = 0; }
  if (!when || !files.length) return "";
  // The most recent Saturday six in the morning.
  const sat = new Date();
  sat.setHours(6, 0, 0, 0);
  sat.setDate(sat.getDate() - ((sat.getDay() + 1) % 7));
  if (sat.getTime() > Date.now()) sat.setDate(sat.getDate() - 7);
  if (when >= sat.getTime()) return "";
  const days = Math.max(1, Math.round((Date.now() - when) / 86400000));
  return '<p class="vstale">These were added ' + days + " day"
    + (days === 1 ? "" : "s") + " ago, and the library has rebuilt itself "
    + "since. Add the folder again to pick up the newest trades.</p>";
}

async function forget() {
  if (!confirm(`Remove all ${files.length} videos from this browser? `
             + `The files on your computer are not touched.`)) return;
  await V.clear().catch(() => {});
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  files = [];
  at = [];
  close();
  render();
  say("Removed. Add the folder again whenever you want them back.");
}

export async function init() {
  const drop = $("vdrop"), pick = $("vpick");
  if (!drop) return;

  drop.addEventListener("click", () => pick.click());
  drop.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick.click(); }
  });
  pick.addEventListener("change", () => pick.files.length && take(pick.files));

  /* Picking a whole folder, where the browser allows it.
   *
   * This is the one that keeps the real structure: the renderer already
   * writes Daily, Weekly, Per Trade and the rest, and a folder pick hands
   * those over as they are instead of them having to be worked out from the
   * filenames. Safari on a phone will not do it, so it is offered only where
   * it works rather than sitting there doing nothing. */
  const dir = $("vpickdir"), dirBtn = $("vdir");
  if (dir && dirBtn && "webkitdirectory" in dir) {
    dirBtn.hidden = false;
    dirBtn.addEventListener("click", e => { e.stopPropagation(); dir.click(); });
    dir.addEventListener("change", () => dir.files.length && take(dir.files));
  }
  ["dragenter", "dragover"].forEach(n => drop.addEventListener(n, e => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach(n => drop.addEventListener(n, e => {
    e.preventDefault(); drop.classList.remove("over");
  }));
  drop.addEventListener("drop", e => {
    if (e.dataTransfer?.files.length) take(e.dataTransfer.files);
  });

  $("vlib").addEventListener("click", e => {
    const f2 = e.target.closest("[data-only]");
    if (f2) {
      only = f2.dataset.only;
      // Back to the top of the tree: a folder that was open may hold nothing
      // once the filter is on, and an empty folder is a confusing answer.
      at = [];
      render();
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) { at = [...at, open.dataset.open]; render(); return; }
    const crumb = e.target.closest("[data-go]");
    if (crumb) { at = at.slice(0, +crumb.dataset.go); render(); return; }
    if (e.target.closest("[data-up]")) { at = at.slice(0, -1); render(); return; }
    /* Anything carrying a name plays, which is the shelf rows and the two
       week buttons above them. */
    const f = e.target.closest("[data-name]");
    if (f) play(f.dataset.name);
  });
  $("vclose").addEventListener("click", close);
  const wipe = $("vforget");
  if (wipe) wipe.addEventListener("click", forget);
  addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("vplayer").hidden) close();
  });

  // Blob URLs hold the data in memory, so they are released with the page.
  addEventListener("pagehide", () => {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  });

  await reload();
}

/**
 * Re-read the library for whichever journal is open.
 *
 * init() runs before a PIN has been entered, when there is no journal and so
 * no library to read. Without this the videos were there in storage and the
 * tab said there were none, which looks exactly like having lost them.
 */
export async function reload() {
  try {
    files = (await V.list())
      .map(f => ({...f, path: SH.pathOf(f.name, f.relative)}))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { files = []; }
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  render();
  if (files.length) await tally("");
  else say("");
}

/**
 * The video for one trade, if it was rendered and added.
 *
 * The renderer names them "Trade NQ 2026-09-04 1531 Short - Loser.mp4", built
 * from the stored stamp rather than from what is on screen, so this matches
 * on the stamp too and stays right whichever clock the app is showing.
 */
export function forTrade(t) {
  if (!t || !files.length) return null;
  // Down to the second, because two trades a minute apart is normal and two
  // in the same minute is not rare either: matching on minutes alone handed
  // back whichever of them happened to be first in the list.
  const stamp = String(t.open_t || "");
  const key = `${t.symbol} ${stamp.slice(0, 10)} `
            + `${stamp.slice(11, 13)}${stamp.slice(14, 16)}${stamp.slice(17, 19)}`;
  const hit = files.find(f => f.name.includes(key));
  return hit ? hit.name : null;
}

/** Play a trade's video, for the button on the Diary tab. */
export function playTrade(t) {
  const name = forTrade(t);
  if (name) play(name);
  return !!name;
}

export const count = () => files.length;

/** Redrawn when the account changes, so the library follows the picker. */
export function refilter() { if (files.length) render(); }
