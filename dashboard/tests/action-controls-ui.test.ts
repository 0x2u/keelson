import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Deployment } from "@/lib/agent-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }), usePathname: () => "/servers/s/apps/web" }));
vi.mock("@/app/container-actions", () => ({ containerAction: async () => ({}) }));
vi.mock("@/app/actions", () => ({ deployAction: async () => ({}), rollbackAction: async () => ({}) }));
vi.mock("@/app/github-actions", () => ({ buildAction: async () => ({}) }));
vi.mock("@/app/projects-actions", () => ({ promoteAction: async () => ({}) }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ImageRef, VersionTag } = await import("@/components/image-ref");
const { ContainerControls } = await import("@/components/ContainerControls");
const { DeployControls } = await import("@/components/DeployControls");
const { PromoteButton } = await import("@/components/projects/PromoteButton");

const D = "ab".repeat(32);
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
/** The opening tag of the button whose text ends with `label`, or undefined. */
const buttonOf = (out: string, label: string): string | undefined => out.split("<button").map((b) => `<button${b}`).find((b) => new RegExp(`${label}</button>`).test(b))?.split(">")[0];

describe("ImageRef", () => {
  it("cuts a long repository in the middle but always shows the tag as a chip, with a copy button", () => {
    const out = html(createElement(ImageRef, { value: "registry.example.com/team/platform/services/checkout-api:v1.4.2" }));
    expect(out).toContain("…");
    expect(out).toContain("checkout-api");
    expect(out).toContain(">v1.4.2<");
    expect(out).toContain("Copy image reference");
  });
  it("shows the short digest when there is no tag, and marks the serving version", () => {
    const out = html(createElement(ImageRef, { value: `ghcr.io/me/web@sha256:${D}`, serving: true }));
    expect(out).toContain("@abababababab");
    expect(out).not.toContain(D);
    expect(out).toContain("serving");
  });
  it("VersionTag is the chip alone, with the whole reference as its title", () => {
    const out = html(createElement(VersionTag, { image: "ghcr.io/me/web:v3" }));
    expect(out).toContain('title="ghcr.io/me/web:v3"');
    expect(out).toContain(">v3<");
    expect(out).not.toContain("ghcr.io/me/web</span>");
  });
});

describe("ContainerControls", () => {
  const base = { serverId: "s", name: "web", managed: true, canDeploy: true };
  it("offers Start on an exited managed container", () => {
    const out = html(createElement(ContainerControls, { ...base, state: { running: false } }));
    expect(out).toContain("Start");
    expect(out).not.toContain("Restart");
  });
  it("offers Restart on a running one", () => {
    const out = html(createElement(ContainerControls, { ...base, state: { running: true } }));
    expect(out).toContain("Restart");
    expect(out).not.toContain(">Start<");
  });
  it("shows a disabled Restart (with the reason on hover) without the deploy secret, and nothing for an unmanaged container", () => {
    const readOnly = html(createElement(ContainerControls, { ...base, canDeploy: false, state: { running: true } }));
    expect(readOnly).toContain('disabled=""');
    expect(readOnly).toContain('data-gate="read-only"');
    expect(html(createElement(ContainerControls, { ...base, managed: false, state: { running: true } }))).toBe("");
  });
});

const dep = (ref: string, at: string): Deployment => ({ id: ref, app: "web", ref, status: "succeeded", trigger: "api", started_at: at });

describe("DeployControls", () => {
  const base = { serverId: "s", app: "web", canDeploy: true, running: false, current: "r/web:v2", source: null };
  it("offers Roll back and Deploy when an earlier version exists", () => {
    const out = html(createElement(DeployControls, { ...base, history: [dep("r/web:v2", "2026-10-23T10:00:00Z"), dep("r/web:v1", "2026-10-22T10:00:00Z")], neverDeployed: false }));
    expect(out).toContain("Roll back");
    expect(out).toContain("Deploy");
    expect(buttonOf(out, "Roll back")).not.toContain('disabled=""');
  });
  it("hides Roll back for an app that was never deployed", () => {
    const out = html(createElement(DeployControls, { ...base, current: "", history: [], neverDeployed: true }));
    expect(out).not.toContain("Roll back");
    expect(out).toContain("Deploy");
  });
  it("disables Roll back when there is no other version, but still lets Deploy through", () => {
    const out = html(createElement(DeployControls, { ...base, history: [dep("r/web:v2", "2026-10-22T10:00:00Z")], neverDeployed: false }));
    expect(buttonOf(out, "Roll back")).toContain('disabled=""');
    expect(buttonOf(out, "Deploy")).not.toContain('disabled=""');
  });
  it("does not block when the history could not be loaded", () => {
    const out = html(createElement(DeployControls, { ...base, history: null, neverDeployed: false }));
    expect(out).not.toContain('disabled=""');
  });
  it("gates both buttons as a read-only server, and off while a deployment runs", () => {
    const history = [dep("r/web:v2", "2026-10-23T10:00:00Z"), dep("r/web:v1", "2026-10-22T10:00:00Z")];
    const readOnly = html(createElement(DeployControls, { ...base, canDeploy: false, history, neverDeployed: false }));
    expect(buttonOf(readOnly, "Roll back")).toContain('data-gate="read-only"');
    expect(buttonOf(readOnly, "Deploy")).toContain('data-gate="read-only"');
    expect(buttonOf(readOnly, "Deploy")).toContain('disabled=""');
    const running = html(createElement(DeployControls, { ...base, running: true, history, neverDeployed: false }));
    expect(buttonOf(running, "Deploy")).toContain('disabled=""');
    expect(running).not.toContain("Needs the deploy secret");
  });
});

describe("PromoteButton", () => {
  const view = { intoProduction: true, from: "v4", to: "v3", digest: "abababababab", same: false };
  const props = { input: { fromServer: "a", fromApp: "web-staging", toServer: "b", toApp: "web", expectedDigest: D }, fromLabel: "staging", toLabel: "production", toServer: "prod", toApp: "web", view, blocked: null };
  it("renders the trigger, and the reason instead when the promotion is blocked", () => {
    expect(html(createElement(PromoteButton, props))).toContain("Promote staging");
    expect(html(createElement(PromoteButton, { ...props, blocked: "Nothing is running in staging to promote." }))).toContain("Nothing is running in staging");
  });
});
