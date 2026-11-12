import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RelativeTime } from "@/components/relative-time";
import { ServerStatusBadge } from "@/components/status";
import { serverDot } from "@/lib/server-dot-core";
import {
  ACTION_OUTCOMES,
  BACKUP_STATES,
  CI_RUNS,
  COMMIT_DEPLOYMENTS,
  CONTAINER_HEALTH,
  CONTAINER_STATES,
  DELIVERY_OUTCOMES,
  DEPLOYMENTS,
  DOMAIN_CHECKS,
  ENVIRONMENTS,
  JOB_RUNS,
  JOB_STATES,
  PIPELINE_STEPS,
  PLACEMENTS,
  PREVIEWS,
  PROXY_STATES,
  READINESS,
  SERVER_STATES,
  containerStatus,
  deploymentStatus,
  serverStatus,
  type StatusView,
} from "@/lib/status";

const TONES = ["success", "warning", "danger", "info", "muted"];

const DOMAINS: Record<string, Record<string, StatusView>> = {
  DEPLOYMENTS,
  PIPELINE_STEPS,
  COMMIT_DEPLOYMENTS,
  JOB_RUNS,
  JOB_STATES,
  BACKUP_STATES,
  DELIVERY_OUTCOMES,
  PREVIEWS,
  CI_RUNS,
  DOMAIN_CHECKS,
  ACTION_OUTCOMES,
  CONTAINER_STATES,
  CONTAINER_HEALTH,
  PLACEMENTS,
  ENVIRONMENTS,
  SERVER_STATES,
  PROXY_STATES,
  READINESS,
};

describe("the status vocabulary", () => {
  for (const [name, map] of Object.entries(DOMAINS)) {
    it(`${name}: every state has a known tone and a capitalised label`, () => {
      expect(Object.keys(map).length).toBeGreaterThan(0);
      for (const [state, view] of Object.entries(map)) {
        expect(TONES, `${name}.${state}`).toContain(view.tone);
        expect(view.label, `${name}.${state}`).toMatch(/^[A-Z]/);
      }
    });
  }

  it("covers every state of the domains it types", () => {
    expect(Object.keys(JOB_STATES).sort()).toEqual(["failed", "never-run", "ok", "paused", "running"]);
    expect(Object.keys(BACKUP_STATES).sort()).toEqual(["failed", "first-pending", "never-scheduled", "not-configured", "ok", "overdue", "paused", "running"]);
    expect(Object.keys(DELIVERY_OUTCOMES).sort()).toEqual(["deployed", "failed", "pending", "skipped", "unknown"]);
    expect(Object.keys(COMMIT_DEPLOYMENTS).sort()).toEqual(["deployed", "deploying", "failed", "serving"]);
    expect(Object.keys(READINESS).sort()).toEqual(["critical", "na", "ok", "todo", "warning"]);
  });

  it("gives one word one tone across domains", () => {
    const seen = new Map<string, { tone: string; where: string }>();
    for (const [name, map] of Object.entries(DOMAINS)) {
      for (const [state, view] of Object.entries(map)) {
        // "Running" with a warning tone is the one deliberate variant: an environment that serves while its newest deployment failed.
        if (state === "runningLastFailed") continue;
        const earlier = seen.get(view.label);
        if (earlier) expect(view.tone, `"${view.label}" is ${earlier.tone} in ${earlier.where} but ${view.tone} in ${name}.${state}`).toBe(earlier.tone);
        else seen.set(view.label, { tone: view.tone, where: `${name}.${state}` });
      }
    }
  });

  it("never shows a raw docker string for a container, and says Healthy only where a health check exists", () => {
    for (const state of ["created", "paused", "restarting", "removing", "exited", "dead", "something-new"]) {
      expect(containerStatus(state).label).toMatch(/^[A-Z]/);
    }
    expect(containerStatus("exited")).toEqual({ tone: "danger", label: "Stopped" });
    expect(containerStatus("something-new").label).toBe("Something-new");
    expect(containerStatus("running").label).toBe("Running");
    expect(containerStatus("running", "healthy").label).toBe("Healthy");
    expect(containerStatus("running", "starting")).toMatchObject({ tone: "info", label: "Starting", live: true });
    expect(containerStatus("running", "unhealthy")).toMatchObject({ tone: "danger", label: "Unhealthy" });
  });

  it("says Starting the same everywhere", () => {
    expect(containerStatus("running", "starting")).toEqual(ENVIRONMENTS.starting);
  });
});

