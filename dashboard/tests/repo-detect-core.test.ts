import { describe, expect, it } from "vitest";
import type { AppConfig, ConfigModel } from "@/lib/agent-types";
import {
  visibleFieldError,
  APP_NAME,
  buildAppConfig,
  contextOf,
  dockerfileInContext,
  dockerfilePlaces,
  orderDockerfiles,
  parseDockerfile,
  reviewContext,
  slugName,
  suggestHostPort,
  suggestName,
  usedHostPorts,
  validateReview,
  type ReviewContext,
  type ReviewInput,
} from "@/lib/repo-detect-core";

describe("parseDockerfile", () => {
  it("reads a simple EXPOSE and no health check", () => {
    expect(parseDockerfile("FROM node:22\nEXPOSE 3000\nCMD [\"node\"]\n")).toEqual({ port: 3000, portFromVariable: false, healthcheck: false });
  });

  it("only counts the final stage of a multi-stage build", () => {
    const text = `FROM node:22 AS build\nEXPOSE 9229\nHEALTHCHECK CMD true\nRUN npm run build\n\nFROM nginx:alpine AS run\nCOPY --from=build /app/dist /usr/share/nginx/html\nEXPOSE 80\n`;
    expect(parseDockerfile(text)).toEqual({ port: 80, portFromVariable: false, healthcheck: false });
  });

  it("takes the last EXPOSE of the stage, and the first port of it", () => {
    expect(parseDockerfile("FROM a\nEXPOSE 80\nEXPOSE 8080 8443\n").port).toBe(8080);
    expect(parseDockerfile("FROM a\nEXPOSE 8080 8443\nEXPOSE 80 81\n").port).toBe(80);
  });

  it("reads the /tcp suffix, skips a leading UDP port, and drops quotes", () => {
    expect(parseDockerfile("FROM a\nEXPOSE 3000/tcp\n").port).toBe(3000);
    expect(parseDockerfile("FROM a\nEXPOSE 5353/udp 8080/tcp\n").port).toBe(8080);
    expect(parseDockerfile("FROM a\nEXPOSE 5353/udp\n").port).toBeNull();
    expect(parseDockerfile('FROM a\nEXPOSE "4000"\n').port).toBe(4000);
  });

  it("does not guess a port that comes from an argument, a variable or a range", () => {
    expect(parseDockerfile("FROM a\nARG PORT=8080\nEXPOSE $PORT\n")).toMatchObject({ port: null, portFromVariable: true });
    expect(parseDockerfile("FROM a\nARG PORT=8080\nEXPOSE ${PORT}\n")).toMatchObject({ port: null, portFromVariable: true });
    expect(parseDockerfile("FROM a\nEXPOSE 8000-8010\n")).toMatchObject({ port: null, portFromVariable: false });
    // the last EXPOSE decides: an earlier literal one does not stand in for it
    expect(parseDockerfile("FROM a\nEXPOSE 80\nEXPOSE $PORT\n")).toMatchObject({ port: null, portFromVariable: true });
  });

  it("is case-insensitive, ignores comments and joins continuation lines", () => {
    const text = "from a\n# EXPOSE 1111\nexpose 2222\nHEALTHCHECK --interval=30s \\\n  --timeout=3s \\\n  CMD curl -f http://localhost/ || exit 1\n";
    expect(parseDockerfile(text)).toEqual({ port: 2222, portFromVariable: false, healthcheck: true });
  });

  it("recognises the HEALTHCHECK forms: with options, CMD, shell form, and NONE", () => {
    expect(parseDockerfile("FROM a\nHEALTHCHECK CMD curl -f http://localhost/\n").healthcheck).toBe(true);
    expect(parseDockerfile("FROM a\nHEALTHCHECK --interval=5s --retries=3 CMD [\"wget\", \"-q\", \"localhost\"]\n").healthcheck).toBe(true);
    expect(parseDockerfile("FROM a\nHEALTHCHECK curl -f http://localhost/\n").healthcheck).toBe(true);
    expect(parseDockerfile("FROM a\nHEALTHCHECK NONE\n").healthcheck).toBe(false);
    expect(parseDockerfile("FROM a\nHEALTHCHECK CMD true\nHEALTHCHECK NONE\n").healthcheck).toBe(false);
    expect(parseDockerfile("FROM a\nRUN echo HEALTHCHECK\n").healthcheck).toBe(false);
  });

  it("has nothing to report for a Dockerfile without EXPOSE or HEALTHCHECK, and for an empty one", () => {
    expect(parseDockerfile("FROM scratch\nCOPY app /app\n")).toEqual({ port: null, portFromVariable: false, healthcheck: false });
    expect(parseDockerfile("")).toEqual({ port: null, portFromVariable: false, healthcheck: false });
  });

  it("copes with Windows line endings", () => {
    expect(parseDockerfile("FROM a\r\nEXPOSE 3000\r\nHEALTHCHECK CMD true\r\n")).toEqual({ port: 3000, portFromVariable: false, healthcheck: true });
  });
});

