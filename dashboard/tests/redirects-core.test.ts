import { describe, expect, it } from "vitest";
import { activityHref, appSourceHref, appVariablesHref, appsTabHref, notificationsHref, serverActivityHref } from "@/lib/redirects-core";

describe("redirect targets", () => {
  it("leads the old Services tab to Apps", () => {
    expect(appsTabHref("shop")).toBe("/projects/shop/apps");
  });

  it("opens the Source tab on the app, encoding the pair", () => {
    expect(appSourceHref("shop", "s1", "web")).toBe("/projects/shop/source?app=s1%2Fweb");
    expect(appSourceHref("my shop", "s 1", "web&x")).toBe(`/projects/${encodeURIComponent("my shop")}/source?app=s%201%2Fweb%26x`);
  });

  it("opens the Variables tab on the app and keeps only the preview scope", () => {
    expect(appVariablesHref("shop", "s1", "web")).toBe("/projects/shop/variables?app=s1%2Fweb");
    expect(appVariablesHref("shop", "s1", "web", { scope: "preview" })).toBe("/projects/shop/variables?app=s1%2Fweb&scope=preview");
    expect(appVariablesHref("shop", "s1", "web", { scope: ["preview", "x"] })).toBe("/projects/shop/variables?app=s1%2Fweb&scope=preview");
    expect(appVariablesHref("shop", "s1", "web", { scope: "production", other: "1" })).toBe("/projects/shop/variables?app=s1%2Fweb");
  });

  it("builds the Activity address from what is set", () => {
    expect(activityHref()).toBe("/activity");
    expect(activityHref({})).toBe("/activity");
    expect(activityHref({ kind: "security" })).toBe("/activity?kind=security");
    expect(activityHref({ server: "s1", project: "shop", kind: "change" })).toBe("/activity?server=s1&project=shop&kind=change");
    expect(activityHref({ project: "my shop" })).toBe("/activity?project=my+shop");
  });

  it("leads a server's audit log to its Activity", () => {
    expect(serverActivityHref("s1")).toBe("/activity?server=s1");
  });

  it("links the notifications page, and a server's own form", () => {
    expect(notificationsHref()).toBe("/settings/notifications");
    expect(notificationsHref("s1")).toBe("/servers/s1/config/notifications");
    expect(notificationsHref("a b")).toBe("/servers/a%20b/config/notifications");
  });
});
