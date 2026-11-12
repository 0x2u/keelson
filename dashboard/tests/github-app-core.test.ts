import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INSTALLATION_PERMISSIONS, isAppId, isAppSlug, parsePrivateKey, signAppJwt, tarballUrl } from "@/lib/github-app-core";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
const NOW = 1_800_000_000;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("the app JWT", () => {
  it("is RS256, signed by the private key (verified with the public key), with iss, iat a minute back and exp under ten minutes ahead", () => {
    const jwt = signAppJwt("123456", rsa.privateKey, NOW);
    const [header, payload, signature, extra] = jwt.split(".");
    expect(extra).toBeUndefined();
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload!)).toEqual({ iat: NOW - 60, exp: NOW + 540, iss: "123456" });
    expect(jwt).not.toMatch(/[+/=]/); // base64url, unpadded
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(rsa.publicKey), Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("does not verify under another key or after the payload changed", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const [header, payload, signature] = signAppJwt("1", rsa.privateKey, NOW).split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), other.publicKey, Buffer.from(signature!, "base64url"))).toBe(false);
    const forged = Buffer.from(JSON.stringify({ iat: NOW - 60, exp: NOW + 540, iss: "2" })).toString("base64url");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${forged}`), createPublicKey(rsa.publicKey), Buffer.from(signature!, "base64url"))).toBe(false);
  });

  it("accepts a PKCS#8 key too", () => {
    const pkcs8 = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const [header, payload, signature] = signAppJwt("1", pkcs8.privateKey, NOW).split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(pkcs8.publicKey), Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("the private key", () => {
  it("is refused when it is not a PEM, naming the problem without echoing the text", () => {
    const secret = "definitely-not-a-key-material";
    expect(() => parsePrivateKey(secret)).toThrow(/not a private key in PEM format/);
    try {
      parsePrivateKey(secret);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("is refused when it is not RSA", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    expect(() => parsePrivateKey(ec.privateKey)).toThrow(/not an RSA key/);
    expect(() => signAppJwt("1", ec.privateKey, NOW)).toThrow(/not an RSA key/);
  });
});

describe("what the App's inputs must look like", () => {
  it("accepts numeric App IDs and plain slugs only", () => {
    expect(isAppId("123456")).toBe(true);
    for (const bad of ["", "12a", "1 2", "-1", "1".repeat(21)]) expect(isAppId(bad)).toBe(false);
    expect(isAppSlug("my-keelson")).toBe(true);
    for (const bad of ["", "-x", "a/b", "a b", "a".repeat(40)]) expect(isAppSlug(bad)).toBe(false);
  });

  it("asks for the minimum permissions", () => {
    expect(INSTALLATION_PERMISSIONS).toEqual({ contents: "read", statuses: "write", pull_requests: "read", metadata: "read" });
  });

  it("builds the tarball address of a commit, and nothing for anything else", () => {
    const sha = "a".repeat(40);
    expect(tarballUrl("Acme/shop", sha)).toBe(`https://api.github.com/repos/Acme/shop/tarball/${sha}`);
    expect(tarballUrl("acme/shop", "main")).toBeNull();
    expect(tarballUrl("acme/shop/../x", sha)).toBeNull();
    expect(tarballUrl("acme", sha)).toBeNull();
  });
});
