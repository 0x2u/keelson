import "server-only";
import { createHash } from "node:crypto";
import tls from "node:tls";
import { Agent, fetch as undiciFetch, type buildConnector } from "undici";
import { probeAgent } from "@/lib/agent";
import { audit } from "@/lib/auth/store";
import { parseEnrolment, parseGrant, validServerName, EnrolmentFormatError, type EnrolGrant, type Enrolment } from "@/lib/enroll-core";
import { DuplicateServerError, createServer, listServers } from "@/lib/servers";

/** Same bound as every other call to an agent. */
export const ENROL_TIMEOUT_MS = 10_000;
/** The agent's answer is a few KiB of PEM; anything bigger is not an agent. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type EnrolFailure =
  | "fingerprint"
  | "tls"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "invalid_code"
  | "not_enabled"
  | "rate_limited"
  | "malformed"
  | "agent";

export type EnrolOutcome = { ok: true; grant: EnrolGrant } | { ok: false; kind: EnrolFailure; message: string };

const fail = (kind: EnrolFailure, message: string): EnrolOutcome => ({ ok: false, kind, message });

/**
 * Redeems the code at the agent, pinned to its certificate. The agent's certificate is not checked against any CA (the dashboard
 * does not have it yet: it is part of what the agent hands over); instead the connection is only handed to HTTP once the
 * certificate the agent presented hashes to the fingerprint in the enrolment string. A mismatch closes the socket at the handshake,
 * so the code is never sent to anything else. TLS 1.3 only; redirects are refused, never followed.
 */
