import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A throwaway self-signed certificate (a day) for localhost and app.example.test, made with openssl, and its key: a TLS
 * server for the probe tests. Nothing is kept on disk.
 */
export function makeTestCert(): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "keelson-tls-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "2", "-subj", "/O=Keelson Test/CN=Keelson Test Root", "-addext", "subjectAltName=DNS:localhost,DNS:app.example.test"],
      { stdio: "ignore" },
    );
    return { key: readFileSync(path.join(dir, "key.pem"), "utf8"), cert: readFileSync(path.join(dir, "cert.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
