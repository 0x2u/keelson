import { describe, expect, it } from "vitest";
import { appRunControls, STOPPED_REASON } from "@/lib/app-run-core";

const base = { stopped: false, hasContainer: true, canDeploy: true };

describe("appRunControls", () => {
  it("offers Stop for an app that has a container and Start for one stopped on purpose", () => {
    expect(appRunControls(base)).toEqual({ stop: true, start: false });
    expect(appRunControls({ ...base, stopped: true })).toEqual({ stop: false, start: true });
    // A stopped app has a container (stopped) or none (never started again): Start is offered either way.
    expect(appRunControls({ ...base, stopped: true, hasContainer: false })).toEqual({ stop: false, start: true });
  });

  it("offers nothing for an app that was never deployed: there is nothing to stop", () => {
    expect(appRunControls({ ...base, hasContainer: false })).toEqual({ stop: false, start: false });
  });

  it("turns the offered one off, with the reason, on a read-only server and during a deployment", () => {
    expect(appRunControls({ ...base, canDeploy: false })).toMatchObject({ stop: true, reason: expect.stringContaining("deploy secret") });
    expect(appRunControls({ ...base, stopped: true, canDeploy: false })).toMatchObject({ start: true, reason: expect.stringContaining("deploy secret") });
    expect(appRunControls({ ...base, deploying: true })).toMatchObject({ stop: true, reason: expect.stringContaining("deployment is running") });
  });

  it("says why Deploy and the others are off for a stopped app", () => {
    expect(STOPPED_REASON).toBe("Stopped: start it first.");
  });
});
