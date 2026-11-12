import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, Notice } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { ICONS } from "@/lib/icons";

/** `createElement` without the component prop types: these tests pass partial and extra props on purpose. */
const h = createElement as unknown as (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("EmptyState", () => {
  it("says what is missing, what it is for, and offers the one next action", () => {
    const out = html(h(EmptyState, { icon: ICONS.job, title: "No jobs yet", action: h("a", { href: "/x" }, "Add job") }, "Jobs run on a schedule."));
    expect(out).toContain("No jobs yet");
    expect(out).toContain("Jobs run on a schedule.");
    expect(out).toContain("Add job");
    expect(out).toContain("<svg");
  });

  it("is unbordered by default, for use inside a card", () => {
    const out = html(h(EmptyState, { title: "No jobs yet" }));
    expect(out).not.toContain("border-dashed");
    expect(out).toContain("py-12");
  });

  it("is a dashed box when bordered, for standing alone on a page", () => {
    const out = html(h(EmptyState, { title: "No jobs yet", bordered: true }));
    expect(out).toContain("border-dashed");
    expect(out).toContain("rounded-xl");
  });

  it("is smaller when compact", () => {
    const out = html(h(EmptyState, { title: "No tokens yet", compact: true }));
    expect(out).toContain("py-6");
    expect(out).not.toContain("py-12");
  });
});

describe("Alert variants", () => {
  const variant = (v: "default" | "destructive" | "warning" | "info") => html(h(Alert, { variant: v }, "x"));

  it("colours every tone with its -text shade, which passes contrast on the card", () => {
    expect(variant("destructive")).toContain("text-destructive-text");
    expect(variant("warning")).toContain("text-warning-text");
    expect(variant("info")).toContain("text-info-text");
  });

  it("keeps the default neutral", () => {
    const out = variant("default");
    expect(out).not.toContain("text-warning-text");
    expect(out).not.toContain("text-info-text");
    expect(out).not.toContain("text-destructive-text");
  });
});

describe("Notice", () => {
  it("maps each tone to the Alert variant of the same colour", () => {
    expect(html(h(Notice, { tone: "danger" }, "x"))).toContain("text-destructive-text");
    expect(html(h(Notice, { tone: "warning" }, "x"))).toContain("text-warning-text");
    expect(html(h(Notice, { tone: "info" }, "x"))).toContain("text-info-text");
  });

  it("shows its title, its text and its action", () => {
    const out = html(h(Notice, { tone: "warning", title: "Read-only server", action: h("a", null, "Unlock") }, "You cannot deploy."));
    expect(out).toContain("Read-only server");
    expect(out).toContain("You cannot deploy.");
    expect(out).toContain("Unlock");
  });
});
