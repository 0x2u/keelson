import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { confirmEnabled } from "@/lib/confirm-core";
import { gateOf, isStepUpError, READ_ONLY_REASON } from "@/lib/gate-core";
import { STEP_UP_MESSAGE } from "@/lib/step-up-core";
import { toastCopy } from "@/lib/toast-core";

// Radix dialog parts need a mounted portal; the body is what is under test.
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: h } = await import("react");
  const part = (tag: string) => (p: Record<string, unknown>) => h(tag, p);
  return {
    AlertDialog: part("div"),
    AlertDialogContent: part("div"),
    AlertDialogHeader: part("div"),
    AlertDialogFooter: part("div"),
    AlertDialogTitle: part("h2"),
    AlertDialogDescription: part("p"),
    AlertDialogCancel: part("button"),
    AlertDialogTrigger: part("button"),
  };
});
vi.mock("@/app/step-up-actions", () => ({ unlockAction: async () => ({}), unlockStatusAction: async () => ({ until: null }) }));

const { Button } = await import("@/components/ui/button");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { GatedButton } = await import("@/components/GatedButton");
const { ConfirmBody } = await import("@/components/ConfirmDialog");
const { StepUpAction } = await import("@/components/unlock");
const { PlayIcon } = await import("lucide-react");

/** The disabled attribute (not the `disabled:` utility classes). */
const DISABLED = /<button[^>]* disabled(=""| )/;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

describe("Button loading", () => {
  it("swaps the leading icon for the spinner, is busy and disabled", () => {
    const out = html(createElement(Button, { loading: true }, createElement(PlayIcon), "Start"));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("disabled");
    expect(out).toContain("animate-spin");
    expect(out).not.toContain("lucide-play");
    expect(out).toContain("Start");
  });
  it("puts the spinner in front of a label without an icon", () => {
    const out = html(createElement(Button, { loading: true }, "Save"));
    expect(out.indexOf("animate-spin")).toBeLessThan(out.indexOf("Save"));
  });
  it("is plain when not loading", () => {
    const out = html(createElement(Button, null, createElement(PlayIcon), "Start"));
    expect(out).not.toContain("aria-busy");
    expect(out).not.toContain("animate-spin");
    expect(out).toContain("lucide-play");
  });
});

describe("gate", () => {
  it("covers the matrix", () => {
    expect(gateOf({ canDeploy: false })).toEqual({ state: "read-only", reason: "Read-only server" });
    expect(gateOf({ canDeploy: false, stepUp: true }).state).toBe("read-only");
    expect(gateOf({ canDeploy: true, stepUp: true }).state).toBe("locked");
    expect(gateOf({ canDeploy: true, stepUp: true }).reason).not.toBeNull();
    expect(gateOf({ canDeploy: true })).toEqual({ state: "allowed", reason: null });
  });
  it("recognises the step-up refusal", () => {
    expect(isStepUpError(`The app's image decides what runs on the server. ${STEP_UP_MESSAGE}`)).toBe(true);
    expect(isStepUpError("Nope")).toBe(false);
    expect(isStepUpError(undefined)).toBe(false);
  });
  it("GatedButton: read-only is disabled behind a focusable reason, others are enabled", () => {
    const ro = html(createElement(GatedButton, { canDeploy: false }, "Edit"));
    expect(ro).toContain('tabindex="0"');
    expect(ro).toMatch(DISABLED);
    expect(ro).toContain('data-gate="read-only"');
    expect(READ_ONLY_REASON).toBe("Read-only server");
    const ok = html(createElement(GatedButton, { canDeploy: true }, "Edit"));
    expect(ok).not.toMatch(DISABLED);
    expect(ok).toContain('data-gate="allowed"');
    const locked = html(createElement(GatedButton, { canDeploy: true, stepUp: true }, "Edit"));
    expect(locked).not.toMatch(DISABLED);
    expect(locked).toContain('data-gate="locked"');
  });
  it("offers Unlock beside a step-up error only", () => {
    expect(html(createElement(StepUpAction, { error: STEP_UP_MESSAGE }))).toContain("Unlock");
    expect(html(createElement(StepUpAction, { error: "Other" }))).toBe("");
  });
});

describe("ConfirmDialog", () => {
  it("typed name enables the confirm button only on an exact match", () => {
    expect(confirmEnabled({ typed: "", required: "web" })).toBe(false);
    expect(confirmEnabled({ typed: "we", required: "web" })).toBe(false);
    expect(confirmEnabled({ typed: "web", required: "web" })).toBe(true);
    expect(confirmEnabled({ typed: "", required: undefined })).toBe(true);
    expect(confirmEnabled({ typed: "web", required: "web", pending: true })).toBe(false);
  });
  const base = { title: "Remove web?", description: "Gone.", confirmLabel: "Remove", onConfirm: () => {}, pending: false };
  const render = (props: Record<string, unknown>) => html(createElement(ConfirmBody, props as typeof base));
  it("renders a typed-name field, a disabled destructive confirm and an error", () => {
    const out = render({ ...base, destructive: true, typeToConfirm: "web", error: "Boom" });
    expect(out).toContain("Remove web?");
    expect(out).toContain("to confirm");
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('role="alert"');
    expect(out).toMatch(/<button[^>]*data-variant="destructive"[^>]* disabled=""[^>]*>Remove<\/button>/);
  });
  it("is busy while pending and cannot be cancelled", () => {
    const out = render({ ...base, pending: true });
    expect(out).toContain('aria-busy="true"');
    expect(out).toMatch(/<button[^>]* disabled=""[^>]*>Cancel<\/button>/);
  });
  it("has no typed field without a name", () => {
    expect(render(base)).not.toContain("to confirm");
  });
});

describe("toastCopy", () => {
  it("is one template without trailing periods", () => {
    expect(toastCopy.saved("web")).toBe("Saved web");
    expect(toastCopy.removed("server prod.")).toBe("Removed server prod");
    expect(toastCopy.failed("saved", "web")).toBe("Could not save web");
    expect(toastCopy.done("restored", " db ")).toBe("Restored db");
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(f) ? [p] : [];
  });
}

describe("one confirmation and one gating pattern", () => {
  const files = [...walk("components"), ...walk("app")];
  it("has no window.confirm", () => {
    expect(files.filter((f) => readFileSync(f, "utf8").includes("window.confirm"))).toEqual([]);
  });
  it("never says 'Needs the deploy secret'", () => {
    expect(files.filter((f) => readFileSync(f, "utf8").includes("Needs the deploy secret"))).toEqual([]);
  });
});
