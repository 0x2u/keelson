import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryOutcome } from "@/lib/github-webhook-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-build-starts-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { buildStarts, recordDelivery } = await import("@/lib/webhook-deliveries");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => db().exec("DELETE FROM webhook_deliveries"));

const SHA = (c: string) => c.repeat(40);

function record(deliveryId: string, sha: string, over: { app?: string; serverId?: string; outcome?: DeliveryOutcome; runKey?: string | null; at?: number } = {}): void {
  recordDelivery(
    {
      deliveryId,
      repo: "acme/shop",
      branch: "main",
      sha,
      serverId: over.serverId ?? "s1",
      app: over.app ?? "shop",
      outcome: over.outcome ?? "deployed",
      detail: "",
      deploymentId: "dep",
      runKey: over.runKey === undefined ? `acme/shop#push#${sha}` : over.runKey,
    },
    over.at ?? 1_000,
  );
}

describe("how the builds of an app were started", () => {
  it("tells a push from a build the dashboard started, by commit", () => {
    record("gh-delivery-1", SHA("a"));
    record("dashboard-build:1234", SHA("b"));
    expect(buildStarts("s1", "shop")).toEqual({ [SHA("a")]: "push", [SHA("b")]: "dashboard" });
  });

  it("lets the newest delivery of a commit decide", () => {
    record("gh-delivery-1", SHA("a"), { at: 1_000 });
    record("dashboard-build:1", SHA("a"), { at: 2_000 });
    expect(buildStarts("s1", "shop")[SHA("a")]).toBe("dashboard");
  });

  it("leaves out builds that did not start, deployments of a CI workflow run, previews, and other apps or servers", () => {
    record("d1", SHA("a"), { outcome: "failed" });
    record("d2", SHA("b"), { outcome: "skipped" });
    record("d3", SHA("c"), { runKey: `acme/shop#123#1` });
    record("d4", SHA("d"), { app: "shop-pr-7", runKey: `acme/shop#pr7#${SHA("d")}` });
    record("d5", SHA("e"), { app: "other" });
    record("d6", SHA("f"), { serverId: "s2" });
    expect(buildStarts("s1", "shop")).toEqual({});
  });
});
