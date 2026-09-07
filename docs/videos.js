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

const $ = id => document.getElementById(id);

// Names the renderer produces, in the order they are worth reviewing.
const GROUPS = [
  {key: /All Winners/i, name: "Everything, winners"},
  {key: /All Losers/i, name: "Everything, losers"},
  {key: /^Week of/i, name: "By week"},
  {key: /^(Mondays|Tuesdays|Wednesdays|Thursdays|Fridays)/i, name: "By weekday"},
  {key: /^Trade /i, name: "Trade by trade"},
  {key: /./, name: "Day by day"},
];

let files = [];        // {name, size}
const urls = new Map();  // name -> object URL, made only when played

const pretty = name => name.replace(/\.mp4$/i, "").replace(/_/g, " ");
const mb = n => (n / 1048576).toFixed(1) + " MB";

function classOf(name) {
  if (/winners?|win\b/i.test(name)) return "win";
  if (/losers?|loss\b/i.test(name)) return "loss";
  return "";
}

function groupOf(name) {
  for (const g of GROUPS) if (g.key.test(name)) return g.name;
  return "Day by day";
}

function say(text, bad) {
  const el = $("vmsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", !!bad);
  el.hidden = !text;
}

function render() {
  const box = $("vlib");
  if (!box) return;
  const wipe = $("vforget");
  if (wipe) wipe.hidden = !files.length;
  if (!files.length) { box.innerHTML = ""; return; }

  const byGroup = new Map();
  for (const f of files) {
    const g = groupOf(f.name);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(f);
  }

  box.innerHTML = GROUPS.map(g => g.name)
    .filter((n, i, a) => a.indexOf(n) === i && byGroup.has(n))
    .map(name => {
      // Newest first within a group, which is how you actually review.
      const items = byGroup.get(name).slice().sort((a, b) =>
        b.name.localeCompare(a.name));
      return `<div class="vgroup"><h3>${name}</h3><div class="vlist">`
        + items.map(f =>
            `<button class="vcut ${classOf(f.name)}" data-name="${
              f.name.replace(/"/g, "&quot;")}">`
            + '<span class="vplay" aria-hidden="true"></span>'
            + `<span class="vn">${pretty(f.name)}</span>`
            + `<span class="vs">${mb(f.size)}</span></button>`).join("")
        + "</div></div>";
    }).join("");
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
  const room = u && u.quota
    ? `, ${mb(u.quota - u.used)} of room left` : "";
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
      files.push({name: file.name, size: file.size});
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
  render();
  await tally(failed
    ? `Ran out of room after ${added}. Remove some and try the rest.`
    : added ? `${added} added.` : "Those were already here.");
}

async function forget() {
  if (!confirm(`Remove all ${files.length} videos from this browser? `
             + `The files on your computer are not touched.`)) return;
  await V.clear().catch(() => {});
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  files = [];
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
    const b = e.target.closest(".vcut");
    if (b) play(b.dataset.name);
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
    files = (await V.list()).sort((a, b) => a.name.localeCompare(b.name));
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
