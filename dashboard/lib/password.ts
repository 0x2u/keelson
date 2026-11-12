// No "server-only" import: scripts/hash-password.ts runs this outside Next.
import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// scrypt costs 128 * N * r bytes of memory: 32 MiB at these settings.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const MAX_MEM = 128 * 1024 * 1024;

/**
 * Hashes a password into "scrypt:N:r:p:salt:hash" (base64 salt and hash). The
 * delimiter is ":" because dotenv files expand "$", which would corrupt the hash.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join(":");
}

/** More sign-in attempts at once than the server can hash: the caller answers "try again" instead of queueing without end. */
export class PasswordBusyError extends Error {
  constructor() {
    super("too many password checks at once");
  }
}

/**
 * Each hash takes ~32 MiB and tens of milliseconds of a libuv thread that file and DNS work shares. Two run at a time and a
 * few wait; past that the attempt is refused outright, so a flood of failed sign-ins cannot pile up memory or starve the
 * event loop (the hash is asynchronous: it never blocks it).
 */
const MAX_CONCURRENT = 2;
const MAX_WAITING = 8;
let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  if (waiting.length >= MAX_WAITING) throw new PasswordBusyError();
  // The slot is handed over by release(), which leaves `running` as it is.
  const { promise, resolve } = Promise.withResolvers<void>();
  waiting.push(resolve);
  await promise;
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

const deriveAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number, options: ScryptOptions) => Promise<Buffer>;

/**
 * Checks a password against a stored hash in constant time. A malformed hash never matches; the work is still done so
 * timing does not reveal it. Throws PasswordBusyError when too many checks are already under way.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split(":");
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const wellFormed =
    scheme === "scrypt" &&
    Number.isInteger(params.N) && params.N >= 2 ** 14 && params.N <= 2 ** 20 &&
    Number.isInteger(params.r) && params.r >= 1 && params.r <= 32 &&
    Number.isInteger(params.p) && params.p >= 1 && params.p <= 16 &&
    128 * params.N * params.r <= MAX_MEM && // a hostile hash must not make us allocate gigabytes
    Boolean(salt) && Boolean(hash);

  const expected = Buffer.from(wellFormed ? hash : "", "base64");
  await acquire();
  let actual: Buffer;
  try {
    actual = await deriveAsync(password, Buffer.from(wellFormed ? salt : "", "base64"), expected.length || KEY_BYTES, {
      ...(wellFormed ? params : { N, r: R, p: P }),
      maxmem: MAX_MEM,
    });
  } finally {
    release();
  }
  return wellFormed && expected.length === actual.length && timingSafeEqual(expected, actual);
}
