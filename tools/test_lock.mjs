/* Check the passcode lock actually locks.
 *
 * The failure that would matter is a lock that looks like a lock and is not:
 * data still readable, or a wrong passcode quietly returning something. Both
 * are tested here rather than assumed from the fact that the code mentions
 * AES.
 *
 *   node tools/test_lock.mjs
 */
import * as L from "../docs/lock.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`
    + (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

const record = {
  trades: [{symbol: "NQ", side: "Short", entry: 29559.75, pnl: 1090,
            note: "the one that paid"}],
  start: 100000,
};

console.log("\nlocking hides the record");
const env = await L.lock(record, "hunter2");
const asStored = JSON.stringify(env);
check("marked as locked", env.locked, 1);
check("the symbol is not in the stored text", asStored.includes("NQ"), false);
check("nor the entry price", asStored.includes("29559"), false);
check("nor the note", asStored.includes("the one that paid"), false);
check("nor the balance", asStored.includes("100000"), false);
check("recognised as locked when read back", L.isLocked(asStored), true);

console.log("\nthe right passcode gets it back exactly");
check("round trip", await L.unlock(env, "hunter2"), record);

console.log("\na wrong passcode fails outright");
let threw = false;
try { await L.unlock(env, "hunter3"); } catch { threw = true; }
check("throws rather than returning rubbish", threw, true);
threw = false;
try { await L.unlock(env, ""); } catch { threw = true; }
check("an empty passcode throws too", threw, true);

console.log("\nevery lock is different, even with the same passcode");
const a = await L.lock(record, "same");
const b = await L.lock(record, "same");
check("salts differ", a.salt === b.salt, false);
check("ciphertexts differ", a.ct === b.ct, false);
check("both still open", await L.unlock(b, "same"), record);

console.log("\nan unlocked record is not mistaken for a locked one");
check("plain storage reads as unlocked",
  L.isLocked(JSON.stringify({trades: [], start: null})), false);
check("empty reads as unlocked", L.isLocked(""), false);
check("junk reads as unlocked", L.isLocked("not json"), false);

console.log("\nthe stretching is not cheap");
check("iteration count is at the recommended floor or above",
  env.it >= 600000, true);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
