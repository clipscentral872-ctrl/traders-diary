/**
 * Write the whole record out as files you can open in Explorer.
 *
 * The app is the live tool, but a journal you can only read inside a browser
 * is a journal you do not read on the way to the desk. This writes the same
 * record as plain text: a folder per account, a file per session, the day's
 * figures, every trade in it, which rules it broke, and what the coach makes
 * of the lot.
 *
 * It reads the same exports the app reads and uses the same modules to do
 * it, so the files and the app can never drift into disagreeing.
 *
 *   node tools/write_record.mjs
 *   node tools/write_record.mjs --from "C:/path/to/exports" --out "C:/path"
 *
 * Defaults: reads the newest Tradovate exports in Downloads, writes to
 * C:/Users/<you>/Trading Record.
 */
import {readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync,
        statSync} from "node:fs";
import {join, basename} from "node:path";
import {homedir} from "node:os";

import {readAny} from "../docs/imports.js";
import {parseCSV, pairTrades, analyse, setLocalOffset, POINT} from "../docs/engine.js";
import * as C from "../docs/clock.js";
import * as JD from "../docs/jdun.js";
import * as COACH from "../docs/coach.js";
import * as FUND from "../docs/funded.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const FROM = arg("from", join(homedir(), "Downloads"));
const OUT = arg("out", join(homedir(), "Trading Record"));
/* His exports are stamped in his own local time, which is what the app's own
   offset setting exists to read. */
const OFFSET = Number(arg("offset", "2"));
/* How far back to look for export files. Old exports of accounts you have
   finished with sit in the same folder forever. */
const DAYS = Number(arg("days", "14"));

/* ------------------------------------------------------------- the input */

/**
 * The Tradovate exports in the folder, recent ones only.
 *
 * A downloads folder accumulates. Reading everything in it pulled an
 * account closed weeks ago back into the record as a third folder, so only
 * files touched in the last couple of weeks count, and the window is a
 * flag rather than a rule.
 */
function exports_() {
  const want = /^(Fills|Orders|Account Balance History)( \(\d+\))?\.csv$/i;
  const cutoff = Date.now() - DAYS * 86400000;
  return readdirSync(FROM)
    .filter(n => want.test(n))
    .filter(n => statSync(join(FROM, n)).mtimeMs >= cutoff)
    .map(n => ({name: n, text: readFileSync(join(FROM, n), "utf8")}))
    // A table that had not loaded when it was exported writes the word
    // "undefined" and nothing else. Those are not files, they are a mistake.
    .filter(f => f.text.trim() !== "undefined" && f.text.length > 40);
}

const money = v => (v < 0 ? "-$" : "$")
  + Math.abs(Math.round(v * 100) / 100).toLocaleString("en-US",
      {minimumFractionDigits: 2, maximumFractionDigits: 2});
const r2 = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "R";

const safe = s => String(s).replace(/[^A-Za-z0-9 ._-]/g, "");

/* ------------------------------------------------------------ the output */

