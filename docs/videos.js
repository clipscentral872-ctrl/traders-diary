/* The rendered videos of your sessions, played from your own machine.
 *
 * These are the Remotion cuts: every trade of a day, and the winners and
 * losers split apart so a run of losses can be watched back to back. That
 * split is the point. The same mistake repeating is obvious across five
 * losses in a row and invisible when wins are shuffled in between.
 *
 * They are NOT uploaded and NOT bundled with the app. The files sit in the
 * For Learning folder on your machine and are read straight off disk into a
 * blob URL that lives only as long as the tab. On a public site that is the
 * only honest way to do it: the videos are a recording of your own trading.
 *
 * The file picker gives no path, only names, so the grouping is read from the
 * filenames the renderer already writes.
 */

const $ = id => document.getElementById(id);

// Names the renderer produces, in the order they are worth reviewing.
const GROUPS = [
  {key: /All Winners/i, name: "Everything, winners"},
  {key: /All Losers/i, name: "Everything, losers"},
  {key: /^Week of/i, name: "By week"},
  {key: /^(Mondays|Tuesdays|Wednesdays|Thursdays|Fridays)/i, name: "By weekday"},
  {key: /./, name: "Day by day"},
];

let files = [];        // {name, file, url}
const urls = new Set();

const pretty = name => name.replace(/\.mp4$/i, "").replace(/_/g, " ");
const mb = f => (f.size / 1048576).toFixed(1) + " MB";

function classOf(name) {
  if (/winners/i.test(name)) return "win";
  if (/losers/i.test(name)) return "loss";
  return "";
}

function groupOf(name) {
  for (const g of GROUPS) if (g.key.test(name)) return g.name;
  return "Day by day";
}

function say(text, bad) {
  const el = $("vmsg");
  el.textContent = text || "";
  el.classList.toggle("bad", !!bad);
  el.hidden = !text;
}

function render() {
  const box = $("vlib");
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
        + items.map((f, i) =>
            `<button class="vcut ${classOf(f.name)}" data-name="${
              f.name.replace(/"/g, "&quot;")}">`
            + '<span class="vplay" aria-hidden="true"></span>'
            + `<span class="vn">${pretty(f.name)}</span>`
            + `<span class="vs">${mb(f.file)}</span></button>`).join("")
        + "</div></div>";
    }).join("");
}

function play(name) {
  const f = files.find(x => x.name === name);
  if (!f) return;
  if (!f.url) {
    f.url = URL.createObjectURL(f.file);
    urls.add(f.url);
  }
  $("vtitle").textContent = pretty(f.name);
  $("vvideo").src = f.url;
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

function take(list) {
  const vids = [...list].filter(f => /\.(mp4|mov|webm|m4v)$/i.test(f.name));
  if (!vids.length) {
    say("No video files in that. The cuts are the .mp4 files under "
      + "AITrader\\For Learning.", true);
    return;
  }
  const seen = new Set(files.map(f => f.name));
  let added = 0;
  for (const file of vids) {
    if (seen.has(file.name)) continue;
    files.push({name: file.name, file, url: null});
    seen.add(file.name);
    added++;
  }
  render();
  say(`${files.length} video${files.length === 1 ? "" : "s"} ready`
    + (added !== vids.length ? `, ${vids.length - added} already added` : "")
    + ". They stay on this device, and are forgotten when you close the app.");
}

export function init() {
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
  addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("vplayer").hidden) close();
  });

  // Blob URLs hold the file open, so they are released with the page.
  addEventListener("pagehide", () => {
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
  });
}

/** Nothing is remembered between visits: the browser cannot re-open a file it
 *  was handed once, so the picker is the honest starting point every time. */
export const count = () => files.length;
