/* Locking the diary with a passcode.
 *
 * The point of this is that it is not a screen you can walk past. Setting a
 * passcode ENCRYPTS the stored record, so what sits in the browser afterwards
 * is a blob that means nothing without the passcode. Someone with your
 * unlocked phone, or with developer tools open on your laptop, gets the blob
 * and nothing else.
 *
 * The obvious consequence, said plainly because it is the one that hurts:
 * there is no recovery. No account, no reset link, nobody with a spare key.
 * Forget the passcode and the record is gone. The escape hatch is the backup
 * file, and the backup is written unencrypted on purpose so that it is a
 * recovery path rather than a second thing to forget.
 *
 * AES-GCM with a key stretched from the passcode by PBKDF2. The iteration
 * count is high enough to make guessing a short passcode slow, which is the
 * only defence a passcode short enough to type actually has.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// OWASP's floor for PBKDF2-SHA256 at the time of writing. It costs a phone
// roughly a quarter of a second, which nobody notices once and an attacker
// pays on every single guess.
const ITERATIONS = 600000;

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const available = () =>
  !!(globalThis.crypto && crypto.subtle && crypto.subtle.deriveKey);

async function keyFrom(passcode, salt) {
  const base = await crypto.subtle.importKey(
    "raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256"},
    base, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
}

/** Wrap a plain object into a locked envelope. */
export async function lock(obj, passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passcode, salt);
  const ct = await crypto.subtle.encrypt(
    {name: "AES-GCM", iv}, key, enc.encode(JSON.stringify(obj)));
  return {locked: 1, v: 1, it: ITERATIONS,
          salt: b64(salt), iv: b64(iv), ct: b64(ct)};
}

/** Open a locked envelope, or throw if the passcode is wrong.
 *
 *  AES-GCM authenticates as well as encrypts, so a wrong passcode fails
 *  outright rather than returning plausible rubbish. There is nothing to
 *  check the passcode against separately, and nothing that leaks whether it
 *  was nearly right. */
export async function unlock(env, passcode) {
  const salt = unb64(env.salt), iv = unb64(env.iv);
  const base = await crypto.subtle.importKey(
    "raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    {name: "PBKDF2", salt, iterations: env.it || ITERATIONS, hash: "SHA-256"},
    base, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  const plain = await crypto.subtle.decrypt(
    {name: "AES-GCM", iv}, key, unb64(env.ct));
  return JSON.parse(dec.decode(plain));
}

export const isLocked = raw => {
  if (!raw) return false;
  try { return JSON.parse(raw).locked === 1; } catch { return false; }
};
