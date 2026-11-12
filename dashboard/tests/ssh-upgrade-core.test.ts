import { describe, expect, it } from "vitest";
import { UPGRADE_MAY_STILL_RUN, UPGRADE_TIMEOUT_MS, upgradeTimeoutOutcome } from "@/lib/ssh-upgrade-core";

describe("the update over SSH", () => {
  it("waits longer than the agent takes to stop: its drain lasts up to 180 s", () => {
    expect(UPGRADE_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000);
  });

  it("counts an update as done when the agent, asked once more, runs the version this dashboard carries", () => {
    expect(upgradeTimeoutOutcome("v0.2.0", "v0.2.0")).toEqual({ finished: true, version: "v0.2.0" });
    expect(upgradeTimeoutOutcome("v0.2.0\n", " v0.2.0 ")).toEqual({ finished: true, version: "v0.2.0" });
  });

  it("says the update may still be running when the agent does not answer or runs another version", () => {
    expect(upgradeTimeoutOutcome(null, "v0.2.0")).toEqual({ finished: false, message: UPGRADE_MAY_STILL_RUN });
    expect(upgradeTimeoutOutcome("v0.1.0", "v0.2.0")).toEqual({ finished: false, message: UPGRADE_MAY_STILL_RUN });
    expect(upgradeTimeoutOutcome("", "v0.2.0").finished).toBe(false);
    expect(UPGRADE_MAY_STILL_RUN).toContain("wait a minute and open the server again");
  });

  it("takes whatever the agent answers when this dashboard does not know its own agent version", () => {
    expect(upgradeTimeoutOutcome("v0.3.0", null)).toEqual({ finished: true, version: "v0.3.0" });
    expect(upgradeTimeoutOutcome(null, null).finished).toBe(false);
  });
});
