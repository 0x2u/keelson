import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentEvent, DeploymentPhase, PhaseName } from "@/lib/agent-types";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));

const { DeploymentPipeline } = await import("@/components/deployments/DeploymentPipeline");
const { PipelineLine } = await import("@/components/deployments/PipelineLine");
const { LogLines } = await import("@/components/DeploymentLog");

const T0 = Date.parse("2026-11-02T10:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const phase = (name: PhaseName, status: DeploymentPhase["status"], start: number, end?: number): DeploymentPhase => ({
  name,
  status,
  started_at: at(start),
  ...(end === undefined ? {} : { finished_at: at(end) }),
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const failed = { status: "failed" as const, trigger: "api", started_at: at(0), finished_at: at(70), phases: [phase("release", "done", 0, 4), phase("switch", "failed", 4, 70)] };

describe("DeploymentPipeline", () => {
  const html = renderToStaticMarkup(createElement(DeploymentPipeline, { deployment: failed }));

  it("is an ordered list of the steps in pipeline order, each with its state in words and its time", () => {
    expect(html).toContain("<ol");
    expect(text(html)).toMatch(/Release Succeeded · 4 s.*Switch Failed · 1 min 6 s.*Soak Not reached.*Live Not reached/);
    expect(text(html)).toContain("Took 1 min 10 s");
  });

  it("marks the failing step, so it is not told by colour alone", () => {
    expect(html).toMatch(/<li[^>]*data-step="switch"[^>]*data-state="failed"/);
    expect(html).toContain("border-destructive");
    expect(html).not.toMatch(/data-step="release"[^>]*aria-current/);
  });

  it("draws nothing for an agent that does not report phases", () => {
    expect(renderToStaticMarkup(createElement(DeploymentPipeline, { deployment: { ...failed, phases: undefined } }))).toBe("");
  });

  it("marks the step in progress as the current one, and gives no clock before it is on screen", () => {
    const running = renderToStaticMarkup(createElement(DeploymentPipeline, { deployment: { status: "running", trigger: "api", started_at: at(0), phases: [phase("release", "running", 0)] } }));
    expect(running).toMatch(/<li[^>]*aria-current="step"[^>]*data-step="release"|<li[^>]*data-step="release"[^>]*aria-current="step"/);
    expect(text(running)).toContain("In progress");
    expect(text(running)).not.toContain("Running for");
  });

  it("says Source and Build ran on another server for a deployment of a transferred image", () => {
    const sent = renderToStaticMarkup(createElement(DeploymentPipeline, { deployment: { status: "succeeded", trigger: "transfer", started_at: at(0), finished_at: at(9), phases: [phase("release", "done", 0, 3), phase("switch", "done", 3, 9)] } }));
    expect(text(sent)).toMatch(/Source Built on another server.*Build Built on another server.*Release Succeeded/);
  });
});

describe("PipelineLine", () => {
  it("is one line of steps, each with its state for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(PipelineLine, { deployment: failed }));
    expect(html).toContain('aria-label="Pipeline"');
    expect(text(html)).toMatch(/Release Succeeded Switch Failed Soak Not reached Live Not reached/);
  });
  it("is nothing without phases", () => {
    expect(renderToStaticMarkup(createElement(PipelineLine, { deployment: { status: "failed", trigger: "api" } }))).toBe("");
  });
});

describe("LogLines", () => {
  const line = (seq: number, phase: PhaseName | undefined, message: string, level: DeploymentEvent["level"] = "info"): DeploymentEvent => ({ seq, time: at(seq), level, message, ...(phase ? { phase } : {}) });
  const render = (steps: DeploymentEvent[], over: Partial<Parameters<typeof LogLines>[0]> = {}) =>
    renderToStaticMarkup(createElement(LogLines, { steps, deployment: failed, live: null, toggled: {}, onToggle: () => {}, empty: "Waiting for events…", ...over }));

  const events = [line(1, "release", "pulling image"), line(2, "release", "image ready"), line(3, "switch", "starting container"), line(4, "switch", "health check failed", "error"), line(5, undefined, "recorded")];

  it("groups the lines by phase with a count each, the failed phase open and the others closed", () => {
    const html = render(events);
    expect(text(html)).toMatch(/Release 2 lines.*Switch Failed 2 lines.*Other 1 line/);
    expect(html).toMatch(/data-state="closed"[^>]*data-phase="release"/);
    expect(html).toMatch(/data-state="open"[^>]*data-phase="switch"/);
    expect(html).toContain("health check failed");
    expect(html).not.toContain("pulling image");
  });

  it("opens a section the reader opened and closes one that follows the phase", () => {
    const html = render(events, { toggled: { release: true, switch: false } });
    expect(html).toContain("pulling image");
    expect(html).not.toContain("health check failed");
  });

  it("renders the old flat log exactly when no line says its phase", () => {
    const html = render([line(1, undefined, "pulling image"), line(2, undefined, "started")]);
    expect(html).not.toContain("data-phase");
    expect(html).not.toContain("lines</span>");
    expect(text(html)).toContain("pulling image");
    expect(text(html)).toContain("started");
  });

  it("says it is waiting when there are no lines", () => {
    expect(text(render([]))).toBe(" Waiting for events… ");
  });
});
