import { describe, expect, it } from "vitest";
import { entityMetadata, entityTitle, routeName } from "@/lib/metadata";

describe("page titles for one thing", () => {
  it("puts the name first and the places it lives after it", () => {
    expect(entityTitle("web", "staging", "Apps")).toBe("web · staging · Apps");
  });

  it("drops empty and missing parts", () => {
    expect(entityTitle("web", undefined, "  ", "vps-1")).toBe("web · vps-1");
    expect(entityTitle("web")).toBe("web");
  });

  it("is the metadata object of the page", () => {
    expect(entityMetadata("shop", "Project")).toEqual({ title: "shop · Project" });
  });

  it("decodes route parameters and keeps a malformed escape", () => {
    expect(routeName("my%20app")).toBe("my app");
    expect(routeName("50%")).toBe("50%");
  });
});