describe("where the Dockerfile is", () => {
  it("derives the build context from its path", () => {
    expect(contextOf("Dockerfile")).toBe(".");
    expect(contextOf("Dockerfile.prod")).toBe(".");
    expect(contextOf("docker/Dockerfile")).toBe(".");
    expect(contextOf("deploy/Dockerfile")).toBe(".");
    expect(contextOf("api/Dockerfile")).toBe("api");
    expect(contextOf("services/api/Dockerfile")).toBe("services/api");
  });

  it("states the Dockerfile relative to its context, and refuses one outside it", () => {
    expect(dockerfileInContext("docker/Dockerfile", ".")).toBe("docker/Dockerfile");
    expect(dockerfileInContext("api/Dockerfile", "api")).toBe("Dockerfile");
    expect(dockerfileInContext("api/build/Dockerfile.prod", "api")).toBe("build/Dockerfile.prod");
    expect(dockerfileInContext("web/Dockerfile", "api")).toBeNull();
  });

  it("looks at the likely root files and directories, skipping dependencies and dot directories", () => {
    const places = dockerfilePlaces([
      { name: "Dockerfile", type: "file" },
      { name: "Dockerfile.prod", type: "file" },
      { name: "Dockerfile.dev", type: "file" },
      { name: "README.md", type: "file" },
      { name: "node_modules", type: "dir" },
      { name: ".github", type: "dir" },
      { name: "web", type: "dir" },
      { name: "api", type: "dir" },
      { name: "deploy", type: "dir" },
      { name: "docker", type: "dir" },
    ]);
    expect(places.files).toEqual(["Dockerfile", "Dockerfile.prod"]);
    expect(places.dirs).toEqual(["docker", "deploy", "api", "web"]);
    expect(places.truncated).toBe(false);
  });

  it("limits the directories it searches and says so", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `d${String(i).padStart(2, "0")}`, type: "dir" as const }));
    const places = dockerfilePlaces(many);
    expect(places.dirs).toHaveLength(12);
    expect(places.truncated).toBe(true);
  });

  it("orders what was found: Dockerfile, docker/, Dockerfile.prod, deploy/, then subdirectories by name", () => {
    expect(orderDockerfiles(["web/Dockerfile", "deploy/Dockerfile", "api/Dockerfile", "Dockerfile.prod", "docker/Dockerfile", "Dockerfile"])).toEqual([
      "Dockerfile",
      "docker/Dockerfile",
      "Dockerfile.prod",
      "deploy/Dockerfile",
      "api/Dockerfile",
      "web/Dockerfile",
    ]);
  });

  it("puts Dockerfile.keelson, the variant kept for this agent's builder, before the Dockerfile", () => {
    const root = [{ name: "Dockerfile", type: "file" as const }, { name: "Dockerfile.keelson", type: "file" as const }];
    expect(dockerfilePlaces(root).files).toEqual(["Dockerfile.keelson", "Dockerfile"]);
    expect(orderDockerfiles(["Dockerfile", "docker/Dockerfile", "Dockerfile.keelson"])).toEqual(["Dockerfile.keelson", "Dockerfile", "docker/Dockerfile"]);
  });
});

describe("names", () => {
  it("slugs a repository's name to the agent's name rules", () => {
    expect(slugName("Acme/Shop")).toBe("shop");
    expect(slugName("acme/My.Cool App_v2")).toBe("my-cool-app-v2");
    expect(slugName("acme/--weird--")).toBe("weird");
    expect(slugName("acme/名前")).toBe("app");
    expect(slugName("acme/a..b")).toBe("a-b");
    for (const repo of ["Acme/Shop", "acme/My.Cool App_v2", "acme/..x..y", "acme/" + "z".repeat(100)]) expect(APP_NAME.test(slugName(repo))).toBe(true);
  });

  it("keeps room for previews in a long name", () => {
    const name = slugName(`acme/${"a".repeat(100)}`);
    expect(name.length).toBeLessThanOrEqual(53);
  });

  it("suggests a free name when the repository's is taken", () => {
    expect(suggestName("acme/shop", [])).toEqual({ name: "shop", taken: false });
    expect(suggestName("acme/shop", ["shop"])).toEqual({ name: "shop-2", taken: true });
    expect(suggestName("acme/shop", ["shop", "shop-2", "shop-3"])).toEqual({ name: "shop-4", taken: true });
  });
});

