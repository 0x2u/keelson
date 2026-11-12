import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 time-based one-time passwords: HMAC-SHA1, 30 s steps, 6 digits (what authenticator apps use). */

export const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes from the previous and the next step are accepted, to absorb clock drift. */
const WINDOW = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("not a base32 string");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32 encoded for the authenticator app. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function codeAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The current code, for tests and for showing the operator that setup worked. */
export function totpCode(secret: string, nowMs: number = Date.now()): string {
  return codeAt(base32Decode(secret), stepAt(nowMs));
}

/**
 * Checks a submitted code. Returns the step it matched, so the caller can refuse
 * the same step twice (a code is single-use), or null when it matches nothing.
 * Only steps after `lastUsedStep` are accepted.
 */
export function verifyTotp(secret: string, submitted: string, nowMs: number = Date.now(), lastUsedStep = -1): number | null {
  const code = submitted.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = stepAt(nowMs);
  let matched: number | null = null;
  // Every candidate is compared: the time taken does not reveal which one was close.
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    const expected = Buffer.from(codeAt(key, step));
    const given = Buffer.from(code);
    if (timingSafeEqual(expected, given) && step > lastUsedStep && matched === null) matched = step;
  }
  return matched;
}

/** The URL an authenticator app imports, usually from a QR code. */
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