export async function redeemEnrolment(e: Enrolment, timeoutMs: number = ENROL_TIMEOUT_MS): Promise<EnrolOutcome> {
  let mismatch = false;
  const target = new URL(e.url);
  const connect: buildConnector.connector = (opts, callback) => {
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    const socket = tls.connect({
      host,
      port: Number(opts.port) || 443,
      // An SNI name is only valid for a DNS name, not an address.
      servername: /^[a-z0-9.-]*[a-z]$/i.test(host) ? host : undefined,
      minVersion: "TLSv1.3",
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    socket.setNoDelay(true);
    socket.once("secureConnect", () => {
      const der = socket.getPeerCertificate().raw;
      const seen = der ? createHash("sha256").update(der).digest("hex") : "";
      if (seen !== e.fingerprint) {
        mismatch = true;
        socket.destroy(new Error("certificate fingerprint mismatch"));
        return;
      }
      socket.removeAllListeners("error");
      callback(null, socket);
    });
    socket.once("error", (err) => callback(err, null));
    return socket;
  };
  const dispatcher = new Agent({ connect, pipelining: 0 });

  try {
    const res = await undiciFetch(`${target.origin}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: e.code }),
      redirect: "manual",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return fail("redirect", "The agent answered with a redirect, which is refused: check the address in the enrolment string.");
    }
    const text = await readBounded(res);
    return interpret(res.status, res.headers.get("retry-after"), text);
  } catch (err) {
    if (mismatch) {
      return fail(
        "fingerprint",
        "The certificate presented at this address is not the one in the enrolment string. Nothing was sent. Either the address is not your agent or someone is intercepting the connection; check the address and generate a new string on the server.",
      );
    }
    return networkFailure(err);
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

async function readBounded(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await res.body.cancel().catch(() => {});
        throw new Error("response too large");
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function interpret(status: number, retryAfter: string | null, text: string): EnrolOutcome {
  switch (status) {
    case 200: {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail("agent", "The agent's answer is not what this dashboard expects: is it a Keelson agent of a compatible version?");
      }
      const grant = parseGrant(body);
      return grant ? { ok: true, grant } : fail("agent", "The agent's answer is incomplete or malformed: is it a Keelson agent of a compatible version?");
    }
    case 400:
      return fail("malformed", "The agent refused the request as malformed: is the agent older than this dashboard?");
    case 403:
      return fail("invalid_code", "The code is invalid, expired or already used. Run the command on the server again to get a new one.");
    case 404:
      return fail("not_enabled", "Enrolment is not enabled on this agent: it needs mutual TLS (the client CA flags) and must be a version that supports it.");
    case 429: {
      const seconds = Number(retryAfter);
      const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${Math.ceil(seconds)} s.` : " Try again in a minute.";
      return fail("rate_limited", `The agent received too many failed enrolment attempts.${wait}`);
    }
    default:
      return fail("agent", `The agent answered with an unexpected status (${status}).`);
  }
}

function networkFailure(err: unknown): EnrolOutcome {
  const code = codeOf(err);
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return fail("timeout", "The agent did not answer within 10 seconds.");
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return fail("timeout", "The agent did not answer within 10 seconds.");
  if (code === "ECONNREFUSED") return fail("unreachable", "Connection refused: the agent is not listening at this address.");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return fail("unreachable", "Host not found.");
  // The certificate matched and then the agent hung up: an agent that insists on a client certificate does exactly that (TLS 1.3
  // reports the refusal after the handshake), and only one without enrolment does, since one with it lets the connection through.
  if (code === "UND_ERR_SOCKET") {
    return fail(
      "not_enabled",
      "The agent closed the connection: it asks for a client certificate and has no enrolment. It is an agent from before enrolment codes, or enrolment is turned off. Upgrade it (sudo keelson-agent install --upgrade) or add it with the Existing agent form.",
    );
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ECONNRESET") return fail("unreachable", "The agent cannot be reached from the dashboard.");
  if (code.includes("PROTOCOL_VERSION") || code.includes("UNSUPPORTED_PROTOCOL") || code.startsWith("ERR_SSL")) {
    return fail("tls", "No TLS 1.3 connection could be made: this address does not look like a Keelson agent.");
  }
  return fail("unreachable", "The agent cannot be reached from the dashboard.");
}

/** The code of an error or of its cause, where Node puts socket and TLS failures. */
function codeOf(err: unknown): string {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

export type EnrolResult =
  | { ok: true; serverId: string; name: string; deployable: boolean }
  | { ok: false; message: string; field?: "string" | "name"; kind?: EnrolFailure | "format" | "name" | "verify" };

/**
 * The whole enrolment: parse the string strictly, redeem the code at the pinned agent, check that the agent answers with what it
 * handed over, then register it like an existing agent. The name is checked first so a typo does not burn the one-time code.
 * Neither the string nor any secret is stored, logged or put in the audit trail (which names the server and the caller only).
 */
export async function enrolServer(input: string, name: string, caller: string, timeoutMs: number = ENROL_TIMEOUT_MS): Promise<EnrolResult> {
  let e: Enrolment;
  try {
    e = parseEnrolment(input);
  } catch (err) {
    if (err instanceof EnrolmentFormatError) return { ok: false, field: "string", kind: "format", message: err.message };
    throw err;
  }
  const label = name.trim() || e.host;
  if (!validServerName(label)) {
    return { ok: false, field: "name", kind: "name", message: "The name may hold letters, digits, spaces, dots, dashes and underscores." };
  }
  if (listServers().some((s) => s.name === label)) return { ok: false, field: "name", kind: "name", message: "A server with this name already exists." };

  const outcome = await redeemEnrolment(e, timeoutMs);
  if (!outcome.ok) return { ok: false, kind: outcome.kind, message: outcome.message };

  const { grant } = outcome;
  const creds = { url: e.url, token: grant.token, deploySecret: grant.deploySecret || null, caCert: grant.caCert, clientCert: grant.clientCert, clientKey: grant.clientKey };
  try {
    await probeAgent(creds);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unexpected error";
    return {
      ok: false,
      kind: "verify",
      message: `The code was accepted but this dashboard cannot reach the agent with what it received: ${reason}. The code is spent: run the command on the server again.`,
    };
  }
  let id: string;
  try {
    id = createServer({ name: label, url: e.url, token: grant.token, deploySecret: grant.deploySecret, caCert: grant.caCert, clientCert: grant.clientCert, clientKey: grant.clientKey });
  } catch (err) {
    if (err instanceof DuplicateServerError) return { ok: false, field: "name", kind: "name", message: "A server with this name already exists." };
    throw err;
  }
  audit("server_enrol", `${label} (${e.host})`, caller);
  return { ok: true, serverId: id, name: label, deployable: grant.deploySecret !== "" };
}
