import { describe, expect, it } from "vitest";
import { deploymentWarnings } from "@/lib/deployment-warnings-core";

const production = { NODE_ENV: "production" };

describe("the way the dashboard was started", () => {
  it("says nothing in development, and nothing for the defaults of the compose file (plain http on this machine)", () => {
    expect(deploymentWarnings({ NODE_ENV: "development" })).toEqual([]);
    expect(deploymentWarnings({ ...production, KEELSON_INSECURE_COOKIES: "true" })).toEqual([]);
  });

  it("says nothing for the TLS setup of the compose file: https, one trusted proxy, Secure cookies", () => {
    expect(deploymentWarnings({ ...production, KEELSON_PUBLIC_URL: "https://keelson.example.com", KEELSON_TRUST_PROXY: "true" })).toEqual([]);
  });

  it("warns that one throttle is shared when the address is https but no proxy is trusted, and what that costs", () => {
    const out = deploymentWarnings({ ...production, KEELSON_PUBLIC_URL: "https://keelson.example.com" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/KEELSON_TRUST_PROXY/);
    expect(out[0]).toMatch(/lock you out/);
  });

  it("accepts a client address header as the trust a proxy needs", () => {
    expect(deploymentWarnings({ ...production, KEELSON_PUBLIC_URL: "https://keelson.example.com", KEELSON_CLIENT_IP_HEADER: "CF-Connecting-IP" })).toEqual([]);
  });

  it("does not warn about INSECURE_COOKIES behind https: the https address turns the Secure flag on anyway (see tests/secure-cookies)", () => {
    expect(deploymentWarnings({ ...production, KEELSON_PUBLIC_URL: "https://keelson.example.com", KEELSON_TRUST_PROXY: "true", KEELSON_INSECURE_COOKIES: "true" })).toEqual([]);
  });

  it("warns when a dashboard meant to be reached from elsewhere has no public address", () => {
    const out = deploymentWarnings({ ...production });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/KEELSON_PUBLIC_URL is not set/);
  });
});
