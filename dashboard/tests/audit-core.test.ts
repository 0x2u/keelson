import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigVersion } from "@/lib/agent-types";
import {
  AGENT_ACTIONS,
  DASHBOARD_EVENTS,
  auditOutcome,
  auditTarget,
  dashboardAuditHref,
  describeAgentAudit,
  describeDashboardAudit,
  parseApiCall,
} from "@/lib/audit-core";

const root = join(__dirname, "..");
const agentSource = (file: string) => readFileSync(join(root, "..", "agent", "internal", file), "utf8");

/** Every .ts/.tsx file of the dashboard's own code (not tests, not generated). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

describe("describeAgentAudit", () => {
  const entry = (action: string, path: string, status = 200, detail?: string) => ({ action, path, status, detail });

  it("says what was done to what, in a sentence", () => {
    expect(describeAgentAudit(entry("deploy", "/v1/apps/web/deploy", 200, "web"), "s1")).toMatchObject({ sentence: "Deployed web", kind: "deployment", label: "Deployment", known: true });
    expect(describeAgentAudit(entry("rollback", "/v1/apps/web/rollback", 200, "web"), "s1").sentence).toBe("Rolled back web");
    expect(describeAgentAudit(entry("container.restart", "/v1/containers/kv-web/restart", 200, "kv-web"), "s1").sentence).toBe("Restarted container kv-web");
    expect(describeAgentAudit(entry("job.run", "/v1/jobs/nightly/run", 200, "nightly"), "s1")).toMatchObject({ sentence: "Ran job nightly", kind: "job" });
    expect(describeAgentAudit(entry("database.restore", "/v1/databases/shop/restore", 202, "shop backup=x target=shop overwrite=false"), "s1")).toMatchObject({ sentence: "Restored database shop", kind: "backup" });
  });
  it("names the app of a configuration change instead of its hash, and never prints the hash", () => {
    const line = describeAgentAudit(entry("app.save", "/v1/config/apps/web", 200, "hash 956148ee3463"), "s1", versions);
    expect(line.sentence).toBe("Saved app web");
    expect(line.target.note).toBe("apps file changed (version 12)");
    expect(JSON.stringify(line)).not.toContain("956148ee3463");
    expect(describeAgentAudit(entry("config.update", "/v1/config", 200, "hash abcdef123456"), "s1").sentence).toBe("Edited the configuration file");
    expect(describeAgentAudit(entry("config.restore", "/v1/config/versions/5/restore", 200, "hash abcdef123456"), "s1").sentence).toBe("Restored configuration version 5");
    expect(describeAgentAudit(entry("notifications.save", "/v1/config/notifications", 200, "hash abcdef123456"), "s1").sentence).toBe("Saved the notification settings");
  });
  it("names the project of a project file's change, links to its Configuration tab and never prints the hash", () => {
    const save = describeAgentAudit(entry("project.save", "/v1/projects/shop/config", 200, "shop hash 956148ee3463"), "s1", versions);
    expect(save.sentence).toBe("Saved the configuration file of project shop");
    expect(save.target).toMatchObject({ text: "shop", kind: "project", href: "/projects/shop/config#config-s1", note: "project file changed (version 12)" });
    expect(JSON.stringify(save)).not.toContain("956148ee3463");
    expect(describeAgentAudit(entry("project.split", "/v1/projects/shop/split", 200, "shop hash 956148ee3463"), "s1").sentence).toBe("Gave its own file to project shop");
    const removed = describeAgentAudit(entry("project.delete", "/v1/projects/shop/config", 409, "shop hash 956148ee3463"), "s1");
    expect(removed.sentence).toBe("Could not delete the configuration file of project shop");
    expect(removed.target.href).toBeUndefined();
  });
  it("says so when the agent refused or could not apply the request", () => {
    const refused = describeAgentAudit(entry("deploy", "/v1/apps/web/deploy", 409, "web"), "s1");
    expect(refused.sentence).toBe("Could not deploy web");
    expect(refused.outcome).toMatchObject({ ok: false, label: "Not applied", tone: "warning" });
    expect(describeAgentAudit(entry("job.run", "/v1/jobs/x/run", 404, "x"), "s1").outcome.label).toBe("Failed");
    expect(auditOutcome(401).label).toBe("Refused");
    expect(auditOutcome(400).label).toBe("Rejected");
    expect(auditOutcome(202)).toMatchObject({ ok: true, label: "OK" });
  });
  it("names an enrolment by its outcome, never by the code", () => {
    const line = describeAgentAudit(entry("enroll", "/v1/enroll", 200, "code a1b2 redeemed"), "s1");
    expect(line.sentence).toBe("Enrolled a dashboard with this agent");
    expect(line.kind).toBe("security");
    expect(line.target.note).toBe("redeemed");
  });
  it("prints an unknown code readably instead of raw, and still says when it failed", () => {
    expect(describeAgentAudit(entry("thing.explode", "/v1/x", 200), "s1")).toMatchObject({ label: "Thing explode", sentence: "Thing explode", known: false, tone: "warning" });
    expect(describeAgentAudit(entry("thing_explode", "/v1/x", 500), "s1").sentence).toBe("Thing explode (failed)");
  });
  it("reads either spelling of the container actions", () => {
    expect(describeAgentAudit(entry("container_start", "/v1/containers/web/start", 200, "web"), "s1")).toMatchObject({ known: true, label: "Container started" });
  });
});

describe("every action code the agent emits", () => {
  it("has a sentence for each, found by reading the agent's source", () => {
    const codes = new Set<string>();
    for (const m of agentSource("api/audit.go").matchAll(/"(?:GET|POST|PUT|DELETE|PATCH) [^"]+":\s+"([a-z._]+)"/g)) codes.add(m[1]);
    for (const m of agentSource("deploy/previews.go").matchAll(/(?:removeAudited\([^"\n]*|remove\(row, )"(preview\.[a-z]+)"/g)) codes.add(m[1]);
    for (const m of agentSource("api/enroll.go").matchAll(/Action:\s*"([a-z._]+)"/g)) codes.add(m[1]);
    // A guard against the scan silently finding nothing: these exist today.
    expect([...codes]).toEqual(expect.arrayContaining(["deploy", "rollback", "container.start", "job.run", "database.restore", "preview.evict", "enroll"]));
    expect(codes.size).toBeGreaterThanOrEqual(23);
    for (const code of codes) {
      expect(AGENT_ACTIONS, code).toHaveProperty([code]);
      const line = describeAgentAudit({ action: code, path: "/v1/config", status: 200 }, "s");
      expect(line.known, code).toBe(true);
      expect(line.label, code).not.toBe(code);
      expect(line.label + line.sentence, code).not.toMatch(/[._]/);
    }
    // And nothing the table lists is a code the agent no longer writes. The env.* codes belong to the agent API of managed
    // variables (PUT and DELETE /v1/apps/{app}/env): the table must read them from an agent that has it, and a checkout of
    // the dashboard alone may hold an older agent whose source does not name them yet.
    const managedVariables = new Set(["env.set", "env.unset", "env.delete"]);
    for (const code of Object.keys(AGENT_ACTIONS)) if (!code.includes("_") && !managedVariables.has(code)) expect(codes.has(code), code).toBe(true);
    for (const code of managedVariables) expect(describeAgentAudit({ action: code, path: "/v1/apps/shop/env", status: 200 }, "s").known, code).toBe(true);
  });
});

describe("every event code the dashboard records", () => {
  it("has a sentence for each, found by reading the dashboard's source", () => {
    const codes = new Set<string>(["container_start", "container_restart", "container_start_failed", "container_restart_failed"]);
    for (const text of sources(join(root, "app")).concat(sources(join(root, "lib")), sources(join(root, "components")))) {
      for (const m of text.matchAll(/\b(?:audit|record|deps\.audit)\(\s*"([a-z_]+)"/g)) codes.add(m[1]);
      for (const m of text.matchAll(/"(api_(?:deploy|build|rollback|job_run|denied))"/g)) codes.add(m[1]);
    }
    expect(codes.size).toBeGreaterThanOrEqual(40);
    expect([...codes]).toEqual(expect.arrayContaining(["login", "login_failed", "api_token_created", "api_deploy", "cloudflare_connected", "github_connected", "server_enrol"]));
    for (const code of codes) {
      expect(DASHBOARD_EVENTS, code).toHaveProperty([code]);
      const line = describeDashboardAudit({ event: code, detail: null });
      expect(line.known, code).toBe(true);
      expect(line.label, code).not.toMatch(/[._]/);
      expect(line.sentence, code).not.toMatch(/[a-z]+_[a-z]+/);
    }
    for (const code of Object.keys(DASHBOARD_EVENTS)) expect(codes.has(code), code).toBe(true);
  });
});

describe("describeDashboardAudit", () => {
  const d = (event: string, detail: string | null = null) => describeDashboardAudit({ event, detail });

  it("writes sign-ins and token changes as sentences, with their detail where it helps", () => {
    expect(d("login", "password+totp")).toMatchObject({ sentence: "Signed in (password + totp)", kind: "security", feed: true });
    expect(d("login_failed", "wrong password")).toMatchObject({ sentence: "A sign-in failed (wrong password)", tone: "danger" });
    expect(d("api_token_created", "ci (kv_abc…): deploy, all servers, expires 2027-01-01").sentence).toBe("Created API token ci (kv_abc…): deploy, all servers, expires 2027-01-01");
    expect(d("cloudflare_connected", "2 zone(s), token abc123").sentence).toBe("Connected Cloudflare (2 zone(s))");
  });
  it("keeps sign-outs and webhook deliveries out of the feed, and the accepted API calls the agent already shows", () => {
    expect(d("logout").feed).toBe(false);
    expect(d("webhook_delivery", "me/web@abc1234 (push): s/web deployed").feed).toBe(false);
    expect(d("container_start", "s: web").feed).toBe(false);
    const accepted = d("api_deploy", "server=prod app=web ref=v2 outcome=accepted deployment_id=d1");
    expect(accepted).toMatchObject({ accepted: true, feed: false, sentence: "Deployed web" });
    const refused = d("api_deploy", "server=prod app=web ref=v2 outcome=refused (409): busy");
    expect(refused).toMatchObject({ accepted: false, feed: true, tone: "danger", sentence: "Could not deploy web: refused (409): busy" });
    expect(d("api_build", "server=prod app=web ref=abc outcome=accepted deployment_id=d2")).toMatchObject({ accepted: true, sentence: "Started a build of web" });
    expect(d("api_build", "server=prod app=web outcome=refused: Link this app to its repository first (Source).")).toMatchObject({ accepted: false, tone: "danger", sentence: "Could not build web: refused: Link this app to its repository first (Source)." });
    expect(d("container_restart_failed", "s: web: boom")).toMatchObject({ feed: true, tone: "danger" });
  });
  it("makes an unknown code readable and never lists it", () => {
    expect(d("new_thing_happened", "x")).toMatchObject({ label: "New thing happened", sentence: "New thing happened: x", known: false, feed: false });
  });
});

describe("parseApiCall", () => {
  it("reads the app, ref and outcome, even when the server's name has spaces", () => {
    expect(parseApiCall("server=My prod app=web ref=v2 outcome=accepted deployment_id=9")).toEqual({ server: "My prod", subject: "web", ref: "v2", outcome: "accepted deployment_id=9", accepted: true });
    expect(parseApiCall("server=s job=nightly outcome=unreachable: cannot reach the agent")).toMatchObject({ subject: "nightly", accepted: false });
    expect(parseApiCall("garbage")).toBeNull();
  });
});

const versions = [{ id: 12, at: "t", hash: `956148ee3463${"0".repeat(52)}`, source: "api" }] as ConfigVersion[];

describe("auditTarget", () => {
  it("shows the app from the path for 'App saved' and turns the hash into a version link", () => {
    const t = auditTarget({ action: "app.save", path: "/v1/config/apps/web", detail: "hash 956148ee3463" }, "s1", versions);
    expect(t.text).toBe("web");
    expect(t.href).toBe("/servers/s1/apps/web");
    expect(t.note).toBe("apps file changed (version 12)");
    expect(t.versionHref).toBe("/servers/s1/config/versions#version-12");
    expect(JSON.stringify(t)).not.toContain("hash ");
  });
  it("falls back to the short hash when the version is not in the history", () => {
    const t = auditTarget({ action: "app.save", path: "/v1/config/apps/web", detail: "hash 956148ee3463" }, "s1", []);
    expect(t.note).toBe("apps file changed (version 956148ee3463)");
    expect(t.versionHref).toBeUndefined();
  });
  it("names the app of a deployment, the job of a run, the database of a restore", () => {
    expect(auditTarget({ action: "deploy", path: "/v1/apps/web/deploy", detail: "web" }, "s1")).toMatchObject({ text: "web", href: "/servers/s1/apps/web" });
    expect(auditTarget({ action: "job.run", path: "/v1/jobs/nightly/run", detail: "nightly" }, "s1")).toMatchObject({ text: "nightly", href: "/servers/s1/jobs/nightly" });
    expect(auditTarget({ action: "database.restore", path: "/v1/databases/shop/restore", detail: "shop backup=x" }, "s1")).toMatchObject({ text: "shop", note: "shop backup=x".replace("shop", "").trim() });
  });
  it("keeps what a build adds as a note and links containers", () => {
    expect(auditTarget({ action: "build", path: "/v1/apps/web/build", detail: "web sha=abc" }, "s1")).toMatchObject({ text: "web", note: "sha=abc" });
    expect(auditTarget({ action: "container.start", path: "/v1/containers/web-blue/start", detail: "web-blue" }, "s1")).toMatchObject({ text: "web-blue", href: "/servers/s1/containers/web-blue" });
  });
  it("does not link something that was deleted", () => {
    expect(auditTarget({ action: "app.delete", path: "/v1/config/apps/old", detail: "hash abcdef123456" }, "s1").href).toBeUndefined();
  });
  it("describes whole-file changes without a name", () => {
    expect(auditTarget({ action: "config.update", path: "/v1/config", detail: "hash abcdef123456" }, "s1")).toMatchObject({ text: "", note: "configuration file changed (version abcdef123456)" });
    expect(auditTarget({ action: "notifications.save", path: "/v1/config/notifications" }, "s1")).toMatchObject({ href: "/servers/s1/config/notifications" });
  });
});

describe("auditTarget, more", () => {
  it("names the agent's own removals", () => {
    expect(describeAgentAudit({ action: "preview.evict", path: "/v1/previews/shop/3", status: 200, detail: "shop-pr-3: evicted" }, "s1")).toMatchObject({ label: "Preview evicted", tone: "muted", sentence: "Evicted preview shop #3" });
    expect(describeAgentAudit({ action: "preview.expire", path: "/v1/previews/shop/3", status: 200 }, "s1")).toMatchObject({ label: "Preview expired", tone: "muted" });
  });
  it("describes a restore of a configuration version by the version it came from and the one it made", () => {
    const t = auditTarget({ action: "config.restore", path: "/v1/config/versions/5/restore", detail: "hash 956148ee3463" }, "s1", versions);
    expect(t).toMatchObject({ text: "version 5", note: "configuration file changed (version 12)", versionHref: "/servers/s1/config/versions#version-12" });
    expect(t.href).toBeUndefined();
  });
  it("reads the preview from the path and drops its name from the note", () => {
    expect(auditTarget({ action: "preview.deploy", path: "/v1/previews/shop/12", detail: "shop-pr-12 tag=x evicted=shop-pr-3" }, "s1")).toMatchObject({ text: "shop #12", note: "tag=x evicted=shop-pr-3" });
    expect(auditTarget({ action: "preview.expire", path: "/v1/previews/shop/12", detail: "shop-pr-12: expired 5m ago" }, "s1")).toMatchObject({ text: "shop #12", note: "expired 5m ago" });
    expect(auditTarget({ action: "preview.remove", path: "/v1/previews/shop/12", detail: "shop-pr-12" }, "s1").note).toBeUndefined();
  });
  it("links notifications and shows no code id for an enrolment", () => {
    expect(auditTarget({ action: "notifications.save", path: "/v1/config/notifications", detail: "hash abcdef123456" }, "s1")).toMatchObject({
      text: "notifications",
      href: "/servers/s1/config/notifications",
      note: "configuration file changed (version abcdef123456)",
    });
    expect(auditTarget({ action: "enroll", path: "/v1/enroll", detail: "code a1b2 redeemed" }, "s1")).toMatchObject({ text: "", note: "redeemed" });
  });
  it("reads names from job, database and preview-template paths", () => {
    expect(auditTarget({ action: "job.save", path: "/v1/config/jobs/nightly", detail: "hash abcdef123456" }, "s1").href).toBe("/servers/s1/jobs/nightly");
    expect(auditTarget({ action: "database.save", path: "/v1/config/databases/shop", detail: "hash abcdef123456" }, "s1").href).toBe("/servers/s1/databases/shop");
    expect(auditTarget({ action: "preview.save", path: "/v1/config/previews/shop", detail: "hash abcdef123456" }, "s1").text).toBe("shop");
  });
});

describe("dashboard audit words (shown in Activity)", () => {
  it("names an API call by the token that made it", () => {
    const line = describeDashboardAudit({ event: "api_deploy", detail: "server=prod app=shop outcome=accepted" });
    expect(line.label).toBe("Deploy by API token");
  });

  it("words the container actions and humanises a code nobody named", () => {
    expect(describeDashboardAudit({ event: "container_restart", detail: "prod: web" })).toMatchObject({ label: "Container restarted", sentence: "Restarted a container: prod: web" });
    expect(describeDashboardAudit({ event: "container_start_failed", detail: "prod: web" }).label).toBe("Container start failed");
    expect(describeDashboardAudit({ event: "dns_record_created", detail: "prod: web" }).label).toBe("DNS record created");
    expect(describeDashboardAudit({ event: "unheard_of_thing", detail: "prod: web" }).label).toBe("Unheard of thing");
  });
});

describe("the notification default's audit events", () => {
  it("has a sentence for each, with and without a detail", () => {
    expect(describeDashboardAudit({ event: "notifications_default_saved", detail: null })).toMatchObject({
      label: "Notification default saved",
      sentence: "Saved the default notification settings",
      known: true,
      kind: "change",
    });
    expect(describeDashboardAudit({ event: "notifications_default_saved", detail: "ignored" }).sentence).toBe("Saved the default notification settings");
    expect(describeDashboardAudit({ event: "notifications_default_applied", detail: null })).toMatchObject({
      label: "Notification default applied",
      tone: "warning",
      sentence: "Applied the default notification settings to servers",
      known: true,
      kind: "change",
    });
    expect(describeDashboardAudit({ event: "notifications_default_applied", detail: "2 applied, 1 conflict of 3" }).sentence).toBe("Applied the default notification settings: 2 applied, 1 conflict of 3");
  });

  it("links both to the notifications settings", () => {
    expect(dashboardAuditHref("notifications_default_applied")).toBe("/settings/notifications");
    expect(dashboardAuditHref("notifications_default_saved")).toBe("/settings/notifications");
  });
});
