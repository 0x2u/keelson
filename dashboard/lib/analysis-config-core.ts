import type { AnalysisConfig, MetricGateConfig } from "@/lib/agent-types";
import { parseDurationSeconds } from "@/lib/build-elsewhere-core";

/** The agent's limits on an app's metric gates (agent/internal/config/analysis.go). */
export const MAX_METRICS = 5;
export const MAX_FAILURE_LIMIT = 20;
export const DEFAULT_INTERVAL_SECONDS = 10;
export const DEFAULT_FAILURE_LIMIT = 3;
export const DEFAULT_SOAK_SECONDS = 30;
export const DEFAULT_PROMETHEUS = "http://127.0.0.1:9090";
export const QUERY_VARIABLES = ["app", "container", "version"] as const;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** One metric as the text fields of the form hold it: nothing here is parsed until the app is built from the draft. */
export interface MetricDraft {
  name: string;
  query: string;
  max: string;
  min: string;
  interval: string;
  failureLimit: string;
  /** "" keeps the agent's default (pass). */
  noData: "" | "pass" | "fail";
}

export function emptyMetric(): MetricDraft {
  return { name: "", query: "", max: "", min: "", interval: "", failureLimit: "", noData: "" };
}

function numberText(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

export function metricDraft(m: MetricGateConfig): MetricDraft {
  return {
    name: m.name,
    query: m.query,
    max: numberText(m.max),
    min: numberText(m.min),
    interval: m.interval ?? "",
    failureLimit: numberText(m.failure_limit),
    noData: m.no_data ?? "",
  };
}

/** A decimal number as typed (0.02, -1, 1e-3); undefined when the text is empty or is not one. */
export function toNumber(text: string): number | undefined {
  const t = text.trim();
  if (t === "" || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function metricConfig(d: MetricDraft): MetricGateConfig {
  const m: MetricGateConfig = { name: d.name.trim(), query: d.query.trim() };
  const max = toNumber(d.max);
  if (max !== undefined) m.max = max;
  const min = toNumber(d.min);
  if (min !== undefined) m.min = min;
  if (d.interval.trim() !== "") m.interval = d.interval.trim();
  if (/^\d+$/.test(d.failureLimit.trim())) m.failure_limit = Number(d.failureLimit.trim());
  if (d.noData !== "") m.no_data = d.noData;
  return m;
}

/** The `analysis` block to send: absent when there is no metric (an address alone judges nothing). */
export function analysisFromDraft(address: string, metrics: MetricDraft[]): AnalysisConfig | undefined {
  if (metrics.length === 0) return undefined;
  const out: AnalysisConfig = { metrics: metrics.map(metricConfig) };
  if (address.trim() !== "") out.address = address.trim();
  return out;
}

/** The first `{{...}}` of a query that is not one of the variables the agent replaces, or undefined. */
export function unknownVariable(query: string): string | undefined {
  for (const m of query.matchAll(/\{\{(.*?)\}\}/g)) {
    if (!(QUERY_VARIABLES as readonly string[]).includes(m[1])) return `{{${m[1].trim()}}}`;
  }
  return /\{\{(?![^]*\}\})/.test(query) ? "{{" : undefined;
}

function addressError(address: string): string | undefined {
  const text = address.trim();
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `Enter an http or https address such as ${DEFAULT_PROMETHEUS}.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `Enter an http or https address such as ${DEFAULT_PROMETHEUS}.`;
  if (url.username !== "" || url.password !== "") return "The address carries no credentials: put a proxy that adds them in front of Prometheus.";
  if (url.search !== "" || url.hash !== "") return "Enter the base address, without a query or fragment.";
  return undefined;
}

/**
 * What is wrong with the gates, keyed `analysis.address` and `analysis.<index>.<field>`: the checks the agent makes that a
 * form can make while you type. `soak` is the soak field as typed (blank is the agent's 30 seconds).
 */
export function analysisErrors(address: string, metrics: MetricDraft[], soak: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (metrics.length === 0) return errors;
  const addr = addressError(address);
  if (addr) errors["analysis.address"] = addr;
  if (metrics.length > MAX_METRICS) errors.analysis = `At most ${MAX_METRICS} metrics.`;
  const soakSeconds = soak.trim() === "" ? DEFAULT_SOAK_SECONDS : parseDurationSeconds(soak);
  if (soakSeconds === 0) errors.analysis = "Metrics are evaluated during the soak: give it more than 0s, or remove the metrics.";
  const names = new Set<string>();
  metrics.forEach((m, i) => {
    const key = `analysis.${i}`;
    const name = m.name.trim();
    if (!NAME.test(name)) errors[`${key}.name`] = "Letters, digits, - and _, up to 40, for example error-rate.";
    else if (names.has(name)) errors[`${key}.name`] = `Another metric is named ${name}.`;
    names.add(name);
    if (m.query.trim() === "") errors[`${key}.query`] = "Enter a PromQL query that answers a number.";
    else {
      const unknown = unknownVariable(m.query);
      if (unknown) errors[`${key}.query`] = `${unknown} is not a variable: use {{app}}, {{container}} or {{version}}.`;
    }
    const max = toNumber(m.max);
    const min = toNumber(m.min);
    if (m.max.trim() !== "" && max === undefined) errors[`${key}.max`] = "A number, for example 0.02.";
    if (m.min.trim() !== "" && min === undefined) errors[`${key}.min`] = "A number, for example 0.99.";
    if (m.max.trim() === "" && m.min.trim() === "") errors[`${key}.max`] = "Set a maximum, a minimum or both: without a bound nothing can fail.";
    else if (max !== undefined && min !== undefined && min > max) errors[`${key}.min`] = "The minimum is above the maximum: no value would pass.";
    const interval = m.interval.trim() === "" ? DEFAULT_INTERVAL_SECONDS : parseDurationSeconds(m.interval);
    if (interval === null) errors[`${key}.interval`] = "A number and a unit, for example 10s or 1m.";
    else if (interval < 1) errors[`${key}.interval`] = "At least 1s.";
    const limitText = m.failureLimit.trim();
    let limit = DEFAULT_FAILURE_LIMIT;
    if (limitText !== "") {
      if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > MAX_FAILURE_LIMIT) errors[`${key}.failure_limit`] = `A whole number from 1 to ${MAX_FAILURE_LIMIT}.`;
      else limit = Number(limitText);
    }
    if (!errors[`${key}.interval`] && !errors[`${key}.failure_limit`] && soakSeconds !== null && soakSeconds > 0 && interval !== null) {
      const evaluations = Math.floor(soakSeconds / interval);
      if (evaluations < limit) errors[`${key}.failure_limit`] = `The soak holds ${evaluations} evaluation${evaluations === 1 ? "" : "s"} at this interval: this limit could never be reached. Lengthen the soak, shorten the interval or lower the limit.`;
    }
  });
  return errors;
}