function sessionFile(date, day, st, plan, reviews) {
  const gross = day.reduce((n, t) => n + (t.pnl || 0), 0);
  const wins = day.filter(t => (t.pnl || 0) > 0).length;
  const vol = day.reduce((n, t) => n + (t.qty || 0), 0);
  const fees = st ? Math.round((gross - st.pnl) * 100) / 100 : null;
  const cap = JD.dailyCap(plan);

  const lines = [];
  lines.push(`# ${C.day(C.msOf(date + " 12:00:00"))}`, "");
  lines.push(`Net for the session: **${st ? money(st.pnl) : money(gross)}**`);
  if (st) lines.push(`Closing balance ${money(st.balance)}, `
    + `${money(st.room)} of room left before the floor at ${money(st.floor)}.`);
  if (cap > 0 && st && st.pnl < -cap)
    lines.push("", `> This session is ${(st.pnl / -cap).toFixed(1)} times the `
      + `$${cap} daily cap.`);
  lines.push("");
  lines.push("| | |", "| --- | --- |");
  lines.push(`| Trades | ${day.length} |`);
  if (day.length) {
    lines.push(`| Win rate | ${Math.round(wins / day.length * 100)}% |`);
    lines.push(`| Gross | ${money(gross)} |`);
    if (fees != null) lines.push(`| Fees | ${money(Math.abs(fees))} |`);
    lines.push(`| Volume | ${vol} contract${vol === 1 ? "" : "s"} |`);
    lines.push(`| Winners | ${wins} |`);
    lines.push(`| Losers | ${day.length - wins} |`);
  }
  lines.push("");

  if (!day.length) {
    lines.push("No trades on this session.", "");
    return lines.join("\n");
  }

  lines.push("## The trades", "");
  day.forEach((t, i) => {
    const r = t.got_r == null ? "no R on record" : r2(t.got_r);
    lines.push(`### ${i + 1}. ${t.symbol} ${t.side} x${t.qty} at `
      + `${C.hhmm(C.msOf(t.open_t))}`);
    lines.push("");
    lines.push(`- Entry ${t.entry}, exit ${t.exit}, `
      + `${C.hhmm(C.msOf(t.close_t))} (${t.held_min} min)`);
    lines.push(`- Stop ${t.stop ?? "not on record"}`
      + (t.risk_pts ? `, ${t.risk_pts} points, `
        + `${money(t.risk_pts * (POINT[t.symbol] || 1) * t.qty)} at risk` : ""));
    if (t.target) lines.push(`- Target ${t.target}`
      + (t.planned_rr ? `, ${t.planned_rr.toFixed(2)}R away` : ""));
    lines.push(`- Result **${money(t.pnl)}**, ${r}`);
    if (t.note) lines.push(`- ${t.note}`);
    if (t.mine) lines.push("", `> ${t.mine}`);

    const rev = reviews.get(t);
    if (rev) {
      const broke = rev.findings.filter(f => f.verdict === "broke");
      const watch = rev.findings.filter(f => f.verdict === "watch");
      lines.push("", `**${rev.line}**`);
      for (const f of broke) lines.push(`- BROKE: ${f.rule}. ${f.what} ${f.instead}`);
      for (const f of watch) lines.push(`- WATCH: ${f.rule}. ${f.what}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function overviewFile(name, days, trades, plan, rules, lessons) {
  const st = days;
  const lines = [];
  lines.push(`# ${name}`, "");
  lines.push(`${st.days.length} sessions, ${trades.length} trades.`);
  lines.push(`Balance ${money(st.balance)}, `
    + `${money(st.profit)} against where it started.`);
  lines.push(`Room before the floor: ${money(st.room)} of `
    + `${money(plan.drawdown)}.`);
  lines.push("");

  lines.push("## Sessions", "");
  lines.push("| Date | Net | Trades | Balance | Room |", "| --- | --- | --- | --- | --- |");
  for (const d of [...st.days].reverse()) {
    const n = trades.filter(t => t.open_t.slice(0, 10) === d.date).length;
    lines.push(`| ${d.date} | ${money(d.pnl)} | ${n} | ${money(d.balance)} `
      + `| ${money(d.room)} |`);
  }
  lines.push("");

  lines.push("## What the record is telling you", "");
  for (const l of lessons.ready) {
    lines.push(`### ${l.title}`, "");
    lines.push(`${l.finding}  _(${l.n} trades)_`, "");
    if (l.suggestion) lines.push(`> ${l.suggestion}`, "");
    for (const e of l.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  if (lessons.waiting.length) {
    lines.push("### Still waiting on more trades", "");
    for (const l of lessons.waiting) lines.push(`- **${l.title}** ${l.finding}`);
    lines.push("");
  }

  lines.push("## What keeps breaking", "");
  const habits = JD.habits(trades, rules);
  if (!habits.length) lines.push("Nothing in the record broke a rule.", "");
  for (const h of habits)
    lines.push(`- **${h.n}x** ${h.rule} (${money(h.pnl)} on those trades). `
      + h.instead);
  lines.push("");
  return lines.join("\n");
}

/* --------------------------------------------------------------- the run */

function main() {
  setLocalOffset(OFFSET);
  C.setExportOffset(() => OFFSET);
  C.setZone("America/New_York");

  const files = exports_();
  if (!files.length) {
    console.log(`No Tradovate exports found in ${FROM}.`);
    console.log("Export Fills, Orders and Account Balance History for each "
      + "account, with rows showing on screen before you press Download.");
    return;
  }
  console.log(`reading ${files.length} file(s) from the last ${DAYS} days `
    + `in ${FROM}`);
  const got = readAny(files, parseCSV);
  const {trades} = pairTrades(got.fills);
  for (const t of trades) analyse(t, got.moves, got.spans);
  if (!trades.length) { console.log("no trades in those files"); return; }

  const accounts = [...new Set(trades.map(t => t.account || "")
    .concat(got.balances.map(b => b.account || "")))].filter(Boolean).sort();

  /* Written fresh every time, so a session removed from the record does not
     linger in a folder as a file nobody deleted. */
  if (existsSync(OUT)) rmSync(OUT, {recursive: true, force: true});
  mkdirSync(OUT, {recursive: true});

  const plan = JD.plan({drawdown: 2000});
  let written = 0;

  for (const acc of accounts) {
    const mine = trades.filter(t => (t.account || "") === acc);
    const bal = got.balances.filter(b => (b.account || "") === acc);
    const st = FUND.state(FUND.preset(FUND.DEFAULT_PLAN),
      bal.length ? {balances: bal} : {trades: mine});

    const short = acc.slice(-4);
    const dir = join(OUT, safe(`Account ${short}`));
    mkdirSync(dir, {recursive: true});

    // Graded once per day so the day rules see the whole session.
    const reviews = new Map();
    for (const day of JD.days(mine, plan))
      for (const r of day.reviews) reviews.set(r.trade, r);

    for (const d of st.days) {
      const day = mine.filter(t => t.open_t.slice(0, 10) === d.date)
        .sort((a, b) => (a.open_t < b.open_t ? -1 : 1));
      writeFileSync(join(dir, `${d.date}.md`),
        sessionFile(d.date, day, d, plan, reviews), "utf8");
      written++;
    }
    writeFileSync(join(dir, "_overview.md"),
      overviewFile(`Account ${short}  (${acc})`, st, mine,
        FUND.preset(FUND.DEFAULT_PLAN), plan, COACH.lessons(mine, plan)),
      "utf8");
    written++;
    console.log(`  ${basename(dir)}: ${st.days.length} sessions, `
      + `${mine.length} trades`);
  }

  writeFileSync(join(OUT, "README.txt"),
    ["Your trading record, written out as files.", "",
     `Written ${new Date().toISOString().slice(0, 16).replace("T", " ")} `
     + `from the exports in ${FROM}.`, "",
     "One folder per account. _overview.md is the account: every session, ",
     "what the record is telling you, and what keeps breaking. Each dated ",
     "file is one session: the figures, every trade in it, and which rules ",
     "each trade broke.", "",
     "Run tools/write_record.mjs again after any new export and this folder ",
     "is rebuilt from scratch.", ""].join("\n"), "utf8");

  console.log(`\n${written} file(s) -> ${OUT}`);
}

main();
