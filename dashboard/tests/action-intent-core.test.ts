import { describe, expect, it } from "vitest";
import { actionIntent } from "@/lib/action-intent-core";
import { ACTION_HREFS } from "@/lib/palette-core";

/** What a page receives from a link: its path and its parsed query. */
function landing(href: string) {
  const url = new URL(href, "http://dashboard");
  return { path: url.pathname, intent: actionIntent(Object.fromEntries(url.searchParams)) };
}

describe("the pages the palette's actions open", () => {
  it("opens the deploy dialog of the app, with nothing typed in", () => {
    expect(landing(ACTION_HREFS.deploy("s1", "web"))).toEqual({ path: "/servers/s1/apps/web", intent: { deploy: "", rollback: false, runNow: false } });
  });
  it("opens the rollback confirmation of the app", () => {
    expect(landing(ACTION_HREFS.rollback("s1", "web"))).toEqual({ path: "/servers/s1/apps/web", intent: { rollback: true, runNow: false } });
  });
  it("opens the run confirmation of the job, and leaves ?run= (the run to mark) alone", () => {
    expect(landing(ACTION_HREFS.runJob("s1", "nightly"))).toEqual({ path: "/servers/s1/jobs/nightly", intent: { rollback: false, runNow: true } });
    expect(actionIntent({ run: "abc123" }).runNow).toBe(false);
    expect(actionIntent({ run: "1" }).runNow).toBe(false);
  });
  it("opens the restart confirmation, or puts the focus on Start", () => {
    expect(landing(ACTION_HREFS.restart("s1", "web-blue")).intent).toMatchObject({ container: "restart" });
    expect(landing(ACTION_HREFS.start("s1", "old")).intent).toMatchObject({ container: "start" });
    expect(landing(ACTION_HREFS.restart("s1", "a b")).path).toBe("/servers/s1/containers/a%20b");
  });
  it("keeps the link of 'Saved. Not running yet' working: ?deploy=<tag>", () => {
    expect(actionIntent({ deploy: "v1.2.3" }).deploy).toBe("v1.2.3");
    expect(actionIntent({ deploy: ["v2", "v3"] }).deploy).toBe("v2");
  });
  it("does nothing for any other value, so a page opened by hand is quiet", () => {
    expect(actionIntent({})).toEqual({ rollback: false, runNow: false });
    expect(actionIntent({ rollback: "0", runnow: "yes", restart: "true", start: "" })).toEqual({ rollback: false, runNow: false });
  });
  it("prefers restart over start when both are given", () => {
    expect(actionIntent({ start: "1", restart: "1" }).container).toBe("restart");
  });
});
