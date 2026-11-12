import { describe, expect, it } from "vitest";
import type { AppStatus, ProxyView } from "@/lib/agent-types";
import { fromTab, managedDatabases, placementHosts, previewParent, appLayout } from "@/lib/project-apps-core";
import { groupProjects, type Placement } from "@/lib/projects-core";
import { projectOfReturnPath, returnCrumbs, safeReturnPath } from "@/lib/nav-core";

const s1 = { id: "s1", name: "vps-1", canDeploy: true };
const s2 = { id: "s2", name: "vps-2", canDeploy: false };
const app = (name: string, over: Partial<AppStatus> = {}): AppStatus => ({ name, image: "img", project: "shop", environment: "", digest: "", container: null, last_deployment: null, ...over });
const place = (a: AppStatus, server = s1): Placement => ({ server, app: a, jobs: [] });

describe("appLayout", () => {
  const project = groupProjects([
    place(app("shop")),
    place(app("shop-pr-4", { environment: "preview" })),
    place(app("shop-pr-9", { environment: "preview" }), { id: "s3", name: "vps-3", canDeploy: true }),
    place(app("shop", { environment: "staging" }), s2),
  ])[0];
  const layout = appLayout(project);
  it("groups previews under their parent on the same server", () => {
    const prod = layout.environments.find((e) => e.name === "production")!;
    expect(prod.rows[0].previews.map((p) => p.app.name)).toEqual(["shop-pr-4"]);
    expect(layout.environments.map((e) => e.name)).toEqual(["production", "staging"]);
  });
  it("keeps a preview without a parent on its server", () => {
    expect(layout.orphanPreviews.map((p) => p.app.name)).toEqual(["shop-pr-9"]);
  });
  it("names the parent of a preview", () => {
    expect(previewParent("shop-pr-12")).toBe("shop");
    expect(previewParent("shop")).toBeNull();
  });
});

describe("placementHosts", () => {
  const proxy = { routes: [{ kind: "app", app: "shop", domains: ["shop.example.com"] }, { kind: "app", app: "other", domains: ["o.example.com"] }], unrouted: [] } as unknown as ProxyView;
  it("filters by app and adds the domains the proxy does not list", () => {
    const hosts = placementHosts(place(app("shop", { domains: ["shop.example.com", "www.shop.example.com"] })), proxy);
    expect(hosts.map((h) => h.hostname)).toEqual(["shop.example.com", "www.shop.example.com"]);
  });
  it("is empty without domains", () => {
    expect(placementHosts(place(app("shop")), null)).toEqual([]);
  });
});

describe("fromTab", () => {
  it("is accepted by safeReturnPath once decoded", () => {
    const value = decodeURIComponent(fromTab("my shop", "apps").slice("from=".length));
    expect(safeReturnPath(value)).toBe("/projects/my%20shop/apps");
  });
});

describe("managedDatabases", () => {
  it("keeps the managed database and drops an external one", () => {
    const list = [{ db: { name: "shop", managed: true } }, { db: { name: "ext", managed: false } }, { db: { name: "declared" } }];
    expect(managedDatabases(list).map((d) => d.db.name)).toEqual(["shop"]);
    expect(managedDatabases([list[1]])).toEqual([]);
  });
});

describe("return path helpers", () => {
  it("finds the project and builds hub breadcrumbs", () => {
    expect(projectOfReturnPath("/projects/shop/apps")).toBe("shop");
    expect(projectOfReturnPath("/projects/my%20shop/domains")).toBe("my shop");
    expect(projectOfReturnPath("https://evil.example/projects/x")).toBeNull();
    expect(returnCrumbs("/projects/shop/apps", { label: "New app" })?.map((c) => c.label)).toEqual(["Projects", "shop", "Apps", "New app"]);
    expect(returnCrumbs(undefined, { label: "x" })).toBeNull();
  });
});
