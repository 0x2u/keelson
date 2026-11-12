import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/agent-types";
import { analysisErrors, analysisFromDraft, emptyMetric, metricDraft, unknownVariable, type MetricDraft } from "@/lib/analysis-config-core";

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {}, useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { AppForm, appFromDraft, draftFromApp } = await import("@/components/config/AppForm");

const metric = (over: Partial<MetricDraft> = {}): MetricDraft => ({ ...emptyMetric(), name: "error-rate", query: 'rate(errors{app="{{app}}"}[1m])', max: "0.02", ...over });

const GATED: AppConfig = {
  name: "shop",
  image: "ghcr.io/acme/shop",
  domains: ["shop.example.com"],
  port: 3000,
  soak: "1m",
  analysis: {
    address: "https://metrics.example.com/prometheus",
    metrics: [
      { name: "error-rate", query: 'rate(errors{app="{{app}}"}[1m])', max: 0.02, interval: "15s", failure_limit: 2, no_data: "fail" },
      { name: "success-rate", query: "slo:success", min: 0.99 },
    ],
  },
};

describe("the metric gates of an app form", () => {
  it("survive editing and saving the app unchanged", () => {
    expect(appFromDraft(draftFromApp(GATED))).toEqual(GATED);
  });

  it("send no analysis block when the last metric is removed, and no address alone", () => {
    const draft = draftFromApp(GATED);
    const saved = appFromDraft({ ...draft, metrics: [] });
    expect(saved.analysis).toBeUndefined();
    expect(analysisFromDraft("http://prometheus:9090", [])).toBeUndefined();
  });

  it("leave out what is blank, so that the agent's defaults apply", () => {
    expect(analysisFromDraft("", [metric()])).toEqual({ metrics: [{ name: "error-rate", query: 'rate(errors{app="{{app}}"}[1m])', max: 0.02 }] });
  });

  it("show the editor with the values the app has", () => {
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: GATED, existingNames: ["shop"], hasProxy: true }));
    expect(html).toContain("Metric gates");
    expect(html).toContain("error-rate");
    expect(html).toContain("https://metrics.example.com/prometheus");
    expect(html).toContain("success-rate");
  });

  it("offer to add a metric when there is none", () => {
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: { ...GATED, analysis: undefined }, existingNames: ["shop"], hasProxy: true }));
    expect(html).toContain("No metric gate");
    expect(html).toContain("Add metric");
  });

  it("keep a metric as typed when it is read back", () => {
    expect(metricDraft({ name: "m", query: "up", max: 0.5, failure_limit: 4 })).toEqual({ ...emptyMetric(), name: "m", query: "up", max: "0.5", failureLimit: "4" });
  });
});

describe("what the form says about a metric before the agent does", () => {
  it("accepts a metric with a name, a query and one bound", () => {
    expect(analysisErrors("", [metric()], "")).toEqual({});
  });

  it("asks for a bound, a name, a query, and numbers", () => {
    const e = analysisErrors("", [metric({ name: "a b", query: " ", max: "" }), metric({ name: "ok", max: "high", min: "x" })], "");
    expect(e["analysis.0.name"]).toMatch(/Letters, digits/);
    expect(e["analysis.0.query"]).toMatch(/Enter a PromQL query/);
    expect(e["analysis.0.max"]).toMatch(/without a bound/);
    expect(e["analysis.1.max"]).toMatch(/A number/);
    expect(e["analysis.1.min"]).toMatch(/A number/);
  });

  it("refuses a minimum above the maximum and a name used twice", () => {
    const e = analysisErrors("", [metric({ min: "1", max: "0.5" }), metric()], "");
    expect(e["analysis.0.min"]).toMatch(/above the maximum/);
    expect(e["analysis.1.name"]).toMatch(/Another metric is named error-rate/);
  });

  it("names a variable the agent would not replace", () => {
    expect(unknownVariable('up{job="{{apps}}"}')).toBe("{{apps}}");
    expect(unknownVariable('up{a="{{app}}",c="{{container}}",v="{{version}}"}')).toBeUndefined();
    expect(unknownVariable('up{job="{{app"}')).toBe("{{");
    expect(analysisErrors("", [metric({ query: "up{x=\"{{host}}\"}" })], "")["analysis.0.query"]).toMatch(/\{\{host\}\} is not a variable/);
  });

  it("refuses an address with credentials, a query string, or another scheme", () => {
    expect(analysisErrors("http://u:p@127.0.0.1:9090", [metric()], "")["analysis.address"]).toMatch(/no credentials/);
    expect(analysisErrors("http://127.0.0.1:9090/?x=1", [metric()], "")["analysis.address"]).toMatch(/without a query/);
    expect(analysisErrors("ftp://127.0.0.1", [metric()], "")["analysis.address"]).toMatch(/http or https/);
    expect(analysisErrors("not an address", [metric()], "")["analysis.address"]).toMatch(/http or https/);
    expect(analysisErrors("https://metrics.example.com/prometheus", [metric()], "")).toEqual({});
  });

  it("refuses an interval under a second and a limit out of range", () => {
    const e = analysisErrors("", [metric({ interval: "500ms", failureLimit: "0" }), metric({ name: "b", interval: "soon", failureLimit: "21" })], "5m");
    expect(e["analysis.0.interval"]).toBe("At least 1s.");
    expect(e["analysis.0.failure_limit"]).toMatch(/from 1 to 20/);
    expect(e["analysis.1.interval"]).toMatch(/number and a unit/);
    expect(e["analysis.1.failure_limit"]).toMatch(/from 1 to 20/);
  });

  it("says when the soak cannot hold enough evaluations for the metric to ever fail, and accepts the exact fit", () => {
    expect(analysisErrors("", [metric({ interval: "30s" })], "30s")["analysis.0.failure_limit"]).toMatch(/holds 1 evaluation at this interval/);
    expect(analysisErrors("", [metric()], "30s")).toEqual({}); // 30s / 10s = 3 evaluations, the default limit is 3
    expect(analysisErrors("", [metric({ failureLimit: "4" })], "")["analysis.0.failure_limit"]).toMatch(/holds 3 evaluations/); // a blank soak is 30s
  });

  it("asks for a soak, and says nothing when there is no metric", () => {
    expect(analysisErrors("", [metric()], "0s").analysis).toMatch(/more than 0s/);
    expect(analysisErrors("", [], "0s")).toEqual({});
  });

  it("allows five metrics and refuses a sixth", () => {
    const five = Array.from({ length: 5 }, (_, i) => metric({ name: `m${i}`, interval: "5s" }));
    expect(analysisErrors("", five, "1m")).toEqual({});
    expect(analysisErrors("", [...five, metric({ name: "m5" })], "1m").analysis).toMatch(/At most 5/);
  });
});
