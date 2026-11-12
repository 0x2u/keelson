// The timing of a page that keeps itself current: ask the dashboard every `intervalMs` while the tab is visible, re-render
// the server component tree, and wait to be told the new data arrived. When it does not (the dashboard is unreachable, or
// the refresh never came back) the page is "stale" and the next try backs off, so a dead server is not hammered.

export const REFRESH_INTERVAL_MS = 15_000;
const MAX_DELAY_MS = 120_000;
/** How long a refresh may take to deliver new data before it counts as failed. */
const CONFIRM_MS = 10_000;

export interface RefreshState {
  status: "live" | "stale";
  /** Consecutive failures; 0 when live. */
  failures: number;
}

export interface RefresherOptions {
  isVisible: () => boolean;
  /** Whether the dashboard itself answers. */
  probe: () => Promise<boolean>;
  /** Re-render the page's server components (router.refresh). */
  refresh: () => void;
  onChange: (state: RefreshState) => void;
  intervalMs?: number;
  maxDelayMs?: number;
  confirmMs?: number;
}

/** The delay before the next attempt after `failures` failures in a row: doubling, capped. */
export function nextDelay(failures: number, intervalMs = REFRESH_INTERVAL_MS, maxDelayMs = MAX_DELAY_MS): number {
  return failures === 0 ? intervalMs : Math.min(maxDelayMs, intervalMs * 2 ** failures);
}

export class Refresher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = true;
  private state: RefreshState = { status: "live", failures: 0 };
  private readonly intervalMs: number;
  private readonly maxDelayMs: number;
  private readonly confirmMs: number;

  constructor(private readonly o: RefresherOptions) {
    this.intervalMs = o.intervalMs ?? REFRESH_INTERVAL_MS;
    this.maxDelayMs = o.maxDelayMs ?? MAX_DELAY_MS;
    this.confirmMs = o.confirmMs ?? CONFIRM_MS;
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.confirmTimer);
    this.timer = undefined;
    this.confirmTimer = undefined;
    this.running = false;
  }

  /** The tab was hidden or shown: nothing runs while hidden, and coming back refreshes at once. */
  visibilityChanged(): void {
    if (this.stopped) return;
    if (!this.o.isVisible()) {
      clearTimeout(this.timer);
      clearTimeout(this.confirmTimer);
      this.timer = undefined;
      this.confirmTimer = undefined;
      this.running = false;
      return;
    }
    if (!this.running) void this.run();
  }

  /** The page received fresh data. */
  confirm(): void {
    if (this.stopped || !(this.running || this.state.status === "stale")) return;
    clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
    this.running = false;
    this.set({ status: "live", failures: 0 });
    this.schedule(this.intervalMs);
  }

  private set(state: RefreshState): void {
    this.state = state;
    this.o.onChange(state);
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.o.isVisible()) return;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private fail(): void {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
    this.running = false;
    const failures = this.state.failures + 1;
    this.set({ status: "stale", failures });
    this.schedule(nextDelay(failures, this.intervalMs, this.maxDelayMs));
  }

  private async run(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.o.isVisible() || this.running) return;
    this.running = true;
    let ok = false;
    try {
      ok = await this.o.probe();
    } catch {
      ok = false;
    }
    if (this.stopped || !this.running) return;
    if (!ok) return this.fail();
    this.confirmTimer = setTimeout(() => this.fail(), this.confirmMs);
    this.o.refresh();
  }
}
