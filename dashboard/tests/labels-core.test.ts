import { describe, expect, it } from "vitest";
import { humanise, triggerLabel } from "@/lib/labels-core";

describe("triggerLabel", () => {
  it("never shows a raw code for the triggers the agent sets", () => {
    expect(triggerLabel("api")).toBe("Dashboard or API");
    expect(triggerLabel("build")).toBe("Deployed from source");
    expect(triggerLabel("transfer")).toBe("Built on another server");
    expect(triggerLabel("preview")).toBe("Pull request preview");
    expect(triggerLabel("promotion")).toBe("Promote");
    expect(triggerLabel("rollback")).toBe("Roll back");
    expect(triggerLabel("webhook")).toBe("GitHub webhook");
    expect(triggerLabel("cli")).toBe("Command line");
    expect(triggerLabel("schedule")).toBe("Schedule");
    expect(triggerLabel("manual")).toBe("Run now");
  });
  it("names the machine that built an image that was sent, when it is known", () => {
    expect(triggerLabel("transfer", "builder-1")).toBe("Deployed from source (built on builder-1)");
    expect(triggerLabel("build", "builder-1")).toBe("Deployed from source");
  });
  it("makes a readable label from a code it does not know", () => {
    expect(triggerLabel("post_merge")).toBe("Post merge");
    expect(humanise("a.b-c")).toBe("A b c");
  });
});
