import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/agent-types";

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {}, useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { AppForm, appFromDraft, draftFromApp } = await import("@/components/config/AppForm");

/** An app the way a server that already ran it with docker compose would declare it: nothing the form cannot keep. */
const PRODUCTION: AppConfig = {
  name: "shop",
  project: "shop",
  environment: "production",
  image: "keelson-local/shop",
  env_file: "/var/www/shop/.env",
  env: { NODE_ENV: "production" },
  network: "host",
  port: { host: [3000, 3001], env: "PORT" },
  health_path: "/api/health",
  volumes: ["/var/www/shop/shared/public/img:/app/public/img", "/var/www/shop/shared/logs:/app/logs"],
  restart: "unless-stopped",
  release: {
    steps: [
      { name: "backup", backup: "shop", timeout: "20m" },
      { name: "migrate", container: { command: ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"] }, timeout: "10m" },
    ],
  },
  build: { dockerfile: "Dockerfile.keelson", network: "host", memory: "3g", cpus: 1, timeout: "30m" },
};

describe("a release step that backs a database up", () => {
  it("survives editing and saving the app: the form writes backup, and neither host nor container", () => {
    const saved = appFromDraft(draftFromApp(PRODUCTION));
    expect(saved).toEqual(PRODUCTION);
    expect(saved.release?.steps[0]).toEqual({ name: "backup", backup: "shop", timeout: "20m" });
  });

  it("is shown as a database backup, with the database it backs up", () => {
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: PRODUCTION, existingNames: ["shop"], hasProxy: true }));
    expect(html).toContain("Database backup");
    expect(html).toMatch(/value="shop"[^>]*>/);
  });

  it("needs a database name, and leaves a step of another kind alone when it is switched", () => {
    const draft = draftFromApp(PRODUCTION);
    const blank = appFromDraft({ ...draft, steps: draft.steps.map((s, i) => (i === 0 ? { ...s, database: "" } : s)) });
    expect(blank.release?.steps[0]).toEqual({ name: "backup", backup: "", timeout: "20m" });
    const toHost = appFromDraft({ ...draft, steps: draft.steps.map((s, i) => (i === 0 ? { ...s, kind: "host", host: ["./backup.sh"] } : s)) });
    expect(toHost.release?.steps[0]).toEqual({ name: "backup", host: ["./backup.sh"], timeout: "20m" });
  });
});

describe("an app stopped on purpose (enabled: false)", () => {
  it("stays stopped when the form saves it: the form has no field for it and loses nothing", () => {
    const stopped: AppConfig = { ...PRODUCTION, enabled: false };
    expect(appFromDraft(draftFromApp(stopped))).toEqual(stopped);
    expect(appFromDraft(draftFromApp(stopped)).enabled).toBe(false);
  });

  it("adds no key to an app that runs, and shows no enabled field", () => {
    expect("enabled" in appFromDraft(draftFromApp(PRODUCTION))).toBe(false);
    const out = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: { ...PRODUCTION, enabled: false }, existingNames: ["shop"], hasProxy: true }));
    expect(out).not.toMatch(/enabled/i);
  });
});
