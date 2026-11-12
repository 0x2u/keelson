import { describe, expect, it } from "vitest";
import { actionIntent } from "@/lib/action-intent-core";
import { addAppFromServerHref, addAppHref, addEnvironmentHref, newAppOnServerHref } from "@/lib/project-actions-core";
import { safeReturnPath } from "@/lib/nav-core";

const landing = (href: string) => {
  const url = new URL(href, "http://dashboard");
  return { path: url.pathname, intent: actionIntent(Object.fromEntries(url.searchParams)) };
};

describe("the links that open a project's Add dialogs", () => {
  it("point at the Apps tab with the dialog to open", () => {
    expect(addAppHref("shop")).toBe("/projects/shop/apps?add=app");
    expect(addEnvironmentHref("shop")).toBe("/projects/shop/apps?add=environment");
  });
  it("encode the project name", () => {
    expect(addAppHref("my shop")).toBe("/projects/my%20shop/apps?add=app");
  });
  it("are what the Apps tab reads as its intent", () => {
    expect(landing(addAppHref("shop"))).toMatchObject({ path: "/projects/shop/apps", intent: { add: "app" } });
    expect(landing(addEnvironmentHref("shop"))).toMatchObject({ path: "/projects/shop/apps", intent: { add: "environment" } });
    expect(actionIntent({ add: "everything" })).not.toHaveProperty("add");
    expect(actionIntent({})).not.toHaveProperty("add");
  });
});

describe("where Add app ends", () => {
  it("is the form of a new app, back to the project's Apps tab", () => {
    const href = newAppOnServerHref("s1", "shop");
    expect(href).toBe("/servers/s1/config/apps/new?from=%2Fprojects%2Fshop%2Fapps");
    const from = new URL(href, "http://x").searchParams.get("from");
    expect(safeReturnPath(from ?? undefined)).toBe("/projects/shop/apps");
  });
  it("from a server is that form for an existing project, and New project for a new one", () => {
    expect(addAppFromServerHref("s1", "shop")).toBe(newAppOnServerHref("s1", "shop"));
    expect(addAppFromServerHref("s1", null)).toBe("/projects/new?server=s1");
  });
});
