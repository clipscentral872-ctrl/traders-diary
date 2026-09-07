/* Check the library sorts itself into the folders it should.
 *
 * The real names come from make_videos.py, so this uses the exact ones it
 * writes. If either side is renamed and the other is not, the videos go on
 * quietly landing in "Day by day" and nobody notices until the folder is
 * opened.
 *
 *   node tools/test_shelf.mjs
 */
import * as S from "../docs/shelf.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
};

const NAMES = [
  "Start Here.mp4",
  "All Winners.mp4",
  "All Losers.mp4",
  "Week of 2026-08-31 - Winners.mp4",
  "Week of 2026-08-31 - Losers.mp4",
  "Mondays - Winners.mp4",
  "Fridays - Losers.mp4",
  "Friday 2026-09-04 - All Trades.mp4",
  "Friday 2026-09-04 - Winners.mp4",
  "Monday 2026-08-31 - Losers.mp4",
  "Trade NQ 2026-08-31 155308 Short - Loser.mp4",
  "Trade NQ 2026-08-31 155920 Short - Winner.mp4",
  "Trade ES 2026-09-04 140552 Short - Loser.mp4",
];
const files = NAMES.map(n => ({name: n, size: 1048576, path: S.pathOf(n)}));
const at = p => S.listing(files, p);
const folderNames = p => at(p).folders.map(f => f.name).join(", ");
const fileNames = p => at(p).files.map(f => f.name).join(", ");

console.log("\nthe top level is the five ways of looking at it");
{
  const top = folderNames([]);
  check("Everything", /Everything/.test(top), top);
  check("By week", /By week/.test(top), top);
  check("By weekday", /By weekday/.test(top), top);
  check("Day by day", /Day by day/.test(top), top);
  check("Trade by trade", /Trade by trade/.test(top), top);
  check("and Start Here sits loose at the top",
        /Start Here/.test(fileNames([])), fileNames([]));
}

console.log("\ndays and trades get a folder each for their date");
{
  check("day by day is split by date",
        folderNames(["Day by day"]) === "2026-08-31, 2026-09-04",
        folderNames(["Day by day"]));
  check("and the files sit inside the right one",
        at(["Day by day", "2026-09-04"]).files.length === 2,
        String(at(["Day by day", "2026-09-04"]).files.length));
  check("trade by trade too",
        folderNames(["Trade by trade"]) === "2026-08-31, 2026-09-04",
        folderNames(["Trade by trade"]));
  check("with two trades on the 31st",
        at(["Trade by trade", "2026-08-31"]).files.length === 2);
}

console.log("\na folder says how much is in it");
{
  const top = at([]).folders.find(f => f.name === "Trade by trade");
  check("three videos", top.files === 3, String(top.files));
  check("and their size", top.bytes === 3 * 1048576, String(top.bytes));
}

console.log("\nnothing leaks between folders");
{
  check("a week video is not in Day by day",
        !/Week of/.test(fileNames(["Day by day", "2026-08-31"])),
        fileNames(["Day by day", "2026-08-31"]));
  check("the top level lists no videos but Start Here",
        at([]).files.length === 1, fileNames([]));
  check("every file is somewhere",
        NAMES.every(n => {
          const p = S.pathOf(n);
          return at(p).files.some(f => f.name === n);
        }));
}

