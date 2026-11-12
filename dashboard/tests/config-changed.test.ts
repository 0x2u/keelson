import { describe, expect, it } from "vitest";
import type { ConfigVersion, ConfigVersionContent, Deployment } from "@/lib/agent-types";
import { findConfigChange, type ConfigHistorySource } from "@/lib/config-changed";

const file = (extra = "", domain = "web.example.com") => `apps:\n  - name: web\n    image: x/web\n    env:\n      A: <hidden>${extra}\n    domains:\n      - ${domain}\n`;

const v = (id: number, at: string, hash: string, source: ConfigVersion["source"] = "api"): ConfigVersion => ({ id, at, hash, source });
const versions = [v(3, "2026-10-20T12:00:00Z", "c"), v(2, "2026-10-20T09:00:00Z", "b"), v(1, "2026-10-19T09:00:00Z", "a", "startup")];
const deployments: Deployment[] = [{ id: "d1", app: "web", ref: "x/web:1", status: "succeeded", trigger: "api", started_at: "2026-10-20T10:00:00Z" }];

function source(contents: Record<number, string>, over: Partial<ConfigHistorySource> = {}): ConfigHistorySource {
  return {
    configVersions: async () => versions,
    configVersion: async (id) => ({ ...(versions.find((x) => x.id === id) as ConfigVersion), content: contents[id] }) as ConfigVersionContent,
    deployments: async () => deployments,
    ...over,
  };
}

describe("findConfigChange: the data behind the 'config changed since the running version' badge", () => {
  it("finds a change of the app's container configuration saved after the last successful deployment", async () => {
    const found = await findConfigChange(source({ 2: file(), 3: file("\n      B: x") }), "web");
    expect(found).toMatchObject({ deployedAt: "2026-10-20T10:00:00Z", now: { id: 3 }, then: { id: 2 } });
  });
  it("finds nothing when only the domains changed: they apply live", async () => {
    expect(await findConfigChange(source({ 2: file(), 3: file("", "b.example.com") }), "web")).toBeNull();
  });
  it("finds nothing when only another app changed", async () => {
    const other = (port: number) => `${file()}  - name: api\n    image: x/api\n    port: ${port}\n`;
    expect(await findConfigChange(source({ 2: other(1), 3: other(2) }), "web")).toBeNull();
  });
  it("counts a change that only differs by a hidden secret", async () => {
    expect(await findConfigChange(source({ 2: file(), 3: file() }), "web")).not.toBeNull();
  });
  it("finds nothing when no version was saved since the deployment, without reading any version's text", async () => {
    let reads = 0;
    const later = [{ ...deployments[0], started_at: "2026-10-20T13:00:00Z" }];
    const s = source({}, { deployments: async () => later, configVersion: async () => ((reads++, Promise.reject(new Error("no")))) });
    expect(await findConfigChange(s, "web")).toBeNull();
    expect(reads).toBe(0);
  });
  it("never throws: a failure to load anything means no badge", async () => {
    const boom = () => Promise.reject(new Error("agent down"));
    expect(await findConfigChange(source({}, { configVersions: boom }), "web")).toBeNull();
    expect(await findConfigChange(source({}, { deployments: boom }), "web")).toBeNull();
    expect(await findConfigChange(source({}, { configVersion: boom }), "web")).toBeNull();
  });
});