describe("deploymentStatus", () => {
  it("tells a roll back that worked from a deploy that did, in one place", () => {
    expect(deploymentStatus("succeeded")).toEqual({ tone: "success", label: "Succeeded" });
    expect(deploymentStatus("succeeded", "api")).toEqual({ tone: "success", label: "Succeeded" });
    expect(deploymentStatus("succeeded", "rollback")).toEqual({ tone: "success", label: "Rolled back" });
  });
  it("says which version a manual roll back went back to, where the image is known", () => {
    expect(deploymentStatus("succeeded", "rollback", "ghcr.io/acme/web:v1.4.2")).toEqual({ tone: "success", label: "Rolled back to v1.4.2" });
    expect(deploymentStatus("succeeded", "rollback", "ghcr.io/acme/web@sha256:0123456789abcdef0123")).toEqual({ tone: "success", label: "Rolled back to 0123456789ab" });
    expect(deploymentStatus("succeeded", "rollback", `ghcr.io/acme/web:${"a".repeat(40)}`).label).toBe(`Rolled back to ${"a".repeat(12)}`);
  });
  it("does not give the version to anything but a roll back that worked, and never confuses it with the automatic return", () => {
    expect(deploymentStatus("succeeded", "api", "web:v2")).toEqual({ tone: "success", label: "Succeeded" });
    expect(deploymentStatus("failed", "rollback", "web:v2")).toEqual({ tone: "danger", label: "Failed" });
    expect(deploymentStatus("rolled_back", "rollback", "web:v2")).toEqual({ tone: "warning", label: "Deploy rolled back" });
    expect(deploymentStatus("rolled_back", "api", "web:v2").label).not.toBe(deploymentStatus("succeeded", "rollback", "web:v2").label);
  });
  it("keeps the other statuses as they are whatever started them, and says Deploy rolled back for a deploy that was undone", () => {
    expect(deploymentStatus("failed", "rollback")).toEqual({ tone: "danger", label: "Failed" });
    expect(deploymentStatus("running", "rollback")).toMatchObject({ label: "Deploying", live: true });
    expect(deploymentStatus("rolled_back", "api")).toEqual({ tone: "warning", label: "Deploy rolled back" });
  });
});

describe("serverStatus", () => {
  const attention = { tone: "warning" as const, label: "2 things need attention", count: 2 };
  it("is Online only when nothing needs attention", () => {
    expect(serverStatus({ reachable: true })).toEqual(SERVER_STATES.online);
    expect(serverStatus({ reachable: true, attention: { tone: "success", label: "Everything is fine", count: 0 } })).toEqual(SERVER_STATES.online);
    expect(serverStatus({ reachable: true, attention })).toEqual({ tone: "warning", label: "2 things need attention" });
  });
  it("is Unreachable, or Offline for a machine that connects out", () => {
    expect(serverStatus({ reachable: false })).toEqual(SERVER_STATES.unreachable);
    expect(serverStatus({ reachable: false, machine: true, attention })).toEqual(SERVER_STATES.offline);
  });
  it("is the same in the sidebar dot", () => {
    expect(serverDot({ id: "s", reachable: true, ...attention })).toEqual({ tone: "warning", label: "2 things need attention" });
    expect(serverDot({ id: "s", reachable: true, tone: "success", label: "Everything is fine", count: 0 })).toEqual({ tone: "success", label: "Online" });
    expect(serverDot({ id: "s", reachable: false, tone: "danger", label: "x", count: 1 })).toEqual({ tone: "danger", label: "Unreachable" });
    expect(serverDot(undefined).tone).toBe("muted");
  });
});

describe("ServerStatusBadge", () => {
  const html = (props: Parameters<typeof ServerStatusBadge>[0]) => renderToStaticMarkup(createElement(ServerStatusBadge, props));
  it("says Online without attention items", () => {
    expect(html({ reachable: true, attention: { tone: "success", label: "Everything is fine", count: 0 } })).toContain("Online");
  });
  it("says the verdict with attention items, in its tone", () => {
    const out = html({ reachable: true, attention: { tone: "danger", label: "1 thing needs attention", count: 1 } });
    expect(out).toContain("1 thing needs attention");
    expect(out).not.toContain("Online");
    expect(out).toContain("bg-destructive");
  });
  it("says Unreachable or Offline when it does not answer", () => {
    expect(html({ reachable: false })).toContain("Unreachable");
    expect(html({ reachable: false, machine: true })).toContain("Offline");
  });
});

describe("RelativeTime", () => {
  it("takes an ISO string, epoch milliseconds or a Date, and is focusable for its absolute time", () => {
    const iso = "2026-10-23T11:00:00Z";
    for (const at of [iso, Date.parse(iso), new Date(iso)]) {
      const out = renderToStaticMarkup(createElement(RelativeTime, { at }));
      expect(out).toContain('dateTime="2026-10-23T11:00:00');
      expect(out).toContain('tabindex="0"');
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("grep gate", () => {
  const root = join(__dirname, "..");
  const files = [...sourceFiles(join(root, "components")), ...sourceFiles(join(root, "app"))];

  it("has no inline status literal passed to StatusBadge: states are looked up in lib/status", () => {
    const offenders = files.filter((f) => /StatusBadge\s+view=\{\{/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("wraps no timestamp in new Date(...).toISOString() for RelativeTime", () => {
    const offenders = files.filter((f) => /<RelativeTime[^>]*new Date\([^)]*\)\.toISOString\(\)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