const app = (extra: Partial<AppConfig>): AppConfig => ({ name: "x", image: "i", ...extra });

describe("free local port", () => {
  it("starts at 8100", () => {
    expect(suggestHostPort([])).toBe(8100);
  });

  it("skips the ports of publish entries and port.host, with or without an address or protocol", () => {
    const apps = [
      app({ publish: ["127.0.0.1:8100:3000"] }),
      app({ publish: ["8101:80/tcp"] }),
      app({ port: { host: [8102, 8103], env: "PORT" } }),
      app({ publish: ["0.0.0.0:9000:9000"] }),
    ];
    expect([...usedHostPorts(apps)].sort()).toEqual([8100, 8101, 8102, 8103, 9000]);
    expect(suggestHostPort(apps)).toBe(8104);
  });

  it("takes the first gap", () => {
    expect(suggestHostPort([app({ publish: ["127.0.0.1:8101:3000"] })])).toBe(8100);
  });
});

const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ existingNames: ["web"], usedDomains: ["web.example.com"], usedHostPorts: [8100], proxy: "caddy", previewApps: [], ...extra });

const input = (extra: Partial<ReviewInput> = {}): ReviewInput => ({
  name: "shop",
  branch: "main",
  preset: "dockerfile",
  options: {},
  release: "",
  dockerfile: "Dockerfile",
  context: ".",
  port: "3000",
  exposure: "domain",
  domain: "shop.example.com",
  hostPort: "8101",
  healthPath: "",
  memory: "2g",
  cpus: "2",
  timeout: "15m",
  buildHostNetwork: false,
  buildDatabase: false,
  envFile: "",
  buildOnPush: true,
  previews: false,
  ...extra,
});

function errorsOf(i: ReviewInput, c: ReviewContext = ctx()) {
  const out = validateReview(i, c);
  if (out.ok) throw new Error("expected errors");
  return out.errors;
}

