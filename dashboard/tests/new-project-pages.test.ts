import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-np-pages-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
  usePathname: () => "/",
  useRouter: () => ({ refresh() {}, push() {} }),
}));
vi.mock("@/lib/server-data", () => ({ serverApps: async () => ({ data: [] }), serverAnswers: async () => true }));

const { default: AddAppRedirect } = await import("@/app/(app)/add-app/page");
const { default: ServerAddAppRedirect } = await import("@/app/(app)/servers/[id]/add-app/page");
const { AppsSection } = await import("@/components/servers/ServerOverview");
const { TooltipProvider } = await import("@/components/ui/tooltip");

async function destination(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { to?: string }).to ?? null;
  }
}

describe("the old Add app from GitHub addresses", () => {
  it("/add-app goes to the new project page with its repository and server", async () => {
    expect(await destination(AddAppRedirect({ searchParams: Promise.resolve({}) }))).toBe("/projects/new");
    expect(await destination(AddAppRedirect({ searchParams: Promise.resolve({ repo: "acme/shop", server: "s1" }) }))).toBe("/projects/new?server=s1&repo=acme%2Fshop");
  });

  it("/servers/<id>/add-app goes there with that server given, and the repository when it had one", async () => {
    expect(await destination(ServerAddAppRedirect({ params: Promise.resolve({ id: "s1" }), searchParams: Promise.resolve({}) }))).toBe("/projects/new?server=s1");
    expect(await destination(ServerAddAppRedirect({ params: Promise.resolve({ id: "s 1" }), searchParams: Promise.resolve({ repo: "acme/shop" }) }))).toBe("/projects/new?server=s+1&repo=acme%2Fshop");
  });
});

describe("the server's one Add app", () => {
  it("goes to New project with the server given when there is no project to add the app to", async () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, await AppsSection({ serverId: "s1", canDeploy: true })));
    expect(html).toContain('href="/projects/new?server=s1"');
    expect(html).not.toContain("Add manually");
    expect(html).not.toContain("Add app from GitHub");
  });
});
