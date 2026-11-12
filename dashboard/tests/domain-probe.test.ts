import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchHttps, probeCertificate, resolveHost } from "@/lib/domain-probe";
import { makeTestCert } from "./tls-fixture";

const { key, cert } = makeTestCert();
const listening = <T extends { listen(port: number, host: string, cb: () => void): unknown; address(): unknown }>(server: T): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

let tlsServer: TlsServer;
let tlsPort = 0;
let alertServer: TlsServer;
let alertPort = 0;
const held: Socket[] = [];
let silent: NetServer;
let silentPort = 0;
let web: HttpsServer;
let webPort = 0;
let status = 200;
let location: string | undefined;

beforeAll(async () => {
  tlsServer = createTlsServer({ key, cert }, (socket) => socket.end());
  tlsPort = await listening(tlsServer);
  // A TLS server with no certificate at all: it answers the handshake with an alert, as a proxy does for a name it cannot serve.
  alertServer = createTlsServer({}, (socket) => socket.end());
  alertServer.on("tlsClientError", () => {});
  alertPort = await listening(alertServer);
  silent = createNetServer((socket) => void held.push(socket)); // accepts the connection and never speaks
  silentPort = await listening(silent);
  web = createHttpsServer({ key, cert }, (_req, res) => {
    res.writeHead(status, location ? { location } : {});
    res.end("hello");
  });
  webPort = await listening(web);
});
afterAll(async () => {
  for (const socket of held) socket.destroy();
  web.closeAllConnections();
  for (const s of [tlsServer, alertServer, silent, web]) await new Promise((r) => s.close(r));
});

describe("probeCertificate", () => {
  it("reads the certificate a server presents for the name, whatever DNS says: issuer, names, validity", async () => {
    const out = await probeCertificate("127.0.0.1", "app.example.test", { port: tlsPort });
    expect(out).toMatchObject({ kind: "cert", issuer: "Keelson Test Root", names: ["localhost", "app.example.test"], matches: true });
    if (out.kind !== "cert") throw new Error();
    expect(out.validTo).toBeGreaterThan(Date.now());
    expect(out.validFrom).toBeLessThanOrEqual(Date.now());
  });

  it("says a certificate from an issuer the system does not trust is not trusted, and why", async () => {
    const out = await probeCertificate("127.0.0.1", "app.example.test", { port: tlsPort });
    expect(out).toMatchObject({ kind: "cert", matches: true, trusted: false, trustError: expect.stringMatching(/SELF_SIGNED|UNABLE_TO/) });
  });

  it("says a certificate is trusted when its chain leads to a root that is trusted", async () => {
    const out = await probeCertificate("127.0.0.1", "app.example.test", { port: tlsPort, ca: cert });
    expect(out).toMatchObject({ kind: "cert", matches: true, trusted: true });
    expect((out as { trustError?: string }).trustError).toBeUndefined();
  });

  it("says a certificate is for another name when it does not cover the one asked for", async () => {
    const out = await probeCertificate("127.0.0.1", "other.example.test", { port: tlsPort, ca: cert });
    expect(out).toMatchObject({ kind: "cert", matches: false, trusted: false });
  });

  it("reports the alert of a proxy that has no certificate for the name as 'no certificate yet'", async () => {
    const out = await probeCertificate("127.0.0.1", "app.example.test", { port: alertPort });
    expect(out.kind).toBe("no_cert");
  });

  it("reports a closed port as refused", async () => {
    // a port that was free a moment ago and has nobody on it now
    const free = await new Promise<number>((resolve) => {
      const s = createNetServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    expect(await probeCertificate("127.0.0.1", "app.example.test", { port: free })).toEqual({ kind: "refused" });
  });

  it("gives up on a server that accepts and never answers", async () => {
    const started = Date.now();
    expect(await probeCertificate("127.0.0.1", "app.example.test", { port: silentPort, timeoutMs: 300 })).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("fetchHttps", () => {
  it("reports the status of GET / when the certificate verifies", async () => {
    status = 200;
    location = undefined;
    expect(await fetchHttps("localhost", { port: webPort, ca: cert })).toEqual({ kind: "status", status: 200 });
    status = 502;
    expect(await fetchHttps("localhost", { port: webPort, ca: cert })).toEqual({ kind: "status", status: 502 });
  });

  it("reports a redirect and does not follow it", async () => {
    status = 301;
    location = "https://www.example.test/";
    expect(await fetchHttps("localhost", { port: webPort, ca: cert })).toEqual({ kind: "status", status: 301, location: "https://www.example.test/" });
  });

  it("does not accept a certificate the system does not trust: that is an error, said in words", async () => {
    status = 200;
    location = undefined;
    const out = await fetchHttps("localhost", { port: webPort });
    expect(out).toEqual({ kind: "error", message: expect.stringMatching(/certificate was not accepted \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)/) });
  });

  it("times out on a server that never answers", async () => {
    const out = await fetchHttps("localhost", { port: silentPort, timeoutMs: 300 });
    expect(out).toEqual({ kind: "error", message: "no answer within 5 seconds" });
  });
});

describe("resolveHost", () => {
  it("answers with the addresses the system resolver gives (localhost is in every hosts file)", async () => {
    const out = await resolveHost("localhost");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.addresses.some((a) => a === "127.0.0.1" || a === "::1")).toBe(true);
  });

  it("says a name that does not exist has no address, rather than failing", async () => {
    expect(await resolveHost("keelson-no-such-name.invalid")).toEqual({ ok: false, reason: "none" });
  });
});
