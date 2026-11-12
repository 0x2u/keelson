import { describe, expect, it } from "vitest";
import type { Container } from "@/lib/agent-types";
import { appOfContainer, containerControls } from "@/lib/container-core";

const up = { running: true };
const down = { running: false };

describe("containerControls", () => {
  it("offers Start on a stopped managed container and Restart on a running one", () => {
    expect(containerControls(down, { managed: true, canDeploy: true })).toEqual({ start: true, restart: false });
    expect(containerControls(up, { managed: true, canDeploy: true })).toEqual({ start: false, restart: true });
    expect(containerControls({ running: false, restarting: true }, { managed: true, canDeploy: true })).toEqual({ start: false, restart: true });
  });
  it("offers nothing, with the reason, for a container Keelson does not manage, without the deploy secret, or paused", () => {
    expect(containerControls(down, { managed: false, canDeploy: true })).toMatchObject({ start: false, restart: false, reason: expect.stringContaining("does not manage") });
    expect(containerControls(down, { managed: true, canDeploy: false })).toMatchObject({ start: false, restart: false, reason: expect.stringContaining("deploy secret") });
    expect(containerControls({ running: true, paused: true }, { managed: true, canDeploy: true }).reason).toMatch(/paused/);
  });
});

describe("containerControls during a deployment", () => {
  it("offers nothing, with the reason, while a deployment is replacing the container", () => {
    expect(containerControls(up, { managed: true, canDeploy: true, deploying: true })).toMatchObject({ start: false, restart: false, reason: expect.stringContaining("deployment is running") });
  });
});

describe("appOfContainer", () => {
  const c = (name: string, labels: Record<string, string>) => ({ name, labels }) as Container;
  it("reads the app from the keelson.app label", () => {
    expect(appOfContainer([c("web", { "keelson.app": "web" }), c("db", {})], "web")).toBe("web");
    expect(appOfContainer([c("db", {})], "db")).toBeUndefined();
    expect(appOfContainer(undefined, "db")).toBeUndefined();
  });
});
