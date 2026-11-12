import { describe, expect, it } from "vitest";
import {
  WIZARD_STEPS,
  applySuggestion,
  chooseCandidate,
  chooseFramework,
  clearSuggestion,
  defaultDomain,
  dnsSummary,
  effectiveInput,
  formErrors,
  initialInput,
  isAdvancedField,
  optionLines,
  pasteVars,
  pendingVariable,
  putVar,
  removeVar,
  setOption,
  setVarBuild,
  stepErrors,
  variableLines,
  withDefaultDomain,
  writtenContext,
} from "@/lib/new-project-wizard-core";
import type { DnsSetup } from "@/lib/dns-record-core";
import { PRESET_LIST } from "@/lib/presets-core";
import type { ReviewContext } from "@/lib/repo-detect-core";

const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ existingNames: ["web"], usedDomains: [], usedHostPorts: [8100], proxy: "caddy", previewApps: [], ...extra });
const fresh = () => initialInput({ name: "shop", branch: "main", hostPort: 8101, domains: true });

describe("the wizard's steps and its fresh form", () => {
  it("has the five steps in order", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["repository", "framework", "configure", "variables", "review"]);
  });

  it("chooses nothing for the operator: no framework, no variables, no domain, the first free local port", () => {
    const f = fresh();
    expect(f.preset).toBe("");
    expect(f.options).toEqual({});
    expect(f.release).toBe("");
    expect(f.port).toBe("");
    expect(f.exposure).toBe("domain");
    expect(f.hostPort).toBe("8101");
    expect(initialInput({ name: "a", branch: "main", hostPort: 8100, domains: false }).exposure).toBe("local");
  });

  it("is refused as it is: the framework must be clicked, and it is the only problem of the framework step", () => {
    const errors = formErrors({ ...fresh(), domain: "shop.example.com" }, ctx());
    expect(errors.preset).toMatch(/Choose how the project is built/);
    expect(Object.keys(stepErrors("framework", errors, ""))).toEqual(["preset"]);
  });
});

describe("a click on a framework card", () => {
  for (const p of PRESET_LIST.filter((x) => x.id !== "dockerfile")) {
    it(`${p.label}: sets the preset, its default port and health path, and no option`, () => {
      const after = chooseFramework({ ...fresh(), options: { start: "x" }, port: "9" }, p.id);
      expect(after).toMatchObject({ preset: p.id, options: {}, port: String(p.defaultPort), healthPath: p.defaultHealthPath });
    });
  }

  it("Dockerfile: takes the port and the path of the first Dockerfile found, never a default port", () => {
    const c = { path: "api/Dockerfile", context: "api", dockerfile: "Dockerfile", port: 4000, portFromVariable: false, healthcheck: true };
    expect(chooseFramework(fresh(), "dockerfile", c)).toMatchObject({ preset: "dockerfile", dockerfile: "api/Dockerfile", context: "api", port: "4000", healthPath: "" });
    expect(chooseFramework(fresh(), "dockerfile")).toMatchObject({ preset: "dockerfile", port: "" });
    expect(chooseCandidate(fresh(), { ...c, port: null })).toMatchObject({ dockerfile: "api/Dockerfile", port: "" });
  });

  it("switching back and forth keeps what was typed outside the framework's own fields", () => {
    const typed = { ...fresh(), name: "mine", branch: "dev", release: "npm run migrate", domain: "mine.example.com" };
    const round = chooseFramework(chooseFramework(typed, "vite"), "nextjs");
    expect(round).toMatchObject({ name: "mine", branch: "dev", release: "npm run migrate", domain: "mine.example.com", preset: "nextjs" });
  });
});

