import "server-only";
import { createReadStream } from "node:fs";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { agentBinary } from "@/lib/agent-binaries";
import {
  PROBE_SCRIPT,
  fingerprintOf,
  installCommand,
  upgradeCommand,
  parseBundle,
  parseProbe,
  parseUninstallReport,
  shq,
  uninstallCommand,
  type AgentBundle,
  type InstallOptions,
  type ProbeFacts,
  type SshTarget,
  type UninstallReport,
} from "@/lib/ssh-install-core";
import { UPGRADE_TIMEOUT_MS } from "@/lib/ssh-upgrade-core";

/** Where an installation stopped: the UI shows the stage and what to do about it. */
export type InstallStage = "connect" | "hostkey" | "auth" | "probe" | "prerequisites" | "sudo" | "upload" | "install" | "verify";

export class SshInstallError extends Error {
  constructor(
    readonly stage: InstallStage,
    message: string,
    /** The command did not answer in time (it may still be running on the server). */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "SshInstallError";
  }
}

/** The installer or upgrade command itself, started on the server, did not finish in time: what it was doing is unknown. */
export class RunTimedOut extends SshInstallError {
  constructor(message: string) {
    super("install", message, true);
    this.name = "RunTimedOut";
  }
}

/** How long the installer may run over SSH: it checks the new agent for up to 25 s and a fresh install makes keys. */
const INSTALL_TIMEOUT_MS = 120_000;

const CONNECT_TIMEOUT_MS = 15_000;

interface Session {
  conn: Client;
  fingerprint: string;
}

/** Turns what ssh2 and Node report into something an operator can act on. */
function describeConnectError(err: unknown): SshInstallError {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : "";
  if (code === "ECONNREFUSED") return new SshInstallError("connect", "Connection refused: nothing listens on that port. Check the SSH port.");
  if (code === "ENOTFOUND") return new SshInstallError("connect", "The host name does not resolve.");
  if (code === "ETIMEDOUT" || /timed out/i.test(message)) return new SshInstallError("connect", "Timed out: the server did not answer. Check the address, the port and any firewall.");
  if (/authentication methods failed/i.test(message)) return new SshInstallError("auth", "The server refused these credentials. Check the user name, and the key or password.");
  if (/passphrase/i.test(message)) return new SshInstallError("auth", "The private key is protected by a passphrase: enter it.");
  if (/parse privateKey|Unsupported key format|invalid format/i.test(message)) return new SshInstallError("auth", "The private key could not be read: paste the whole key, from the BEGIN line to the END line.");
  if (/host denied|verification failed/i.test(message)) return new SshInstallError("hostkey", "The server's host key is not the one you confirmed. Someone may be impersonating the server: stop and check.");
  return new SshInstallError("connect", `Could not connect: ${message}`);
}

/**
 * Opens an SSH session. `accept` decides whether the host key is the one expected: the probe accepts any (and reports
 * it for the operator to check), the installation accepts only the fingerprint that was confirmed.
 */
function open(t: SshTarget, accept: (fingerprint: string) => boolean): Promise<Session> {
  const { promise, resolve, reject } = Promise.withResolvers<Session>();
  const conn = new Client();
  let seen = "";
  const config: ConnectConfig = {
    host: t.host,
    port: t.port,
    username: t.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    hostVerifier: (key: Buffer) => {
      seen = fingerprintOf(key);
      return accept(seen);
    },
    ...(t.auth.kind === "password"
      ? { password: t.auth.password, tryKeyboard: true }
      : { privateKey: t.auth.privateKey, passphrase: t.auth.passphrase }),
  };
  conn.once("ready", () => resolve({ conn, fingerprint: seen }));
  conn.once("error", (err) => reject(describeConnectError(err)));
  // Password servers that only offer keyboard-interactive.
  conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    finish(prompts.map(() => (t.auth.kind === "password" ? t.auth.password : "")));
  });
  try {
    conn.connect(config);
  } catch (err) {
    reject(describeConnectError(err));
  }
  return promise;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command. `feed` writes to its stdin and closes it. Output is collected whole: it is small, and the
 * installer's stdout is the bundle.
 */
