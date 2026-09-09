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

/* What "hidden" has to mean here, and how long a needle has to be.
 *
 * This used to search the stored JSON for "NQ". The ciphertext is base64, so
 * a two character needle turns up by chance about one run in twenty: sixty
 * four symbols, one in 4096 per position, across a 268 character envelope.
 * The suite went red roughly every twentieth run with nothing wrong, on the
 * one test where a false alarm does the most damage.
 *
 * Searching the DECODED bytes instead does not save a short needle. Two
 * random bytes match one time in 65536, which over a couple of hundred
 * positions is still often enough to see, and checking twenty envelopes
 * makes it twenty times more likely again. That is the same bug a second
 * time, quieter.
 *
 * So every needle here is at least five characters. Five random bytes match
 * one time in a trillion, which is never. The symbol is checked as the JSON
 * fragment it would actually leak as, rather than as two letters that mean
 * nothing on their own.
 */
const LEAKS = ['"symbol":"NQ"', "29559", "the one that paid", "100000"];
const readable = text => LEAKS.filter(n => text.includes(n));

console.log("\nlocking hides the record");
const env = await L.lock(record, "hunter2");
const asStored = JSON.stringify(env);
const bytes = Buffer.from(env.ct, "base64").toString("latin1");
check("marked as locked", env.locked, 1);
check("nothing readable in the encrypted bytes", readable(bytes), []);
check("nor anywhere in the stored envelope", readable(asStored), []);
check("recognised as locked when read back", L.isLocked(asStored), true);

/* And every time, not usually, because the check this replaced was one that
 * only failed sometimes. */
console.log("\nand it hides it every time");
{
  let leaked = 0;
  for (let i = 0; i < 20; i++) {
    const e = await L.lock(record, "hunter2");
    if (readable(Buffer.from(e.ct, "base64").toString("latin1")).length) leaked++;
  }
  check("twenty locks, nothing readable in any of them", leaked, 0);
}

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
