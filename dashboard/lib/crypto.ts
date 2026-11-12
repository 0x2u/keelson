import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveKey } from "@/lib/env";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts a secret for storage (AES-256-GCM). The result is
 * "v1:" + base64(iv | tag | ciphertext), safe to keep in a text column.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("encryption"), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** Reverses encrypt. Throws if the value was tampered with or the key changed. */
export function decrypt(stored: string): string {
  const [version, payload] = stored.split(":", 2);
  if (version !== VERSION || !payload) {
    throw new Error("unsupported ciphertext format");
  }
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("ciphertext is truncated");
  }
  const decipher = createDecipheriv("aes-256-gcm", deriveKey("encryption"), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}