describe("the review form", () => {
  it("accepts a domain setup and fills the defaults of the limits", () => {
    const out = validateReview(input({ memory: "", cpus: "", timeout: "" }), ctx());
    expect(out).toMatchObject({ ok: true, review: { name: "shop", port: 3000, exposure: { kind: "domain", domain: "shop.example.com" }, memory: "2g", cpus: 2, timeout: "15m" } });
  });

  it("requires Caddy for a domain", () => {
    expect(errorsOf(input(), ctx({ proxy: "none" })).exposure).toMatch(/no proxy section/);
    expect(errorsOf(input(), ctx({ proxy: "other" })).exposure).toMatch(/only offered with the Caddy proxy/);
  });

  it("requires a valid, unused domain", () => {
    expect(errorsOf(input({ domain: "" })).domain).toBeDefined();
    expect(errorsOf(input({ domain: "not a host" })).domain).toBeDefined();
    expect(errorsOf(input({ domain: "localhost" })).domain).toBeDefined();
    expect(errorsOf(input({ domain: "WEB.example.com" })).domain).toMatch(/already serves/);
    expect(validateReview(input({ domain: "Shop.Example.com" }), ctx())).toMatchObject({ ok: true, review: { exposure: { domain: "shop.example.com" } } });
  });

  it("requires the container port, as a number from 1 to 65535", () => {
    expect(errorsOf(input({ port: "" })).port).toMatch(/required/);
    expect(errorsOf(input({ port: "0" })).port).toBeDefined();
    expect(errorsOf(input({ port: "70000" })).port).toBeDefined();
    expect(errorsOf(input({ port: "80a" })).port).toBeDefined();
  });

  it("refuses bad and existing names", () => {
    for (const name of ["", "Shop", "-shop", "shop-", "my app", "a--b", "a".repeat(64), "../x"]) expect(errorsOf(input({ name })).name, name).toBeDefined();
    expect(errorsOf(input({ name: "web" })).name).toMatch(/already has an app named web/);
    expect(validateReview(input({ name: "my_shop-2" }), ctx()).ok).toBe(true);
  });

  it("keeps room for the pull request number in the name of an app with previews", () => {
    const long = "a".repeat(60);
    expect(validateReview(input({ name: long }), ctx()).ok).toBe(true);
    expect(errorsOf(input({ name: long, previews: true }), ctx({ previewApps: [long] })).name).toMatch(/53/);
  });

  it("checks the branch", () => {
    expect(errorsOf(input({ branch: "bad..branch" })).branch).toBeDefined();
    expect(errorsOf(input({ branch: "" })).branch).toBeDefined();
  });

  it("states the Dockerfile relative to the context and keeps it inside", () => {
    expect(validateReview(input({ dockerfile: "api/Dockerfile", context: "api" }), ctx())).toMatchObject({ ok: true, review: { dockerfile: "Dockerfile", context: "api" } });
    expect(errorsOf(input({ dockerfile: "web/Dockerfile", context: "api" })).dockerfile).toMatch(/inside the build context/);
    expect(errorsOf(input({ dockerfile: "../Dockerfile" })).dockerfile).toBeDefined();
    expect(errorsOf(input({ dockerfile: "/etc/Dockerfile" })).dockerfile).toBeDefined();
    expect(errorsOf(input({ context: "../x" })).context).toBeDefined();
    expect(errorsOf(input({ context: "/abs" })).context).toBeDefined();
    expect(errorsOf(input({ dockerfile: "a\\b" })).dockerfile).toBeDefined();
  });

  it("offers a local port: valid and not used by another app", () => {
    expect(validateReview(input({ exposure: "local", hostPort: "8101" }), ctx({ proxy: "none" }))).toMatchObject({ ok: true, review: { exposure: { kind: "local", hostPort: 8101 } } });
    expect(errorsOf(input({ exposure: "local", hostPort: "8100" })).hostPort).toMatch(/already used/);
    expect(errorsOf(input({ exposure: "local", hostPort: "" })).hostPort).toBeDefined();
    expect(errorsOf(input({ exposure: "local", hostPort: "99999" })).hostPort).toBeDefined();
  });

  it("rejects an unknown way of exposing the app", () => {
    expect(errorsOf(input({ exposure: "tunnel" })).exposure).toBeDefined();
  });

  it("checks the health path, and refuses one for a local port, which the agent ignores", () => {
    expect(errorsOf(input({ healthPath: "healthz" })).healthPath).toBeDefined();
    expect(errorsOf(input({ healthPath: "/a b" })).healthPath).toBeDefined();
    expect(validateReview(input({ healthPath: "/healthz" }), ctx())).toMatchObject({ ok: true, review: { healthPath: "/healthz" } });
    expect(errorsOf(input({ exposure: "local", healthPath: "/healthz" })).healthPath).toMatch(/only checked for apps served on a domain/);
  });

  it("checks the build limits", () => {
    expect(errorsOf(input({ memory: "lots" })).memory).toBeDefined();
    expect(errorsOf(input({ memory: "32m" })).memory).toBeDefined();
    expect(validateReview(input({ memory: "512m" }), ctx()).ok).toBe(true);
    expect(errorsOf(input({ cpus: "0" })).cpus).toBeDefined();
    expect(errorsOf(input({ cpus: "1000" })).cpus).toBeDefined();
    expect(validateReview(input({ cpus: "0.5" }), ctx()).ok).toBe(true);
    expect(errorsOf(input({ timeout: "2h" })).timeout).toBeDefined();
    expect(errorsOf(input({ timeout: "soon" })).timeout).toBeDefined();
    expect(validateReview(input({ timeout: "1h" }), ctx()).ok).toBe(true);
  });

  it("takes an env file only as an absolute path on the server", () => {
    expect(errorsOf(input({ envFile: "app.env" })).envFile).toBeDefined();
    expect(errorsOf(input({ envFile: "/etc/app.env\nSECRET=1" })).envFile).toBeDefined();
    expect(validateReview(input({ envFile: "/etc/keelson/shop.env" }), ctx())).toMatchObject({ ok: true, review: { envFile: "/etc/keelson/shop.env" } });
  });

  it("allows previews only for an app that has a previews template", () => {
    expect(errorsOf(input({ previews: true })).previews).toMatch(/previews: template/);
    expect(validateReview(input({ previews: true }), ctx({ previewApps: ["shop"] }))).toMatchObject({ ok: true, review: { previews: true } });
  });

  it("reports every problem at once", () => {
    const errors = errorsOf(input({ name: "", port: "", domain: "" }));
    expect(Object.keys(errors).sort()).toEqual(["domain", "name", "port"]);
  });
});

describe("the message under a field", () => {
  const local = { name: "This server already has an app named shop." };
  it("shows our own problems after an attempt and the server's always", () => {
    expect(visibleFieldError("name", { done: false, tried: false, local })).toBeUndefined();
    expect(visibleFieldError("name", { done: false, tried: true, local })).toBe(local.name);
    expect(visibleFieldError("port", { done: false, tried: false, local: {}, server: { port: "taken meanwhile" } })).toBe("taken meanwhile");
  });

  it("shows nothing once the app is written: its own name is not a collision", () => {
    expect(visibleFieldError("name", { done: true, tried: true, local, server: { name: "taken" } })).toBeUndefined();
  });
});

