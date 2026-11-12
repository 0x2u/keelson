import { describe, expect, it } from "vitest";
import { UPDATE_WATCH_MS, updateMessage, updateProgress, type UpdateObservation } from "@/lib/relay-update-core";

const base: UpdateObservation = { bundled: "v0.2.0", running: "v0.1.0", connectedAt: 1_000, since: 5_000, watchFrom: 5_000, now: 6_000 };

describe("the progress of an update run on the server", () => {
  it("is updated when the agent reports the version this dashboard carries, after it connected again", () => {
    const p = updateProgress({ ...base, running: "v0.2.0", connectedAt: 5_500 });
    expect(p).toEqual({ state: "updated", version: "v0.2.0" });
    expect(updateMessage(p)).toBe("Updated to v0.2.0");
  });

  it("keeps waiting while the agent reports the older version, and says which", () => {
    const p = updateProgress(base);
    expect(p).toEqual({ state: "waiting", running: "v0.1.0" });
    expect(updateMessage(p)).toBe("Still on v0.1.0, waiting");
  });

  it("keeps waiting while the agent does not answer: it restarts during the update", () => {
    const p = updateProgress({ ...base, running: null, connectedAt: null });
    expect(p).toEqual({ state: "waiting", running: null });
    expect(updateMessage(p)).toBe("Waiting for the server to answer");
  });

  it("does not call an update done that never happened: the server already ran this version before the command was run", () => {
    expect(updateProgress({ ...base, running: "v0.2.0", connectedAt: 1_000 })).toEqual({ state: "waiting", running: "v0.2.0" });
  });

  it("does not call it done when the agent restarted but still reports another version", () => {
    expect(updateProgress({ ...base, connectedAt: 5_500 })).toEqual({ state: "waiting", running: "v0.1.0" });
  });

  it("gives up after five minutes of waiting, with what to do", () => {
    const late = { ...base, now: base.watchFrom + UPDATE_WATCH_MS };
    const p = updateProgress(late);
    expect(p).toEqual({ state: "timeout", running: "v0.1.0" });
    expect(updateMessage(p)).toBe("Not updated yet: run the command on the server and check its output");
    expect(updateProgress({ ...late, now: late.now - 1 }).state).toBe("waiting");
  });

  it("counts the five minutes from when the page began to wait again, not from when the command was made", () => {
    const again = { ...base, since: 5_000, watchFrom: 5_000 + UPDATE_WATCH_MS, now: 5_000 + UPDATE_WATCH_MS + 1_000 };
    expect(updateProgress(again).state).toBe("waiting");
  });

  it("still reports an update that finished at the last moment", () => {
    expect(updateProgress({ ...base, running: "v0.2.0", connectedAt: 9_000, now: base.watchFrom + UPDATE_WATCH_MS + 1 }).state).toBe("updated");
  });

  it("goes by the restart alone when this dashboard does not know its own agent version", () => {
    expect(updateProgress({ ...base, bundled: null, running: "v0.3.0", connectedAt: 5_500 })).toEqual({ state: "updated", version: "v0.3.0" });
    expect(updateProgress({ ...base, bundled: null, running: "v0.3.0", connectedAt: 1_000 }).state).toBe("waiting");
  });
});
