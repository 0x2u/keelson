import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { UnansweredNotice } = await import("@/components/fleet/Unreachable");
const html = (what: string, n: number) =>
  renderToStaticMarkup(createElement(UnansweredNotice, { what, servers: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `srv-${i}`, reason: "timeout" })) })).replace(/<[^>]+>/g, "");

describe("the notice about servers that did not answer", () => {
  it("agrees with its subject whatever it is, singular or plural", () => {
    expect(html("The project", 1)).toContain("The project: the part on that server is missing from this view until it answers");
    expect(html("Apps", 2)).toContain("Apps: the part on those servers is missing from this view until they answer");
  });
});
