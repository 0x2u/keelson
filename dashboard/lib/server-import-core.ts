import { validateServer, type ServerFormValues } from "@/lib/server-input";
import { validateTarget } from "@/lib/ssh-install-core";

// The import file: a list of servers to register in one go. Pure parsing and validation, so it can be tested and shared by
// the form and the server action. The file holds secrets: keep it out of version control (`*.local.json` is ignored).
//
//   { "servers": [
//       { "name": "local", "url": "http://127.0.0.1:7070", "token": "…" },
//       { "name": "vps", "ssh": { "host": "203.0.113.7", "port": 22, "user": "debian" } }
//   ] }
//
// An entry with a url is an agent that already runs: it is checked and registered. An entry with an ssh section is a server
// the agent is not on yet: it cannot be registered from a file (the installer needs the host key confirmed and a login),
// so the import hands it to the installer with the address filled in.

const AGENT_KEYS = ["name", "url", "token", "deploy_secret", "ca_cert", "client_cert", "client_key"] as const;
const SSH_KEYS = ["host", "port", "user"] as const;

export type ImportEntry =
  | { kind: "agent"; name: string; values: ServerFormValues }
  | { kind: "ssh"; name: string; host: string; port: string; user: string };

/** One line of the file: the entry, or why it cannot be imported. */
export type ImportRow = { name: string; entry: ImportEntry; error?: undefined } | { name: string; entry?: undefined; error: string };

export type ParsedImport = { ok: true; rows: ImportRow[] } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string field, or "" when absent. A wrong type is reported rather than coerced: a numeric token would silently change. */
function str(o: Record<string, unknown>, key: string, problems: string[]): string {
  const v = o[key];
  if (v === undefined) return "";
  if (typeof v !== "string") {
    problems.push(`${key} must be a string`);
    return "";
  }
  return v.trim();
}

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
  const bad = Object.keys(o).filter((k) => !allowed.includes(k));
  return bad.length > 0 ? [`unknown ${bad.length === 1 ? "key" : "keys"} ${bad.map((k) => `"${k}"`).join(", ")}${where}`] : [];
}

function parseEntry(raw: unknown): ImportRow {
  if (!isRecord(raw)) return { name: "?", error: "each server must be an object" };
  const problems: string[] = [];
  const name = str(raw, "name", problems);
  const label = name || "?";

  if (raw.ssh !== undefined) {
    if (!isRecord(raw.ssh)) return { name: label, error: "ssh must be an object with host, port and user" };
    const extra = Object.keys(raw).filter((k) => k !== "name" && k !== "ssh");
    if (extra.length > 0) problems.push(`a server with ssh cannot also have ${extra.map((k) => `"${k}"`).join(", ")}: it has no agent yet`);
    problems.push(...unknownKeys(raw.ssh, SSH_KEYS, " in ssh"));
    const host = str(raw.ssh, "host", problems);
    const portRaw = raw.ssh.port;
    const port = typeof portRaw === "number" ? String(portRaw) : str(raw.ssh, "port", problems);
    if (portRaw !== undefined && typeof portRaw !== "number" && typeof portRaw !== "string") problems.push("port must be a number");
    const user = str(raw.ssh, "user", problems) || "root";
    const target = validateTarget({ host, port, username: user });
    problems.push(...Object.values(target.errors));
    if (name.length < 1 || name.length > 60) problems.push("name must be between 1 and 60 characters");
    if (problems.length > 0) return { name: label, error: problems.join("; ") };
    return { name, entry: { kind: "ssh", name, host: target.host, port: String(target.port), user } };
  }

  problems.push(...unknownKeys(raw, AGENT_KEYS, ""));
  const values: ServerFormValues = {
    name,
    url: str(raw, "url", problems),
    token: str(raw, "token", problems),
    deploySecret: str(raw, "deploy_secret", problems),
    caCert: str(raw, "ca_cert", problems),
    clientCert: str(raw, "client_cert", problems),
    clientKey: str(raw, "client_key", problems),
  };
  if (problems.length > 0) return { name: label, error: problems.join("; ") };
  const errors = Object.values(validateServer(values, false));
  if (errors.length > 0) return { name: label, error: errors.join(" ") };
  return { name, entry: { kind: "agent", name, values } };
}

/** Reads the import file. A name used twice is refused on its second use, so a copy-paste cannot overwrite silently. */
export function parseImport(text: string): ParsedImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
  if (!isRecord(doc) || !Array.isArray(doc.servers)) return { ok: false, error: 'Expected an object with a "servers" list.' };
  if (doc.servers.length === 0) return { ok: false, error: "The servers list is empty." };
  const extra = Object.keys(doc).filter((k) => k !== "servers");
  if (extra.length > 0) return { ok: false, error: `Unknown top-level key ${extra.map((k) => `"${k}"`).join(", ")}.` };

  const seen = new Set<string>();
  const rows = doc.servers.map((raw): ImportRow => {
    const row = parseEntry(raw);
    if (row.error === undefined) {
      if (seen.has(row.name)) return { name: row.name, error: "this name is used twice in the file" };
      seen.add(row.name);
    }
    return row;
  });
  return { ok: true, rows };
}
