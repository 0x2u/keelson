import { createHash } from "node:crypto";
import { archFromUname, type AgentArch } from "@/lib/agent-binaries-core";

// The parts of the SSH installation that need no network and no filesystem: validating what the operator typed, building the
// commands, reading what the server answers. They are the parts that can go wrong in ways worth testing.

export type SshAuth = { kind: "key"; privateKey: string; passphrase?: string } | { kind: "password"; password: string };

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** Needed when the SSH user is not root and sudo asks for a password. Never stored. */
  sudoPassword?: string;
}

export interface SshTargetInput {
  host: string;
  port: string;
  username: string;
}

/** A message per field that is wrong; empty when the input is fine. */
export type TargetErrors = Partial<Record<keyof SshTargetInput, string>>;

const HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|\[?[0-9a-fA-F:]{2,45}\]?)$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export function validateTarget(input: SshTargetInput): { errors: TargetErrors; host: string; port: number } {
  const errors: TargetErrors = {};
  const host = input.host.trim().replace(/^\[|\]$/g, "");
  if (!HOST.test(host) && !HOST.test(`[${host}]`)) errors.host = "Enter a host name or an IP address.";
  const port = Number(input.port.trim() || "22");
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "A port between 1 and 65535.";
  if (!USER.test(input.username.trim())) errors.username = "A Linux user name, such as root or debian.";
  return { errors, host, port };
}

/** Quotes a string for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The fingerprint OpenSSH shows (SHA256:...), so the operator can compare it with what the provider or `ssh-keygen -lf` says. */
export function fingerprintOf(hostKey: Buffer): string {
  return "SHA256:" + createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
}

/** What the server tells before anything is installed. */
export interface ProbeFacts {
  isRoot: boolean;
  os: string;
  machine: string;
  arch: AgentArch | null;
  docker: boolean;
  systemd: boolean;
  nginx: boolean;
  /** "root", "passwordless", or "password" (sudo needs the user's password) / "none". */
  sudo: "root" | "passwordless" | "password";
  /** The address the server sees this session coming from: the dashboard's, as seen from there. */
  clientIp: string;
  /** The version of an agent already installed, if any. */
  installedAgent: string | null;
}

export const PROBE_SCRIPT = `
echo "uid=$(id -u)"
echo "machine=$(uname -m)"
echo "os=$( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME" )"
echo "client=\${SSH_CLIENT%% *}"
echo "docker=$( (command -v docker || ls /usr/bin/docker 2>/dev/null) | head -1 )"
echo "systemd=$( [ -d /run/systemd/system ] && echo yes )"
echo "nginx=$( (command -v nginx || ls /usr/sbin/nginx 2>/dev/null) | head -1 )"
echo "agent=$( [ -x /usr/local/bin/keelson-agent ] && /usr/local/bin/keelson-agent version 2>/dev/null )"
if [ "$(id -u)" = 0 ]; then echo "sudo=root"; elif sudo -n true 2>/dev/null; then echo "sudo=passwordless"; else echo "sudo=password"; fi
`;

export function parseProbe(output: string): ProbeFacts {
  const kv: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const sudo = kv.sudo === "root" || kv.sudo === "passwordless" ? kv.sudo : "password";
  return {
    isRoot: kv.uid === "0",
    os: kv.os || "Linux",
    machine: kv.machine ?? "",
    arch: archFromUname(kv.machine ?? ""),
    docker: Boolean(kv.docker),
    systemd: kv.systemd === "yes",
    nginx: Boolean(kv.nginx),
    sudo,
    clientIp: kv.client ?? "",
    installedAgent: kv.agent || null,
  };
}

/** What `keelson-agent install` prints: everything the dashboard needs to talk to the agent. */
export interface AgentBundle {
  name: string;
  url: string;
  token: string;
  deploySecret: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  agentVersion: string;
  notes: string[];
}

/** Reads the bundle printed by the installer. It is the agent's own output, but it crosses a network: check its shape. */
export function parseBundle(output: string): AgentBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(output.slice(output.indexOf("{")));
  } catch {
    throw new Error("the installer did not print a connection bundle");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("the installer's answer is not an object");
  const str = (key: string): string => {
    const v = key in raw ? (raw as Record<string, unknown>)[key] : undefined;
    if (typeof v !== "string" || v === "") throw new Error(`the connection bundle has no "${key}"`);
    return v;
  };
  const notes = "notes" in raw && Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === "string") : [];
  const url = str("url");
  if (!/^https:\/\//.test(url)) throw new Error("the connection bundle's URL is not https");
  return {
    name: str("name"),
    url,
    token: str("token"),
    deploySecret: str("deploy_secret"),
    caCert: str("ca_cert"),
    clientCert: str("client_cert"),
    clientKey: str("client_key"),
    agentVersion: "agent_version" in raw && typeof raw.agent_version === "string" ? raw.agent_version : "",
    notes,
  };
}

