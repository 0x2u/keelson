import { describe, expect, it } from "vitest";
import { archFromUname } from "@/lib/agent-binaries-core";
import { fingerprintOf, installCommand, parseBundle, parseProbe, parseUninstallReport, shq, uninstallCommand, validateTarget } from "@/lib/ssh-install-core";

describe("validateTarget", () => {
  it("accepts names, IPv4 and IPv6 addresses, and defaults the port", () => {
    for (const host of ["example.com", "203.0.113.10", "my-vps.internal", "2001:db8::1", "[2001:db8::1]"]) {
      expect(validateTarget({ host, port: "", username: "root" }).errors, host).toEqual({});
    }
    expect(validateTarget({ host: "a.com", port: "", username: "root" }).port).toBe(22);
    expect(validateTarget({ host: "[2001:db8::1]", port: "22", username: "root" }).host).toBe("2001:db8::1");
  });

  it("rejects anything that is not a host, a port or a Linux user name", () => {
    const bad = validateTarget({ host: "a b; rm -rf /", port: "0", username: "Root User" });
    expect(Object.keys(bad.errors).sort()).toEqual(["host", "port", "username"]);
    expect(validateTarget({ host: "a.com", port: "70000", username: "root" }).errors.port).toBeDefined();
    expect(validateTarget({ host: "a.com", port: "22x", username: "$(id)" }).errors).toMatchObject({ port: expect.any(String), username: expect.any(String) });
  });
});

describe("shq", () => {
  it("keeps any value inert in a POSIX shell", () => {
    expect(shq("plain")).toBe("'plain'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("$(rm -rf /); `id` \"x\"")).toBe(`'$(rm -rf /); \`id\` "x"'`);
  });
});

describe("fingerprintOf", () => {
  it("prints SHA256: and unpadded base64, as OpenSSH does", () => {
    const fp = fingerprintOf(Buffer.from("some host key"));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprintOf(Buffer.from("some host key"))).toBe(fp);
    expect(fingerprintOf(Buffer.from("another"))).not.toBe(fp);
  });
});

describe("parseProbe", () => {
  const out = ["uid=1000", "machine=x86_64", "os=Debian GNU/Linux 13 (trixie)", "client=203.0.113.10", "docker=/usr/bin/docker", "systemd=yes", "nginx=/usr/sbin/nginx", "agent=", "sudo=passwordless"].join("\n");

  it("reads what the server reported", () => {
    expect(parseProbe(out)).toEqual({
      isRoot: false, os: "Debian GNU/Linux 13 (trixie)", machine: "x86_64", arch: "amd64", docker: true, systemd: true, nginx: true,
      sudo: "passwordless", clientIp: "203.0.113.10", installedAgent: null,
    });
  });

  it("treats missing facts as absent and unknown sudo as needing a password", () => {
    const p = parseProbe("uid=1000\nmachine=riscv64\nsudo=weird\n");
    expect(p).toMatchObject({ docker: false, systemd: false, nginx: false, arch: null, sudo: "password", installedAgent: null });
    expect(parseProbe("uid=0\nsudo=root\nagent=0.1.0\n")).toMatchObject({ isRoot: true, sudo: "root", installedAgent: "0.1.0" });
  });
});

describe("archFromUname", () => {
  it("maps the architectures an agent is built for", () => {
    expect(archFromUname("x86_64\n")).toBe("amd64");
    expect(archFromUname("aarch64")).toBe("arm64");
    expect(archFromUname("armv7l")).toBeNull();
  });
});

describe("parseBundle", () => {
  const good = { version: 1, name: "vps", url: "https://1.2.3.4:7443", token: "t", deploy_secret: "d", ca_cert: "ca", client_cert: "cc", client_key: "ck", agent_version: "0.1.0", notes: ["n", 3] };

  it("reads the installer's output, even with noise before it", () => {
    const b = parseBundle("some banner\n" + JSON.stringify(good));
    expect(b).toMatchObject({ name: "vps", url: "https://1.2.3.4:7443", deploySecret: "d", caCert: "ca", clientKey: "ck", agentVersion: "0.1.0", notes: ["n"] });
  });

  it("refuses a bundle that is incomplete, not https, or not JSON", () => {
    expect(() => parseBundle("nope")).toThrow(/did not print/);
    expect(() => parseBundle(JSON.stringify({ ...good, token: "" }))).toThrow(/token/);
    expect(() => parseBundle(JSON.stringify({ ...good, client_key: undefined }))).toThrow(/client_key/);
    expect(() => parseBundle(JSON.stringify({ ...good, url: "http://1.2.3.4:7443" }))).toThrow(/https/);
  });
});