describe("the form as it is sent", () => {
  it("leaves the health path out for a local port, and previews out without a template", () => {
    const f = { ...fresh(), preset: "node", port: "3000", healthPath: "/", exposure: "local", previews: true };
    expect(effectiveInput(f, ctx())).toMatchObject({ healthPath: "", previews: false });
    expect(effectiveInput({ ...f, exposure: "domain" }, ctx({ previewApps: ["shop"] }))).toMatchObject({ healthPath: "/", previews: true });
  });

  it("makes a framework listen on its default port on a local port, and drops the options of the Dockerfile card", () => {
    expect(effectiveInput({ ...fresh(), preset: "nextjs", port: "4000", exposure: "local" }, ctx()).port).toBe("3000");
    expect(effectiveInput({ ...fresh(), preset: "nextjs", port: "4000", exposure: "domain" }, ctx()).port).toBe("4000");
    expect(effectiveInput({ ...fresh(), preset: "dockerfile", options: { start: "x" } }, ctx()).options).toEqual({});
  });

  it("is valid for every framework with only a name, a domain and a click", () => {
    for (const p of PRESET_LIST.filter((x) => x.id !== "dockerfile")) {
      expect(formErrors(chooseFramework({ ...fresh(), domain: "shop.example.com" }, p.id), ctx())).toEqual({});
    }
  });

  it("reports a taken name, a taken domain and a bad option by field", () => {
    const f = chooseFramework({ ...fresh(), name: "web", domain: "x.example.com" }, "node");
    expect(formErrors({ ...f, options: { node: "7" } }, ctx()).name).toMatch(/already has an app named web/);
    expect(formErrors({ ...f, options: { node: "7" } }, ctx())["options.node"]).toBeDefined();
    expect(formErrors({ ...f, domain: "d.example.com" }, ctx({ usedDomains: ["d.example.com"] })).domain).toMatch(/Another app/);
  });

  it("does not offer a domain without Caddy", () => {
    const f = chooseFramework({ ...fresh(), domain: "shop.example.com" }, "node");
    expect(formErrors(f, ctx({ proxy: "other" })).exposure).toMatch(/only offered with the Caddy proxy/);
    expect(formErrors(f, ctx({ proxy: "none" })).exposure).toMatch(/no proxy section/);
  });
});

describe("which problems keep the operator on a step", () => {
  it("splits the framework step's (framework, and the Dockerfile's path and context) from the configure step's", () => {
    const errors = { preset: "p", dockerfile: "d", context: "c", name: "n", "options.node": "o" };
    expect(Object.keys(stepErrors("framework", errors, "dockerfile")).sort()).toEqual(["context", "dockerfile", "preset"]);
    expect(Object.keys(stepErrors("configure", errors, "dockerfile")).sort()).toEqual(["name", "options.node"]);
    expect(Object.keys(stepErrors("framework", errors, "node"))).toEqual(["preset"]);
    expect(Object.keys(stepErrors("configure", errors, "node")).sort()).toEqual(["context", "dockerfile", "name", "options.node"]);
    expect(Object.keys(stepErrors("review", errors, "node")).length).toBe(5);
  });

  it("opens Advanced for the fields inside it", () => {
    expect(["options.node", "memory", "cpus", "timeout", "envFile"].every((k) => isAdvancedField(k as never))).toBe(true);
    expect(["name", "port", "release", "domain"].some((k) => isAdvancedField(k as never))).toBe(false);
  });
});

describe("options", () => {
  it("drops a blank one (the default applies) and keeps a switch that was turned", () => {
    expect(setOption({ install: "a", node: "20" }, "install", "")).toEqual({ node: "20" });
    expect(setOption({}, "spa", false)).toEqual({ spa: false });
  });

  it("lists in the review only what differs from a blank one, in the registry's order", () => {
    expect(optionLines("vite", { install: "pnpm i", node: "20", spa: false })).toEqual([
      { label: "Install command", value: "pnpm i" },
      { label: "Node.js version", value: "20" },
      { label: "Single-page fallback", value: "off" },
    ]);
    expect(optionLines("vite", { spa: true })).toEqual([]);
    expect(optionLines("dockerfile", { install: "x" })).toEqual([]);
    expect(optionLines("nextjs", { standalone: true })).toEqual([{ label: "Standalone output", value: "on" }]);
  });
});