function exec(conn: Client, command: string, opts: { feed?: (stream: ClientChannel) => void; timeoutMs?: number; onStderr?: (line: string) => void } = {}): Promise<ExecResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
  const timer = setTimeout(() => reject(new SshInstallError("install", "The server took too long to answer.", true)), opts.timeoutMs ?? 30_000);
  conn.exec(command, (err, stream) => {
    if (err) {
      clearTimeout(timer);
      reject(new SshInstallError("connect", `Could not run a command on the server: ${err.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let pending = "";
    stream.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    stream.stderr.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      stderr += text;
      if (opts.onStderr) {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        lines.forEach((l) => opts.onStderr?.(l));
      }
    });
    stream.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.feed) opts.feed(stream);
    else stream.end();
  });
  return promise;
}

/**
 * Reads the server's SSH host key fingerprint without logging in: the connection is dropped as soon as the key is seen, so
 * no credential is ever sent to a server whose identity has not been confirmed. The operator compares the fingerprint
 * with what the provider or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` says, exactly as on a first `ssh`.
 */
export async function fetchHostFingerprint(host: string, port: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const conn = new Client();
  let seen = "";
  conn.once("error", (err) => (seen ? resolve(seen) : reject(describeConnectError(err))));
  conn.once("close", () => (seen ? resolve(seen) : reject(new SshInstallError("connect", "The server closed the connection before sending its host key."))));
  try {
    conn.connect({
      host,
      port,
      username: "keelson-fingerprint",
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return false; // enough: do not go on to authenticate
      },
    });
  } catch (err) {
    reject(describeConnectError(err));
  }
  return promise;
}

interface Uploaded {
  conn: Client;
  dir: string;
  facts: ProbeFacts;
  /** How to run a command as root: what runAsRoot and the feed need. */
  sudo: "root" | "passwordless" | string;
}

/**
 * Logs in (only to the server whose host key was confirmed), checks the prerequisites, uploads this dashboard's agent binary to a
 * temporary directory (checked by SHA-256 on the server), runs `body`, and removes the directory. Nothing about the SSH login is
 * kept: the credentials live in this call.
 */
async function withUploadedAgent<T>(
  t: SshTarget,
  confirmedFingerprint: string,
  need: { docker: boolean },
  onProgress: (line: string) => void,
  body: (u: Uploaded) => Promise<T>,
): Promise<T> {
  const { conn } = await open(t, (fp) => fp === confirmedFingerprint);
  let dir = "";
  try {
    onProgress("Checking the server");
    const facts = parseProbe((await exec(conn, `sh -c ${shq(PROBE_SCRIPT)}`)).stdout);
    if (!facts.arch) throw new SshInstallError("prerequisites", `This server's architecture (${facts.machine}) is not supported: the agent is built for x86_64 and arm64.`);
    if (!facts.systemd) throw new SshInstallError("prerequisites", "This server does not run systemd, which the agent needs to run as a service.");
    if (need.docker && !facts.docker) throw new SshInstallError("prerequisites", "Docker is not installed on this server. Install it first: https://docs.docker.com/engine/install/");
    if (facts.sudo === "password" && !t.sudoPassword) {
      throw new SshInstallError("sudo", `${t.username} is not root and sudo asks for a password: enter it, or connect as root.`);
    }
    const binary = agentBinary(facts.arch);

    onProgress("Uploading the agent");
    const made = await exec(conn, "mktemp -d /tmp/keelson-install.XXXXXX");
    dir = made.stdout.trim();
    if (made.code !== 0 || !dir.startsWith("/tmp/keelson-install.")) throw new SshInstallError("upload", "Could not create a temporary directory on the server.");
    const up = await exec(conn, `cat > ${shq(dir)}/keelson-agent && chmod 700 ${shq(dir)}/keelson-agent && sha256sum ${shq(dir)}/keelson-agent`, {
      timeoutMs: 180_000,
      feed: (stream) => {
        const file = createReadStream(binary.path);
        file.on("error", () => stream.end());
        file.pipe(stream);
      },
    });
    if (up.code !== 0 || up.stdout.trim().split(/\s+/)[0] !== binary.sha256) {
      throw new SshInstallError("upload", "The agent was not uploaded intact: its checksum on the server does not match. Try again.");
    }
    const sudo = facts.sudo === "root" ? "root" : facts.sudo === "passwordless" ? "passwordless" : (t.sudoPassword ?? "passwordless");
    return await body({ conn, dir, facts, sudo });
  } finally {
    if (dir.startsWith("/tmp/keelson-install.")) await exec(conn, `rm -rf ${shq(dir)}`, { timeoutMs: 10_000 }).catch(() => undefined);
    conn.end();
  }
}

/**
 * Runs the uploaded agent as root with `command`; a sudo password goes in on stdin, never in the command line. A run that
 * outlasts `timeoutMs` ends in a RunTimedOut: the command itself may well be going on.
 */
async function runUploaded(u: Uploaded, command: string, t: SshTarget, onProgress: (line: string) => void, timeoutMs = INSTALL_TIMEOUT_MS): Promise<ExecResult> {
  try {
    return await exec(u.conn, command, {
      timeoutMs,
      feed: (stream) => stream.end(u.facts.sudo === "password" ? `${t.sudoPassword}\n` : ""),
      onStderr: (line) => {
        // sudo's own prompt-free errors and the installer's progress lines are both shown; neither holds a secret.
        if (line.startsWith("keelson: ")) onProgress(line.slice("keelson: ".length));
      },
    });
  } catch (err) {
    if (err instanceof SshInstallError && err.timedOut) throw new RunTimedOut(err.message);
    throw err;
  }
}

/** What a failed run said besides its own progress lines. */
function failureReason(run: ExecResult): string {
  return run.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("keelson: "))
    .slice(-4)
    .join(" ");
}

/**
 * Installs the agent on the server and returns its connection bundle, or with "upgrade" replaces the installed agent
 * with this dashboard's binary, keeping how it was set up. The server must present the host key whose fingerprint was
 * confirmed. Nothing about the SSH login is kept: the credentials live in this call.
 */
export async function installAgentOverSsh(t: SshTarget, confirmedFingerprint: string, o: InstallOptions | "upgrade", onProgress: (line: string) => void = () => {}): Promise<AgentBundle> {
  return withUploadedAgent(t, confirmedFingerprint, { docker: true }, onProgress, async (u) => {
    onProgress("Installing");
    const command = o === "upgrade" ? upgradeCommand(u.dir, u.sudo) : installCommand(u.dir, t.host, u.facts.clientIp, o, u.sudo);
    const run = await runUploaded(u, command, t, onProgress, o === "upgrade" ? UPGRADE_TIMEOUT_MS : undefined);
    if (run.code !== 0) {
      const reason = failureReason(run);
      throw new SshInstallError("install", reason ? `The installer failed: ${reason}` : `The installer exited with status ${run.code}.`);
    }
    return parseBundle(run.stdout);
  });
}

/** What an uninstall answered: the report, and the failure when it stopped short. */
export interface UninstallOutcome {
  report: UninstallReport;
  /** Set when the uninstaller exited with an error: the agent may be gone with some steps failed, or still there. */
  error?: string;
}

/**
 * Looks at what an uninstall would do, without changing anything: with and without `purge`, in one login, so the
 * operator can compare them before choosing.
 */
export async function previewUninstallOverSsh(t: SshTarget, confirmedFingerprint: string, onProgress: (line: string) => void = () => {}): Promise<{ keep: UninstallReport; purge: UninstallReport }> {
  return withUploadedAgent(t, confirmedFingerprint, { docker: false }, onProgress, async (u) => {
    onProgress("Looking at what is installed");
    const read = async (purgeMode: boolean): Promise<UninstallReport> => {
      const run = await runUploaded(u, uninstallCommand(u.dir, { purge: purgeMode, dryRun: true }, u.sudo), t, onProgress);
      if (run.code !== 0) {
        const reason = failureReason(run);
        throw new SshInstallError("install", reason ? `The check failed: ${reason}` : `The check exited with status ${run.code}.`);
      }
      return parseUninstallReport(run.stdout);
    };
    return { keep: await read(false), purge: await read(true) };
  });
}

/**
 * Removes the agent. The apps' containers are never touched. If the agent cannot be stopped nothing is removed and the
 * outcome says so; if some later step fails the report lists it.
 */
export async function uninstallAgentOverSsh(t: SshTarget, confirmedFingerprint: string, purge: boolean, onProgress: (line: string) => void = () => {}, purgeOperatorFiles = false): Promise<UninstallOutcome> {
  return withUploadedAgent(t, confirmedFingerprint, { docker: false }, onProgress, async (u) => {
    onProgress("Removing the agent");
    const run = await runUploaded(u, uninstallCommand(u.dir, { purge, purgeOperatorFiles: purge && purgeOperatorFiles, dryRun: false }, u.sudo), t, onProgress);
    let report: UninstallReport | null = null;
    try {
      report = parseUninstallReport(run.stdout);
    } catch {
      /* no report: the failure below says why */
    }
    if (run.code === 0 && report) return { report };
    const reason = failureReason(run);
    if (!report) throw new SshInstallError("install", reason ? `The uninstall failed: ${reason}` : `The uninstall exited with status ${run.code}.`);
    return { report, error: reason || `The uninstall exited with status ${run.code}.` };
  });
}