describe("installCommand", () => {
  const o = { name: "my vps", listenPort: 7443, nginx: true, openFirewall: true };

  it("builds the command for each way of getting root, with every value quoted", () => {
    expect(installCommand("/tmp/d", "1.2.3.4", "9.9.9.9", o, "root")).toBe(
      "'/tmp/d'/keelson-agent install --host '1.2.3.4' --name 'my vps' --listen '0.0.0.0:7443' --nginx --allow-from '9.9.9.9'",
    );
    expect(installCommand("/tmp/d", "h", "9.9.9.9", o, "passwordless")).toMatch(/^sudo -n '\/tmp\/d'\/keelson-agent install /);
    expect(installCommand("/tmp/d", "h", "9.9.9.9", o, "secret")).toMatch(/^sudo -S -p '' /);
  });

  it("never puts a password in the command line, skips what was not asked, and neutralises hostile names", () => {
    const cmd = installCommand("/tmp/d", "h", "", { ...o, nginx: false, openFirewall: false, name: "x'; reboot #" }, "hunter2");
    expect(cmd).not.toContain("hunter2");
    expect(cmd).not.toContain("--nginx");
    expect(cmd).not.toContain("--allow-from");
    expect(cmd).toContain(`'x'\\''; reboot #'`);
  });
});

describe("uninstallCommand", () => {
  const dir = "/tmp/keelson-install.abc123";

  it("asks for a dry run and a purge only when told to, and runs as root the way the installer does", () => {
    expect(uninstallCommand(dir, { purge: false, dryRun: false }, "root")).toBe(`'${dir}'/keelson-agent uninstall`);
    expect(uninstallCommand(dir, { purge: true, dryRun: false }, "passwordless")).toBe(`sudo -n '${dir}'/keelson-agent uninstall --purge`);
    expect(uninstallCommand(dir, { purge: true, dryRun: true }, "hunter2")).toBe(`sudo -S -p '' '${dir}'/keelson-agent uninstall --purge --dry-run`);
  });

  it("passes --purge-operator-files only when asked, after --purge", () => {
    expect(uninstallCommand(dir, { purge: true, purgeOperatorFiles: true, dryRun: false }, "root")).toBe(`'${dir}'/keelson-agent uninstall --purge --purge-operator-files`);
    expect(uninstallCommand(dir, { purge: true, dryRun: false }, "root")).not.toContain("operator");
  });

  it("never puts the sudo password in the command", () => {
    expect(uninstallCommand(dir, { purge: false, dryRun: false }, "s3cret pass")).not.toContain("s3cret");
  });
});

describe("parseUninstallReport", () => {
  const printed = JSON.stringify({
    installed: true,
    service: true,
    dry_run: false,
    purge: true,
    removed: ["/usr/local/bin/keelson-agent"],
    kept: ["/etc/nginx/keelson: nginx still uses its upstreams"],
    containers: ["web-1: Up 3 hours"],
    problems: [],
  });

  it("reads the report the uninstaller prints, after any text before it", () => {
    expect(parseUninstallReport(`sudo: noise\n${printed}\n`)).toEqual({
      installed: true,
      service: true,
      dryRun: false,
      purge: true,
      removed: ["/usr/local/bin/keelson-agent"],
      kept: ["/etc/nginx/keelson: nginx still uses its upstreams"],
      containers: ["web-1: Up 3 hours"],
      problems: [],
    });
  });

  it("drops what is not a string and treats a missing list as empty, so the page never breaks on an odd answer", () => {
    const r = parseUninstallReport('{"installed": true, "removed": ["a", 7, null], "kept": "nope"}');
    expect(r.removed).toEqual(["a"]);
    expect(r.kept).toEqual([]);
    expect(r.containers).toEqual([]);
  });

  it("refuses output that is not a report", () => {
    expect(() => parseUninstallReport("")).toThrow(/report/);
    expect(() => parseUninstallReport("Permission denied")).toThrow(/report/);
    expect(() => parseUninstallReport("[1,2]")).toThrow(/report/);
  });
});