describe("the variables held until Create", () => {
  it("adds one, starts the build flag on for the names frameworks expose, and replaces a name that is there", () => {
    let vars = putVar([], { key: "NEXT_PUBLIC_API", value: "a" });
    vars = putVar(vars, { key: "DATABASE_URL", value: "b" });
    expect(vars.map((v) => [v.key, v.build])).toEqual([["NEXT_PUBLIC_API", true], ["DATABASE_URL", false]]);
    vars = putVar(vars, { key: "NEXT_PUBLIC_API", value: "c" });
    expect(vars).toHaveLength(2);
    expect(vars[0]).toEqual({ key: "NEXT_PUBLIC_API", value: "c", build: true }); // the flag the operator set stays
    expect(setVarBuild(vars, "DATABASE_URL", true)[1]!.build).toBe(true);
    expect(removeVar(vars, "DATABASE_URL").map((v) => v.key)).toEqual(["NEXT_PUBLIC_API"]);
  });

  it("keeps a variable typed but never added, and leaves a half-typed or refused one alone", () => {
    const base = [{ key: "A", value: "1", build: false }];
    expect(pendingVariable(base, " CRON_SECRET ", "s3cret")!.map((v) => v.key)).toEqual(["A", "CRON_SECRET"]);
    expect(pendingVariable(base, "A", "2")![0]).toEqual({ key: "A", value: "2", build: false });
    expect(pendingVariable(base, "", "x")).toBeNull();
    expect(pendingVariable(base, "CRON_SECRET", "")).toBeNull(); // a name alone is not a variable with an empty value
    expect(pendingVariable(base, "KEELSON_X", "x", { portKeys: ["PORT"] })).toBeNull();
    expect(pendingVariable(base, "bad name", "x")).toBeNull();
  });

  it("pastes a .env: new, replaced and refused names, unreadable lines by number, and no value in the report", () => {
    const secret = "pw-very-secret";
    const text = `# c\nA=1\nexport B="two words"\nVITE_URL=https://x\nbad line ${secret}\nKEELSON_X=${secret}\nA=3\n`;
    const out = pasteVars([{ key: "B", value: "old", build: false }], text, { portKeys: ["PORT"] });
    expect(out.vars.map((v) => v.key)).toEqual(["B", "A", "VITE_URL"]);
    expect(out.vars.find((v) => v.key === "A")!.value).toBe("3");
    expect(out.vars.find((v) => v.key === "VITE_URL")!.build).toBe(true);
    expect(out.added).toBe(2);
    expect(out.replaced).toEqual(["B"]);
    expect(out.repeated).toEqual(["A"]);
    expect(out.refused.map((r) => r.key)).toEqual(["KEELSON_X"]);
    expect(out.unreadable).toEqual([{ line: 5, reason: "no = sign" }]);
    const report = JSON.stringify({ ...out, vars: undefined });
    expect(report).not.toContain(secret);
    expect(report).not.toContain("two words");
  });

  it("lists names and flags for the review, never values", () => {
    const lines = variableLines([{ key: "A", value: "SECRET-1", build: false }, { key: "B", value: "SECRET-2", build: true }]);
    expect(lines).toEqual([{ label: "A", value: "runtime only" }, { label: "B", value: "available at build time" }]);
    expect(JSON.stringify(lines)).not.toContain("SECRET");
  });
});

describe("what the review says about the domain's DNS", () => {
  const connected: DnsSetup = { connected: true, zones: ["example.com"], zonesError: null, address: { ok: true, ip: "203.0.113.7", type: "A", source: "the host of the agent's URL", private: null } };
  const manual: DnsSetup = { ...connected, connected: false, zones: [] };
  const f = { ...fresh(), domain: "shop.example.com" };

  it("says what Keelson creates, with the proxy choice, or what the operator creates", () => {
    expect(dnsSummary(f, connected, true, true)).toBe("Keelson creates A shop.example.com → 203.0.113.7 at Cloudflare (zone example.com), proxied.");
    expect(dnsSummary(f, connected, true, false)).toContain("DNS only");
    expect(dnsSummary(f, connected, false, true)).toContain("You create A shop.example.com → 203.0.113.7 yourself");
    expect(dnsSummary(f, manual, true, true)).toContain("You create A shop.example.com → 203.0.113.7 at your DNS provider");
  });

  it("says nothing for a local port or a name that is not a host name yet", () => {
    expect(dnsSummary({ ...f, exposure: "local" }, connected, true, true)).toBeNull();
    expect(dnsSummary({ ...f, domain: "nope" }, connected, true, true)).toBeNull();
  });
});