describe("the context taken from the agent's configuration", () => {
  const model = (m: ConfigModel) => reviewContext(m);

  it("lists names, domains and local ports of the existing apps", () => {
    const c = model({ proxy: {}, apps: [app({ name: "a", domains: ["A.example.com"], port: 1, previews: { domain: "pr-{pr}-a.example.com" } }), app({ name: "b", publish: ["127.0.0.1:8100:80"] })] });
    expect(c).toEqual({ existingNames: ["a", "b"], usedDomains: ["a.example.com"], usedHostPorts: [8100], proxy: "caddy", previewApps: ["a"] });
  });

  it("tells the proxy kind: none, Caddy (also by default) and others", () => {
    expect(model({}).proxy).toBe("none");
    expect(model({ proxy: {} }).proxy).toBe("caddy");
    expect(model({ proxy: { type: "caddy" } }).proxy).toBe("caddy");
    expect(model({ proxy: { type: "nginx" } }).proxy).toBe("other");
  });
});

describe("the app that is written", () => {
  const review = (i: ReviewInput, c: ReviewContext = ctx()) => {
    const out = validateReview(i, c);
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    return out.review;
  };

  it("for a domain: image, build block, port, domain, health path and env file", () => {
    const config = buildAppConfig(review(input({ dockerfile: "api/Dockerfile", context: "api", healthPath: "/healthz", envFile: "/etc/keelson/shop.env", memory: "1g", cpus: "1.5", timeout: "20m" })));
    expect(config).toEqual({
      name: "shop",
      image: "keelson-local/shop",
      build: { dockerfile: "Dockerfile", context: "api", memory: "1g", cpus: 1.5, timeout: "20m" },
      restart: "unless-stopped",
      env_file: "/etc/keelson/shop.env",
      port: 3000,
      domains: ["shop.example.com"],
      health_path: "/healthz",
    });
  });

  it("for a local port: a loopback mapping, and no port, domain or health path (the agent refuses them without a proxy)", () => {
    const config = buildAppConfig(review(input({ exposure: "local", hostPort: "8105", port: "8080" })));
    expect(config).toEqual({ name: "shop", image: "keelson-local/shop", build: { dockerfile: "Dockerfile", context: ".", memory: "2g", cpus: 2, timeout: "15m" }, restart: "unless-stopped", publish: ["127.0.0.1:8105:8080"] });
  });

  it("puts build.network: host in the build block only when the operator asked for it, for a Dockerfile and for a preset", () => {
    expect(buildAppConfig(review(input({ buildHostNetwork: true }))).build).toEqual({ dockerfile: "Dockerfile", context: ".", memory: "2g", cpus: 2, timeout: "15m", network: "host" });
    expect(buildAppConfig(review(input({ preset: "node", buildHostNetwork: true }))).build).toMatchObject({ preset: "node", network: "host" });
    expect(buildAppConfig(review(input({ buildHostNetwork: false }))).build).not.toHaveProperty("network");
    // a browser can send anything: only a real `true` counts
    expect(buildAppConfig(review(input({ buildHostNetwork: "true" as unknown as boolean }))).build).not.toHaveProperty("network");
  });

  it("puts build.database: true in the build block only when the build is to use the project's database, for a Dockerfile and for a preset", () => {
    expect(buildAppConfig(review(input({ buildDatabase: true }))).build).toEqual({ dockerfile: "Dockerfile", context: ".", memory: "2g", cpus: 2, timeout: "15m", database: true });
    expect(buildAppConfig(review(input({ preset: "nextjs", buildDatabase: true }))).build).toMatchObject({ preset: "nextjs", database: true });
    expect(buildAppConfig(review(input({ buildDatabase: false }))).build).not.toHaveProperty("database");
    expect(buildAppConfig(review(input({ buildDatabase: "yes" as unknown as boolean }))).build).not.toHaveProperty("database");
  });

  // Docker's default is `no`: an app that is not told otherwise stays stopped when the server reboots or Docker restarts.
  // A deployed project must come back by itself.
  it("always asks for the app to come back after the server or Docker restarts", () => {
    for (const exposure of ["domain", "local"] as const) {
      expect(buildAppConfig(review(input({ exposure }))).restart).toBe("unless-stopped");
    }
  });

  it("carries no environment values: only the path of a file on the server", () => {
    const config = buildAppConfig(review(input({ envFile: "/etc/keelson/shop.env" })));
    expect(config.env).toBeUndefined();
    expect(JSON.stringify(config)).not.toMatch(/secret|password|token/i);
  });
});