export interface InstallOptions {
  /** Shown in the dashboard. */
  name: string;
  listenPort: number;
  nginx: boolean;
  /** Open the agent's port in ufw for the dashboard's address. */
  openFirewall: boolean;
}

/**
 * The command that runs the installer from the directory it was uploaded to. A sudo password goes in on stdin, never in
 * the command line. `host` is the address the dashboard reaches the server by.
 */
export function installCommand(dir: string, host: string, clientIp: string, o: InstallOptions, sudo: SshTarget["sudoPassword"] | "root" | "passwordless"): string {
  const args = [
    "install",
    "--host", shq(host),
    "--name", shq(o.name),
    "--listen", shq(`0.0.0.0:${o.listenPort}`),
    ...(o.nginx ? ["--nginx"] : []),
    ...(o.openFirewall && clientIp ? ["--allow-from", shq(clientIp)] : []),
  ].join(" ");
  return runAsRoot(dir, args, sudo);
}

/**
 * The command that replaces an installed agent with the uploaded binary. It carries nothing else: the installation
 * remembers its own address, port, name and nginx setting, so an upgrade cannot drop one by omission.
 */
export function upgradeCommand(dir: string, sudo: SshTarget["sudoPassword"] | "root" | "passwordless"): string {
  return runAsRoot(dir, "install --upgrade", sudo);
}

function runAsRoot(dir: string, args: string, sudo: SshTarget["sudoPassword"] | "root" | "passwordless"): string {
  const bin = `${shq(dir)}/keelson-agent`;
  if (sudo === "root") return `${bin} ${args}`;
  if (sudo === "passwordless") return `sudo -n ${bin} ${args}`;
  return `sudo -S -p '' ${bin} ${args}`;
}

/** What the installer's `uninstall` prints: what it did, or with a dry run what it would do. Each line is for a person. */
export interface UninstallReport {
  /** False when nothing of the agent was on the server. */
  installed: boolean;
  /** The agent's service is installed: the uninstall stops it. False when only its files remain. */
  service: boolean;
  dryRun: boolean;
  purge: boolean;
  removed: string[];
  /** What was deliberately left, with the reason. */
  kept: string[];
  /** The apps' containers: an uninstall never stops them. */
  containers: string[];
  /** Steps that failed after the agent had stopped. */
  problems: string[];
}

/** Reads the report printed by `uninstall`. It is the agent's own output, but it crosses a network: check its shape. */
export function parseUninstallReport(output: string): UninstallReport {
  const start = output.indexOf("{");
  let raw: unknown;
  try {
    raw = JSON.parse(start < 0 ? "" : output.slice(start));
  } catch {
    throw new Error("the uninstaller did not print a report");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("the uninstaller's report is not an object");
  const o = raw as Record<string, unknown>;
  const list = (key: string): string[] => (Array.isArray(o[key]) ? o[key].filter((v): v is string => typeof v === "string") : []);
  return {
    installed: o.installed === true,
    service: o.service === true,
    dryRun: o.dry_run === true,
    purge: o.purge === true,
    removed: list("removed"),
    kept: list("kept"),
    containers: list("containers"),
    problems: list("problems"),
  };
}

export interface UninstallMode {
  /** Also delete the apps file, secrets, certificates, history and the account. */
  purge: boolean;
  /** With `purge`, also delete the files in /etc/keelson the installer did not write (otherwise they are kept and listed). */
  purgeOperatorFiles?: boolean;
  /** Change nothing: report what would be done. */
  dryRun: boolean;
}

/** The command that removes the agent, run from the uploaded binary so that it behaves as this dashboard's version says. */
export function uninstallCommand(dir: string, mode: UninstallMode, sudo: SshTarget["sudoPassword"] | "root" | "passwordless"): string {
  const flags = [...(mode.purge ? ["--purge"] : []), ...(mode.purgeOperatorFiles ? ["--purge-operator-files"] : []), ...(mode.dryRun ? ["--dry-run"] : [])];
  return runAsRoot(dir, ["uninstall", ...flags].join(" "), sudo);
}