describe("what a repository's suggestion puts into the form", () => {
  const nextjs = { framework: { id: "nextjs" as const, reason: "package.json depends on next." }, release: { command: "npx prisma migrate deploy", reason: "prisma/migrations exists." }, database: null, envNames: [] };
  const dockerfile = { framework: { id: "dockerfile" as const, reason: "The repository has a Dockerfile." }, release: null, database: null, envNames: [] };
  const candidate = { path: "api/Dockerfile", context: "api", dockerfile: "Dockerfile", port: 4000, portFromVariable: false, healthcheck: false };

  it("selects the card with its defaults and fills the release command, on a form where nothing was chosen", () => {
    const { input, applied } = applySuggestion(fresh(), nextjs);
    expect(input).toMatchObject({ preset: "nextjs", port: "3000", release: "npx prisma migrate deploy" });
    expect(applied).toEqual({ preset: "nextjs", release: "npx prisma migrate deploy" });
  });

  it("takes the first Dockerfile found for the Dockerfile card, with its context and port", () => {
    const { input } = applySuggestion(fresh(), dockerfile, candidate);
    expect(input).toMatchObject({ preset: "dockerfile", dockerfile: "api/Dockerfile", context: "api", port: "4000", release: "" });
  });

  it("never overwrites a card the operator already chose, however late the suggestion arrives", () => {
    const chosen = chooseFramework(fresh(), "vite");
    const out = applySuggestion(chosen, nextjs);
    expect(out.input).toBe(chosen);
    expect(out.applied).toBeNull();
  });

  it("keeps a release command the operator typed", () => {
    const typed = { ...fresh(), release: "node migrate.js" };
    const { input, applied } = applySuggestion(typed, nextjs);
    expect(input.release).toBe("node migrate.js");
    expect(applied?.release).toBe("");
  });

  it("changes nothing when the repository suggests no framework", () => {
    const start = fresh();
    const out = applySuggestion(start, { framework: null, release: null, database: null, envNames: [] });
    expect(out).toEqual({ input: start, applied: null });
  });

  it("is taken out again for another repository, but only where the operator left it as it was put", () => {
    const { input, applied } = applySuggestion(fresh(), nextjs);
    expect(clearSuggestion(input, applied!)).toMatchObject({ preset: "", port: "", release: "" });
    // a card picked afterwards, or a release command edited, stays
    const repicked = chooseFramework(input, "node");
    expect(clearSuggestion(repicked, applied!)).toMatchObject({ preset: "node", release: "" });
    const edited = { ...input, release: "npx prisma migrate deploy && node seed.js" };
    expect(clearSuggestion(edited, applied!)).toMatchObject({ preset: "", release: "npx prisma migrate deploy && node seed.js" });
  });
});

describe("the domain a project gets under the server's apps domain", () => {
  const server = (appsDomain: string | null, proxy: "caddy" | "other" | "none" = "caddy") => ({ appsDomain, context: ctx({ proxy }) });

  it("is the project's name under the domain, with underscores turned into dashes, and empty without a domain or a usable name", () => {
    expect(defaultDomain("shop", "apps.example.com")).toBe("shop.apps.example.com");
    expect(defaultDomain("  Shop  ", "apps.example.com")).toBe("shop.apps.example.com");
    expect(defaultDomain("my_shop", "apps.example.com")).toBe("my-shop.apps.example.com");
    expect(defaultDomain("shop", null)).toBe("");
    expect(defaultDomain("", "apps.example.com")).toBe("");
    expect(defaultDomain("-", "apps.example.com")).toBe("");
  });

  it("fills the form's domain from the name, and follows the name until the operator types a domain", () => {
    const named = { ...fresh(), name: "blog" };
    expect(withDefaultDomain(named, server("apps.example.com"), false).domain).toBe("blog.apps.example.com");
    expect(withDefaultDomain({ ...named, domain: "mine.example.org" }, server("apps.example.com"), true).domain).toBe("mine.example.org");
  });

  it("leaves the form alone on a server with no apps domain or one that cannot serve domains", () => {
    const named = { ...fresh(), name: "blog", domain: "kept.example.com" };
    expect(withDefaultDomain(named, server(null), false)).toBe(named);
    expect(withDefaultDomain(named, server("apps.example.com", "none"), false)).toBe(named);
    expect(withDefaultDomain(named, server("apps.example.com", "other"), false)).toBe(named);
  });
});

describe("the form once its app is written", () => {
  it("is no longer refused for the name, domain and port its own app now holds in the agent's configuration", () => {
    const filled = { ...chooseFramework(fresh(), "node"), name: "shop", domain: "shop.example.com", exposure: "domain" as const };
    const holdsIt = ctx({ existingNames: ["shop"], usedDomains: ["shop.example.com"], usedHostPorts: [8101] });
    expect(formErrors(filled, holdsIt).name).toBeDefined();
    expect(formErrors(filled, writtenContext(holdsIt))).toEqual({});
    // what is not about uniqueness stays
    expect(writtenContext(holdsIt)).toMatchObject({ proxy: "caddy", previewApps: [] });
  });
});
