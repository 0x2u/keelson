import { describe, expect, it } from "vitest";
import { ACTION_TOAST_MS, deploymentToast, jobRunHref, jobRunToast, restoreToast } from "@/lib/toast-core";

describe("toasts that answer", () => {
  it("a deployment names the versions and links to its log for long enough to click", () => {
    const t = deploymentToast("deploy", { serverId: "s1", deploymentId: "d9", app: "web", from: "v2", to: "v3" });
    expect(t.title).toBe("Deploying web");
    expect(t.description).toBe("v2 → v3");
    expect(t.action).toEqual({ label: "View log", href: "/servers/s1/deployments/d9" });
    expect(t.duration).toBe(ACTION_TOAST_MS);
    expect(t.duration).toBeGreaterThanOrEqual(10_000);
  });
  it("a roll back and a promotion say what they are, with the verbs of the buttons", () => {
    expect(deploymentToast("rollback", { serverId: "s", deploymentId: "d", app: "a", from: "v3", to: "v2" }).title).toBe("Rolling back a");
    const p = deploymentToast("promotion", { serverId: "s", deploymentId: "d", app: "a", to: "cccccccccccc" });
    expect(p.title).toBe("Promoting a");
    expect(p.description).toBe("cccccccccccc");
  });
  it("Run now stays until dismissed and links to the run's output", () => {
    const t = jobRunToast({ serverId: "s1", job: "nightly backup", runId: "r7" });
    expect(t.duration).toBe(Infinity);
    expect(t.action.href).toBe(jobRunHref("s1", "nightly backup", "r7"));
    expect(t.action.href).toBe("/servers/s1/jobs/nightly%20backup?run=r7#run-r7");
    expect(t.action.label).toBe("View output");
  });
  it("without a run id the link goes to the job's runs, and Backup now keeps its label", () => {
    const t = jobRunToast({ serverId: "s1", job: "bk", label: "Backup" });
    expect(t.title).toBe("Backup started");
    expect(t.action).toEqual({ label: "View runs", href: "/servers/s1/jobs/bk" });
  });
  it("Backup now of a database opens the run on the database's page, the same anchor", () => {
    const t = jobRunToast({ serverId: "s1", job: "backup-shop", runId: "r2", label: "Backup", database: "shop" });
    expect(t.action.href).toBe("/servers/s1/databases/shop?run=r2#run-r2");
    expect(t.duration).toBe(Infinity);
    expect(jobRunToast({ serverId: "s1", job: "backup-shop", database: "shop" }).action).toEqual({ label: "View runs", href: "/servers/s1/databases/shop" });
  });
  it("a restore links to the run on the database page and stays", () => {
    const t = restoreToast({ serverId: "s1", database: "shop", runId: "r1" });
    expect(t.duration).toBe(Infinity);
    expect(t.action.href).toBe("/servers/s1/databases/shop?run=r1#run-r1");
  });
});
