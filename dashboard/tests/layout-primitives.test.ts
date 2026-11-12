import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DefinitionItem, DefinitionList, FOCUS_RING, FormCard, INLINE_LINK, InlineLink, PageSection, SegmentedNav, TABLE_INSET, TableCard } from "@/components/layout";

/** `createElement` without the component prop types: these tests pass partial and extra props on purpose. */
const h = createElement as unknown as (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("PageSection", () => {
  it("labels the section by its heading id when given one, by its title otherwise", () => {
    const withId = html(h(PageSection, { id: "jobs", title: "Jobs" }, "x"));
    expect(withId).toContain('aria-labelledby="jobs"');
    expect(withId).toContain('<h2 id="jobs"');
    const without = html(h(PageSection, { title: "Jobs" }, "x"));
    expect(without).toContain('aria-label="Jobs"');
    expect(without).not.toContain("aria-labelledby");
  });

  it("puts the action next to the heading", () => {
    const out = html(h(PageSection, { title: "Jobs", action: h("a", { href: "/jobs" }, "View all") }, "x"));
    expect(out.indexOf("Jobs</h2>")).toBeLessThan(out.indexOf("View all"));
  });
});

describe("DefinitionItem", () => {
  it("is a term and its value", () => {
    const out = html(h(DefinitionList, null, h(DefinitionItem, { label: "Image" }, "nginx:1")));
    expect(out).toContain("<dl");
    expect(out).toContain("<dt");
    expect(out).toContain("Image");
    expect(out).toContain("<dd");
    expect(out).toContain("nginx:1");
  });
});

describe("SegmentedNav", () => {
  const items = [
    { key: "production", label: "production", href: "/p?env=production", current: true },
    { key: "staging", label: "staging", href: "/p?env=staging", current: false },
  ];

  it("is a named navigation whose current item says so", () => {
    const out = html(h(SegmentedNav, { label: "Environment", items }));
    expect(out).toContain('aria-label="Environment"');
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/href="\/p\?env=production"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/p\?env=production"/);
  });

  it("uses the shared focus ring on its pills", () => {
    expect(html(h(SegmentedNav, { label: "App", items }))).toContain("focus-visible:ring-[3px]");
  });
});

describe("InlineLink", () => {
  it("is a link with the shared link style and focus ring", () => {
    const out = html(h(InlineLink, { href: "/servers" }, "Servers"));
    expect(out).toContain('href="/servers"');
    for (const token of INLINE_LINK.split(" ")) expect(out).toContain(token);
  });

  it("shares the one focus ring", () => {
    expect(FOCUS_RING).toContain("focus-visible:ring-[3px]");
    expect(FOCUS_RING).toContain("ring-ring/50");
  });
});

describe("TableCard", () => {
  it("has one geometry: no outer padding and the first and last cells inset", () => {
    const out = html(h(TableCard, { "data-testid": "t" }, "rows"));
    expect(out).toContain("gap-0");
    expect(out).toContain("py-0");
    expect(out).toContain('data-testid="t"');
    for (const token of TABLE_INSET.split(" ")) expect(out).toContain(token.replaceAll("&", "&amp;"));
  });

  it("has a header row only when it has a title or an action", () => {
    expect(html(h(TableCard, null, "rows"))).not.toContain("card-header");
    const titled = html(h(TableCard, { title: "Containers", action: h("a", null, "Open") }, "rows"));
    expect(titled).toContain("card-header");
    expect(titled).toContain("Containers");
    expect(titled).toContain("Open");
  });
});

describe("FormCard", () => {
  it("has the default card padding, a title, a description and a footer", () => {
    const out = html(h(FormCard, { title: "Connection", description: "How to reach it", footer: h("button", null, "Save") }, "fields"));
    expect(out).toContain("py-6");
    expect(out).toContain("Connection");
    expect(out).toContain("How to reach it");
    expect(out).toContain("card-footer");
    expect(out).toContain("Save");
  });

  it("has no footer without one", () => {
    expect(html(h(FormCard, { title: "Connection" }, "fields"))).not.toContain("card-footer");
  });
});
