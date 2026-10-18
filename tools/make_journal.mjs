/**
 * Build the journal file the video renderer films from.
 *
 * The renderer needs trades with their candles attached. The app does that
 * in the browser, which means the only way to get a filmable journal out of
 * it used to be to save a backup by hand and remember where it went. This
 * does the same work headless, from the same exports and the same modules,
 * and writes the file where the renderer already looks.
 *
 *   node tools/make_journal.mjs
 *   node tools/make_journal.mjs --from "C:/path" --out "C:/path/file.json"
 */
import {readFileSync, readdirSync, statSync, writeFileSync, existsSync,
        mkdirSync} from "node:fs";
import {join, dirname} from "node:path";
import {homedir} from "node:os";

import {readAny} from "../docs/imports.js";
import {parseCSV, pairTrades, analyse, attachBars, analyseExcursion,
        setLocalOffset, FEED} from "../docs/engine.js";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const FROM = arg("from", join(homedir(), "Downloads"));
const BARS = arg("bars", join(HERE, "..", "docs", "bars"));
const OUT = arg("out", join(homedir(), "AITrader", "journal_data",
                            "traders-diary-backup.json"));
const OFFSET = Number(arg("offset", "2"));
const DAYS = Number(arg("days", "14"));

/** A published bar file as the list the engine wants. */
function series(sym, tf) {
  const path = join(BARS, `${sym}_${tf}.json`);
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  j.bars.forEach((b, i) => {
    if (b) out.push({ms: (j.t0 + i * j.step) * 1000,
                     o: b[0], h: b[1], l: b[2], c: b[3]});
  });
  return out;
}

function main() {
  setLocalOffset(OFFSET);

  const want = /^(Fills|Orders|Account Balance History)( \(\d+\))?\.csv$/i;
  const cutoff = Date.now() - DAYS * 86400000;
  const files = readdirSync(FROM)
    .filter(n => want.test(n))
    .filter(n => statSync(join(FROM, n)).mtimeMs >= cutoff)
    .map(n => ({name: n, text: readFileSync(join(FROM, n), "utf8")}))
    .filter(f => f.text.trim() !== "undefined" && f.text.length > 40);
  if (!files.length) { console.log(`no recent exports in ${FROM}`); return; }

  const got = readAny(files, parseCSV);
  const {trades} = pairTrades(got.fills);
  for (const t of trades) analyse(t, got.moves, got.spans);

  const fast = {}, slow = {};
  for (const sym of new Set(trades.map(t => FEED[t.symbol]).filter(Boolean))) {
    fast[sym] = series(sym, "1m");
    slow[sym] = series(sym, "5m");
  }

  let drawn = 0, at5 = 0;
  for (const t of trades) {
    t.source = "live";
    if (attachBars(t, fast[FEED[t.symbol]], OFFSET, slow[FEED[t.symbol]])) {
      analyseExcursion(t);
      drawn++;
      if (t.bars_tf === "5m") at5++;
    }
  }

  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, JSON.stringify(
    {trades, start: null, saved: new Date().toISOString()}), "utf8");

  console.log(`${trades.length} trades, ${drawn} with candles `
    + `(${at5} of them at five minutes)`);
  console.log(`-> ${OUT}`);
}

main();
