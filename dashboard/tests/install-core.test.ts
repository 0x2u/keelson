import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installLine, installRefusal, installScript, isLocalOrigin, originProblem, shellQuote, upgradeLine } from "@/lib/install-core";
import { parseConnection } from "@/lib/relay-core";

describe("the dashboard address a server is sent to", () => {
  it.each(["https://keelson.example.com", "https://keelson.example.com:8443", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost"])("accepts %s", (origin) => {
    expect(originProblem(origin)).toBeNull();
  });

  it.each(["http://keelson.example.com", "http://10.0.0.5:3000", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "ftp://x", ""])("refuses %s: secrets and the binary would travel in the clear", (origin) => {
    expect(originProblem(origin)).toMatch(/plain http/);
  });
});

describe("an address that only reaches this machine", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost"])("is local: %s", (origin) => {
    expect(isLocalOrigin(origin)).toBe(true);
  });
  it.each(["https://keelson.example.com", "http://keelson.example.com", "http://localhost.evil.example"])("is not local: %s", (origin) => {
    expect(isLocalOrigin(origin)).toBe(false);
  });
});

describe("shell quoting", () => {
  it("leaves a plain word alone and quotes everything else, including a single quote", () => {
    expect(shellQuote("https://keelson.example.com/install")).toBe("https://keelson.example.com/install");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's $(x)")).toBe(`'it'\\''s $(x)'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("the commands the dashboard shows", () => {
  it("installs with the code, as root", () => {
    expect(installLine("https://keelson.example.com", "AbC_-123")).toBe("curl -fsSL https://keelson.example.com/install | sudo sh -s -- --code AbC_-123");
  });

  it("upgrades with a fresh code", () => {
    expect(upgradeLine("https://keelson.example.com", "AbC_-123")).toBe("curl -fsSL https://keelson.example.com/install | sudo sh -s -- --upgrade --code AbC_-123");
  });

  it("quotes an address that is not a plain word", () => {
    expect(installLine("http://localhost:3000", "c")).toBe("curl -fsSL http://localhost:3000/install | sudo sh -s -- --code c");
    expect(installLine("https://a b.example", "c")).toContain("'https://a b.example/install'");
  });
});

describe("the script that cannot be a real one", () => {
  it("is a script that says why on stderr and fails, whatever the message holds", () => {
    expect(installRefusal("no address")).toBe("#!/bin/sh\necho 'keelson: no address' >&2\nexit 1\n");
    const script = installRefusal("it's $(touch /tmp/pwned)\nrm -rf /");
    expect(script.split("\n")).toHaveLength(4);
    const run = spawnSync("sh", ["-s"], { input: script, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("keelson: it's $(touch /tmp/pwned) rm -rf /\n");
  });
});

// ---- The script itself, run against stand-ins for the machine's commands ---------------------------------------------

const ORIGIN = "https://keelson.example.com";
const script = installScript(ORIGIN);
const dir = mkdtempSync(path.join(tmpdir(), "keelson-install-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A directory of commands that answer as the test says (FAKE_OS, FAKE_ARCH, FAKE_UID, FAKE_CURL, FAKE_BROKEN) and log what they were asked. */
function stubs(docker: boolean): { bin: string; log: string } {
  const bin = mkdtempSync(path.join(dir, "bin-"));
  const log = path.join(bin, "log");
  const put = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  put("uname", `case "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac`);
  put("id", `echo "$FAKE_UID"`);
  put("sudo", `exec "$@"`);
  if (docker) put("docker", "exit 0");
  // The download: records the address and writes an agent that logs what it is run with.
  put(
    "curl",
    `[ "$FAKE_CURL" = fail ] && exit 22
out=""
hdr=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; -D) hdr=$2; shift 2 ;; http*) echo "$1" >> "${log}"; shift ;; *) shift ;; esac
done
cat > "$out" <<'AGENT'
#!/bin/sh
[ "$1" = version ] && { [ "$FAKE_BROKEN" = 1 ] && exit 1; echo test; exit 0; }
echo "$@" >> "${log}"
AGENT
# The checksum header of the real route: FAKE_SUM=good announces the right one, any other value is announced as it is.
if [ -n "$hdr" ] && [ -n "$FAKE_SUM" ]; then
  if [ "$FAKE_SUM" = good ]; then s=$( (sha256sum "$out" 2>/dev/null || shasum -a 256 "$out") | awk '{print $1}'); else s=$FAKE_SUM; fi
  printf 'HTTP/1.1 200 OK\\r\\nX-Checksum-Sha256: %s\\r\\n\\r\\n' "$s" > "$hdr"
fi`,
  );
  return { bin, log };
}

/** A PATH with every command of the system's own directories except docker: a CI runner has the real one, and "docker is missing" must be a fact of the test. */
let withoutDocker: string | undefined;
function pathWithoutDocker(): string {
  if (withoutDocker !== undefined) return withoutDocker;
  const dirOfLinks = mkdtempSync(path.join(dir, "nodocker-"));
  for (const sys of ["/usr/bin", "/bin"]) {
    let names: string[] = [];
    try {
      names = readdirSync(sys);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "docker" || existsSync(path.join(dirOfLinks, name))) continue;
      try {
        symlinkSync(path.join(sys, name), path.join(dirOfLinks, name));
      } catch {
        // a name that cannot be linked is not one the script needs
      }
    }
  }
  withoutDocker = dirOfLinks;
  return withoutDocker;
}

function run(args: string[], env: Record<string, string> = {}) {
  const noDocker = env.FAKE_DOCKER === "0";
  const { bin, log } = stubs(!noDocker);
  const cwd = mkdtempSync(path.join(dir, "cwd-"));
  const result = spawnSync("/bin/sh", ["-s", "--", ...args], {
    input: script,
    encoding: "utf8",
    cwd,
    env: { PATH: `${bin}:${noDocker ? pathWithoutDocker() : "/usr/bin:/bin"}`, FAKE_OS: "Linux", FAKE_ARCH: "x86_64", FAKE_UID: "0", NODE_ENV: "test", ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, calls, cwd };
}

describe("the install script", () => {
  it("is valid POSIX sh", () => {
    const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    if (spawnSync("sh", ["-c", "command -v shellcheck"]).status === 0) {
      const check = spawnSync("shellcheck", ["-s", "sh", "-"], { input: script, encoding: "utf8" });
      expect(check.stdout, "shellcheck").toBe("");
    }
  });

  it("is inert until the last line, so a download cut short runs nothing", () => {
    const lines = script.trimEnd().split("\n");
    expect(lines.at(-1)).toBe('main "$@"');
    expect(lines.slice(0, -1).filter((l) => /^[a-z]/.test(l) && !/^(set|main|say|fail|usage|ORIGIN)/.test(l))).toEqual([]);
  });

  it("bakes in the address it was asked for, quoted", () => {
    expect(installScript(ORIGIN)).toContain(`ORIGIN=${ORIGIN}\n`);
    expect(installScript("https://it's.example")).toContain(`ORIGIN='https://it'\\''s.example'\n`);
  });

  it("downloads the agent for this machine by code, then installs it with the dashboard and the code", () => {
    const r = run(["--code", "AbC_-123"], { FAKE_ARCH: "aarch64" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([`${ORIGIN}/api/relay/binary?os=linux&arch=arm64&code=AbC_-123`, `install --dashboard ${ORIGIN} --code AbC_-123`]);
  });

  it("passes the name it was given, as one argument", () => {
    const r = run(["--code", "c1", "--name", "web 1; rm -rf /"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.at(-1)).toBe(`install --dashboard ${ORIGIN} --code c1 --name web 1; rm -rf /`);
  });

  it("upgrades keeping the way the server was set up: the code only downloads the binary", () => {
    const r = run(["--upgrade", "--code", "c1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([`${ORIGIN}/api/relay/binary?os=linux&arch=amd64&code=c1`, "install --upgrade"]);
  });

  it("never prints the code", () => {
    const r = run(["--code", "SECRETCODE123"]);
    expect(r.stdout + r.stderr).not.toContain("SECRETCODE123");
    const refused = run(["--code", "SECRETCODE123"], { FAKE_UID: "1000" });
    expect(refused.stdout + refused.stderr).not.toContain("SECRETCODE123");
    const failed = run(["--code", "SECRETCODE123"], { FAKE_CURL: "fail" });
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).not.toContain("SECRETCODE123");
  });

  it("only warns about a missing Docker on a Mac: on a server the agent's install judges it, before the code is spent", () => {
    const mac = run(["--code", "c1"], { FAKE_DOCKER: "0", FAKE_OS: "Darwin", FAKE_UID: "501" });
    expect(mac.status).toBe(0);
    expect(mac.stderr).toContain("docker was not found");
    const server = run(["--code", "c1"], { FAKE_DOCKER: "0" });
    expect(server.stderr).not.toContain("docker was not found");
    expect(server.calls.at(-1)).toContain("install --dashboard");
  });

  it("installs when the checksum the dashboard announced is the one of what it downloaded", () => {
    const r = run(["--code", "c1"], { FAKE_SUM: "good" });
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toContain("install --dashboard");
  });

  it("refuses a download that does not match the announced checksum, before running anything it fetched", () => {
    const r = run(["--code", "c1"], { FAKE_SUM: "0".repeat(64) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not match the checksum");
    // Only the download itself was asked: the agent was never run (it logs its arguments when it runs).
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("/api/relay/binary");
  });

  it("goes on when an older dashboard announces no checksum", () => {
    const r = run(["--code", "c1"]);
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toContain("install --dashboard");
  });

  it("refuses a Linux user that is not root, telling to use sudo, and downloads nothing", () => {
    const r = run(["--code", "c1"], { FAKE_UID: "1000" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("needs root");
    expect(r.stderr).toContain("sudo sh");
    expect(r.calls).toEqual([]);
  });

  it("refuses root on a Mac: it connects as the user, as a build machine", () => {
    const r = run(["--code", "c1"], { FAKE_OS: "Darwin", FAKE_ARCH: "arm64", FAKE_UID: "0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("without sudo");
    expect(r.calls).toEqual([]);
  });

  it("connects a Mac in the foreground as a build machine, with the connection string the agent reads", () => {
    const r = run(["--code", "c1"], { FAKE_OS: "Darwin", FAKE_ARCH: "arm64", FAKE_UID: "501" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls[0]).toBe(`${ORIGIN}/api/relay/binary?os=darwin&arch=arm64&code=c1`);
    const [verb, connection] = r.calls[1].split(" ");
    expect(verb).toBe("connect");
    expect(parseConnection(connection)).toEqual({ url: ORIGIN, code: "c1" });
    expect(existsSync(path.join(r.cwd, "keelson-agent"))).toBe(true);
  });

  it("does not upgrade a Mac: there is nothing installed there", () => {
    const r = run(["--upgrade", "--code", "c1"], { FAKE_OS: "Darwin", FAKE_ARCH: "arm64", FAKE_UID: "501" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--upgrade is for servers");
  });

  it.each([
    ["an operating system with no agent", { FAKE_OS: "FreeBSD" }, "unsupported operating system"],
    ["a processor with no agent", { FAKE_ARCH: "riscv64" }, "unsupported processor"],
    ["a download that fails (an expired code)", { FAKE_CURL: "fail" }, "may have expired"],
    ["a binary that does not run here", { FAKE_BROKEN: "1" }, "does not run on this machine"],
  ])("stops on %s", (_what, env, message) => {
    const r = run(["--code", "c1"], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.calls.some((c) => c.startsWith("install"))).toBe(false);
  });

  it.each([
    ["no code", [], "--code is required"],
    ["a code with characters a code never has", ["--code", "a b;c"], "characters a code never has"],
    ["a flag it does not know", ["--code", "c1", "--frob"], "unknown option: --frob"],
    ["a flag without its value", ["--code"], "--code needs a value"],
  ])("refuses %s", (_what, args, message) => {
    const r = run(args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.calls).toEqual([]);
  });

  it("leaves nothing behind in its temporary directory, finished or failed", () => {
    for (const env of [{} as Record<string, string>, { FAKE_CURL: "fail" }]) {
      const scratch = mkdtempSync(path.join(dir, "tmp-"));
      run(["--code", "c1"], { ...env, TMPDIR: scratch });
      expect(readdirSync(scratch), JSON.stringify(env)).toEqual([]);
    }
  });
});
