import { describe, expect, it } from "vitest";
import type { AppStatus, Deployment } from "@/lib/agent-types";
import { appVersion, neverDeployed } from "@/lib/app-version-core";

const dep = (ref: string, status: Deployment["status"], at: string): Deployment => ({ id: ref + at, app: "web", ref, status, trigger: "api", started_at: at });
const container = { image: "r/web:v3", state: { running: true } } as AppStatus["container"];
const stopped = { image: "r/web:v3", state: { running: false, finished_at: "2026-10-23T09:00:00Z" } } as AppStatus["container"];

describe("appVersion", () => {
  it("is the serving image when a container exists", () => {
    expect(appVersion({ container, last_deployment: null }, [])).toEqual({ kind: "serving", ref: "r/web:v3" });
  });
  it("without a container names the last successful deployment as last known, not as serving", () => {
    const history = [dep("r/web:v5", "failed", "2026-10-23T10:00:00Z"), dep("r/web:v4", "succeeded", "2026-10-22T10:00:00Z"), dep("r/web:v3", "succeeded", "2026-10-21T10:00:00Z")];
    expect(appVersion({ container: null, last_deployment: history[0] }, history)).toEqual({ kind: "last-known", ref: "r/web:v4", at: "2026-10-22T10:00:00Z", stopped: false });
  });
  it("falls back on the app's last deployment when the history could not be loaded", () => {
    expect(appVersion({ container: null, last_deployment: dep("r/web:v4", "succeeded", "2026-10-22T10:00:00Z") }, null)).toMatchObject({ kind: "last-known", ref: "r/web:v4", stopped: false });
  });
  it("does not call an exited container serving: it is the last known version, stopped", () => {
    expect(appVersion({ container: stopped, last_deployment: null }, [])).toEqual({ kind: "last-known", ref: "r/web:v3", at: "2026-10-23T09:00:00Z", stopped: true });
  });
  it("is never when nothing succeeded", () => {
    expect(appVersion({ container: null, last_deployment: dep("r/web:v4", "failed", "2026-10-22T10:00:00Z") }, null)).toEqual({ kind: "never" });
  });
});

describe("neverDeployed", () => {
  it("is true only without container, last deployment and history", () => {
    expect(neverDeployed({ container: null, last_deployment: null }, [])).toBe(true);
    expect(neverDeployed({ container: null, last_deployment: null }, null)).toBe(true);
    expect(neverDeployed({ container: null, last_deployment: dep("a", "failed", "t") }, [])).toBe(false);
    expect(neverDeployed({ container, last_deployment: null }, [])).toBe(false);
    expect(neverDeployed({ container: null, last_deployment: null }, [dep("a", "succeeded", "t")])).toBe(false);
  });
});
