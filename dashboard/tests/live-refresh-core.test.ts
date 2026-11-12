import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Refresher, nextDelay, type RefreshState } from "@/lib/live-refresh-core";

function setup(over: { probe?: () => Promise<boolean> } = {}) {
  const calls = { refresh: 0, probe: 0 };
  const states: RefreshState[] = [];
  let visible = true;
  const r = new Refresher({
    isVisible: () => visible,
    probe: async () => {
      calls.probe++;
      return over.probe ? over.probe() : true;
    },
    refresh: () => void calls.refresh++,
    onChange: (s) => states.push(s),
  });
  return { r, calls, states, setVisible: (v: boolean) => { visible = v; r.visibilityChanged(); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the refresher", () => {
  it("refreshes every 15 s while visible, once the new data is confirmed", async () => {
    const { r, calls, states } = setup();
    r.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls.refresh).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.refresh).toBe(1);
    r.confirm();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.refresh).toBe(2);
    r.confirm();
    expect(states.every((s) => s.status === "live")).toBe(true);
    r.stop();
  });

  it("does not run while the tab is hidden, and refreshes at once when it comes back", async () => {
    const { r, calls, setVisible } = setup();
    r.start();
    setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.refresh).toBe(0);
    expect(calls.probe).toBe(0);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.refresh).toBe(1);
    r.stop();
  });

  it("goes stale and backs off when the dashboard does not answer, and recovers on the next success", async () => {
    let up = false;
    const { r, calls, states } = setup({ probe: async () => up });
    r.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(states.at(-1)).toEqual({ status: "stale", failures: 1 });
    expect(calls.refresh).toBe(0);
    // Backed off: 30 s, not 15.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls.probe).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.probe).toBe(2);
    expect(states.at(-1)).toEqual({ status: "stale", failures: 2 });
    up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.refresh).toBe(1);
    r.confirm();
    expect(states.at(-1)).toEqual({ status: "live", failures: 0 });
    r.stop();
  });

  it("counts a refresh that never delivers new data as a failure", async () => {
    const { r, states } = setup();
    r.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states.at(-1)).toEqual({ status: "stale", failures: 1 });
    r.stop();
  });

  it("treats a probe that throws as a failure", async () => {
    const { r, states } = setup({ probe: async () => { throw new Error("offline"); } });
    r.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(states.at(-1)?.status).toBe("stale");
    r.stop();
  });

  it("stops for good", async () => {
    const { r, calls } = setup();
    r.start();
    r.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.probe).toBe(0);
  });

  it("caps the back-off", () => {
    expect(nextDelay(0)).toBe(15_000);
    expect(nextDelay(1)).toBe(30_000);
    expect(nextDelay(3)).toBe(120_000);
    expect(nextDelay(10)).toBe(120_000);
  });
});
