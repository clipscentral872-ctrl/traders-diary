/* Check that a journal keeps belonging to the person who set the PIN.
 *
 * This module decides whether Chris can get back into his own record, and
 * there is no reset and no spare key. The failures that matter are all
 * silent ones: a journal that opens on the wrong PIN, a second person's
 * writes landing in the first person's storage, and a PIN change that moves
 * the lock without moving what is behind it.
 *
 *   node tools/test_profile.mjs
 */
import * as P from "../docs/profile.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`
    + (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

/* A localStorage that behaves like the real one, including running out.
 *
 * The interesting bug here only appears when a write fails, and the real one
 * fails by throwing. A shim that always succeeds would test nothing. */
const store = new Map();
let refuse = null;                  // a substring: writes to keys matching it throw
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (refuse && k.includes(refuse)) {
      const e = new Error("QuotaExceededError");
      e.name = "QuotaExceededError";
      throw e;
    }
    store.set(k, String(v));
  },
  removeItem: k => store.delete(k),
};

console.log("\ntwo people on one device get two journals");
const mine = await P.create("1234", "Chris");
check("a journal was made", !!mine, true);
P.set("trades", "my record");
const myKey = P.key("trades");
P.close();

const theirs = await P.create("9999", "Mate");
check("and a second one", !!theirs, true);
check("with a different id", P.key("trades") === myKey, false);
P.set("trades", "their record");
P.close();

console.log("\neach PIN opens its own and nothing else");
check("mine opens mine", !!(await P.open("1234")), true);
check("and reads my record", P.get("trades"), "my record");
P.close();
check("theirs opens theirs", !!(await P.open("9999")), true);
check("and reads theirs", P.get("trades"), "their record");
P.close();
check("a PIN nobody set opens nothing", !!(await P.open("0000")), false);

console.log("\nnothing is stored while no journal is open");
{
  check("no key to write to", P.key("trades"), null);
  check("writing is refused", P.set("trades", "leaked"), false);
  check("and reading gives nothing", P.get("trades"), null);
  // The bug this exists to stop: an unprefixed bucket the next journal adopts.
  check("nothing landed in a shared bucket",
        [...store.keys()].some(k => k === "tradersdiary.trades"), false);
}

console.log("\nchanging the PIN moves the lock, not the record");
{
  await P.open("1234");
  const before = P.key("trades");
  const undo = await P.rekey("5678");
  check("it took", !!undo, true);
  check("the storage key did not move", P.key("trades"), before);
  check("so the record is still readable", P.get("trades"), "my record");
  P.close();
  check("the old PIN no longer opens it", !!(await P.open("1234")), false);
  check("the new one does", !!(await P.open("5678")), true);
  check("and it is the same journal", P.get("trades"), "my record");
  P.close();
}

console.log("\na PIN change that cannot be completed is put back");
{
  /* The real hazard. The record is re-encrypted with the new PIN and then
   * written, and that write can fail. Before this, the failure was ignored:
   * the journal moved to the new PIN while the record inside it stayed
   * locked with the old one, and the app said Done. That is the record gone,
   * with no reset and no spare key. */
  await P.open("5678");
  const undo = await P.rekey("4321");
  check("the new PIN is live", await (async () => {
    P.close(); return !!(await P.open("4321"));
  })(), true);
  P.close();

  undo.undo();
  check("after undoing, the new PIN does not open it", !!(await P.open("4321")), false);
  check("and the one it had before does", !!(await P.open("5678")), true);
  check("with the record still there", P.get("trades"), "my record");
  P.close();
}

console.log("\nand the app's own order of writes survives a full disk");
{
  await P.open("5678");
  const undo = await P.rekey("1111");
  // What app.js does next: store the re-locked record. Make it fail.
  refuse = ".v1";
  const stored = P.set("v1", "the re-locked record");
  refuse = null;
  check("the write failed, as arranged", stored, false);
  undo.undo();                       // what app.js now does about it
  P.close();
  check("so the PIN never moved", !!(await P.open("1111")), false);
  check("and the journal still opens", !!(await P.open("5678")), true);
  check("with its record intact", P.get("trades"), "my record");
  P.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