console.log("\nboth ways of adding the library end at the same tree");
{
  // Picked as a folder, the real names come through. Picked as loose files,
  // they are worked out from the filenames. A shelf holding some of each
  // showed every category twice under two names until these agreed.
  const pairs = [
    ["All Winners.mp4", "For Learning/Overall/All Winners.mp4"],
    ["Week of 2026-08-31 - Winners.mp4",
     "For Learning/Weekly/Week of 2026-08-31 - Winners.mp4"],
    ["Mondays - Winners.mp4", "For Learning/By Weekday/Mondays - Winners.mp4"],
    ["Friday 2026-09-04 - Winners.mp4",
     "For Learning/Daily/Friday 2026-09-04 - Winners.mp4"],
    ["Trade NQ 2026-08-31 155308 Short - Loser.mp4",
     "For Learning/Per Trade/Trade NQ 2026-08-31 155308 Short - Loser.mp4"],
  ];
  for (const [n, rel] of pairs) {
    const byName = JSON.stringify(S.pathOf(n));
    const byPath = JSON.stringify(S.pathOf(n, rel));
    check(n.slice(0, 36), byName === byPath, byName + " vs " + byPath);
  }
}

console.log("\na real path from the browser is used as it is");
{
  check("a folder nobody has renamed is kept",
        JSON.stringify(S.pathOf("x.mp4", "For Learning/Scratch/x.mp4"))
          === JSON.stringify(["Scratch"]),
        JSON.stringify(S.pathOf("x.mp4", "For Learning/Scratch/x.mp4")));
  check("deeper paths are kept",
        JSON.stringify(S.pathOf("x.mp4", "For Learning/Scratch/Sep/x.mp4"))
          === JSON.stringify(["Scratch", "Sep"]));
  check("a file at the top of the picked folder has no folder",
        JSON.stringify(S.pathOf("x.mp4", "For Learning/x.mp4")) === "[]",
        JSON.stringify(S.pathOf("x.mp4", "For Learning/x.mp4")));
}

console.log("\nwinners and losers are told apart");
{
  check("a winner", S.outcome("All Winners.mp4") === "win");
  check("a loser", S.outcome("Trade NQ 2026-08-31 155308 Short - Loser.mp4") === "loss");
  check("and all trades is neither",
        S.outcome("Friday 2026-09-04 - All Trades.mp4") === "");
}

console.log("\ninside a date folder the date is not said twice");
{
  const day = ["Day by day", "2026-09-04"];
  check("the weekday and date come off",
        S.label("Friday 2026-09-04 - Winners.mp4", day) === "Winners",
        S.label("Friday 2026-09-04 - Winners.mp4", day));
  check("all trades too",
        S.label("Friday 2026-09-04 - All Trades.mp4", day) === "All Trades",
        S.label("Friday 2026-09-04 - All Trades.mp4", day));
  const per = ["Trade by trade", "2026-08-31"];
  check("a trade keeps what tells it apart",
        S.label("Trade NQ 2026-08-31 155308 Short - Loser.mp4", per)
          === "NQ 155308 Short - Loser",
        S.label("Trade NQ 2026-08-31 155308 Short - Loser.mp4", per));
  check("two trades on the same day stay different",
        S.label("Trade NQ 2026-08-31 155308 Short - Loser.mp4", per)
          !== S.label("Trade NQ 2026-08-31 155920 Short - Winner.mp4", per));
}

console.log("\nanywhere else the whole name stays");
{
  check("weeks keep their date, the folder holds every week",
        S.label("Week of 2026-08-31 - Winners.mp4", ["By week"])
          === "Week of 2026-08-31 - Winners",
        S.label("Week of 2026-08-31 - Winners.mp4", ["By week"]));
  check("weekdays are untouched",
        S.label("Mondays - Winners.mp4", ["By weekday"]) === "Mondays - Winners");
  check("and so is the top level",
        S.label("Start Here.mp4", []) === "Start Here");
  check("a name that is only its date does not vanish",
        S.label("2026-09-04.mp4", ["Day by day", "2026-09-04"]) === "2026-09-04");
}

console.log("\nthe trail back up");
{
  const c = S.crumbs(["Day by day", "2026-09-04"]);
  check("three steps", c.length === 3, String(c.length));
  check("starting at the library", c[0].name === "Library" && c[0].path.length === 0);
  check("and each one knows where it goes",
        JSON.stringify(c[1].path) === JSON.stringify(["Day by day"]));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
