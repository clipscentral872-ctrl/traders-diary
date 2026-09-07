/* The library as folders, the way a file explorer shows one.
 *
 * A flat list of forty one videos under five headings is a wall. Folders are
 * how everybody already knows to look through a lot of files: open one, see
 * what is in it, go back up. Nothing is hidden, it is just not all shouted at
 * once.
 *
 * The renderer already writes real folders on disk, so if the whole "For
 * Learning" folder is picked at once the real paths come through and are used
 * as they are. Where only loose files are handed over, and on a phone where
 * picking a folder is not offered at all, the same shape is worked out from
 * the filenames, which the renderer also controls. Either way the shelf looks
 * the same, which is the point: it should not matter how the files arrived.
 */

/* The renderer's folder names, and what they are called here.
 *
 * Both routes into this file have to end at the same tree. Left alone, a
 * library picked as a folder said "Weekly" and the same library picked as
 * loose files said "By week", and a shelf with both on it had every category
 * twice under two names. */
const FRIENDLY = {
  "Overall": "Everything",
  "Weekly": "By week",
  "Daily": "Day by day",
  "By Weekday": "By weekday",
  "Per Trade": "Trade by trade",
};

// The two that are worth a folder per date. Fifteen day videos in one list is
// the wall this exists to avoid.
const BY_DATE = new Set(["Day by day", "Trade by trade"]);

/** Where a file belongs, as a list of folder names. */
export function pathOf(name, relative) {
  // A real path, when the browser gave us one. Drop the top folder, which is
  // whichever directory happened to be picked.
  if (relative && relative.includes("/")) {
    const parts = relative.split("/").filter(Boolean);
    parts.pop();                 // the file itself
    parts.shift();               // the directory that was picked
    if (parts.length) {
      parts[0] = FRIENDLY[parts[0]] || parts[0];
      const date = (name.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      if (parts.length === 1 && date && BY_DATE.has(parts[0]))
        parts.push(date);
    }
    return parts;
  }

  const n = name.replace(/\.[^.]+$/, "");
  if (/^Start Here/i.test(n)) return [];
  if (/^All (Winners|Losers)/i.test(n)) return ["Everything"];
  if (/^Week of/i.test(n)) return ["By week"];
  if (/^(Mondays|Tuesdays|Wednesdays|Thursdays|Fridays)/i.test(n))
    return ["By weekday"];

  // A day or a trade carries its own date, so it gets a folder for that date.
  const date = (n.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
  if (/^Trade /i.test(n)) return date ? ["Trade by trade", date] : ["Trade by trade"];
  return date ? ["Day by day", date] : ["Day by day"];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/i;

/**
 * What a file is called once you are already standing in its folder.
 *
 * The full name is "Friday 2026-09-04 - Winners", and inside the folder
 * called 2026-09-04 the first half of that is the folder you just opened.
 * Three rows all starting with the same eleven characters is exactly the
 * noise a file explorer avoids. The name on disk is untouched, and the
 * player still shows it in full.
 */
export function label(name, at) {
  const n = name.replace(/\.[^.]+$/, "");
  const here = at[at.length - 1];
  if (!here || !DATE.test(here)) return n;
  let out = n.split(here).join(" ").replace(/\s+/g, " ").trim();
  out = out.replace(WEEKDAY, "").replace(/^Trade\b/i, "").trim();
  out = out.replace(/^[-–:,]\s*/, "").trim();
  return out || n;
}

/** Winner, loser, or neither, read off the name the renderer wrote. */
export function outcome(name) {
  if (/winners?\b/i.test(name)) return "win";
  if (/losers?\b/i.test(name)) return "loss";
  return "";
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What to show at one place in the tree.
 *
 * @param files [{name, size, path}]
 * @param at    the folder path being looked at
 * @returns {folders:[{name, files, bytes}], files:[...]}
 */
export function listing(files, at) {
  const folders = new Map();
  const here = [];
  for (const f of files) {
    const p = f.path || [];
    if (same(p, at)) { here.push(f); continue; }
    // Only things below where we are, and only the next name down.
    if (p.length <= at.length) continue;
    if (!at.every((x, i) => p[i] === x)) continue;
    const next = p[at.length];
    const got = folders.get(next) || {name: next, files: 0, bytes: 0};
    got.files++;
    got.bytes += f.size || 0;
    folders.set(next, got);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, {numeric: true});
  return {
    folders: [...folders.values()].sort(byName),
    // Newest first inside a folder, which is the order you review in.
    files: here.sort((a, b) => b.name.localeCompare(a.name, undefined,
                                                    {numeric: true})),
  };
}

/** Every folder on the way back up, for the trail across the top. */
export function crumbs(at) {
  const out = [{name: "Library", path: []}];
  at.forEach((n, i) => out.push({name: n, path: at.slice(0, i + 1)}));
  return out;
}

export const mb = n => (n / 1048576).toFixed(1) + " MB";
