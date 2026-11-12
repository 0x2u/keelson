import { describe, expect, it } from "vitest";
import { describeSchedule, scheduleError } from "@/lib/cron-describe";

describe("describeSchedule", () => {
  it("describes minute steps and fixed times", () => {
    expect(describeSchedule("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeSchedule("* * * * *")).toBe("Every minute");
    expect(describeSchedule("0 7 * * *")).toBe("Every day at 07:00");
    expect(describeSchedule("30 18 * * 1-5")).toBe("Every weekday at 18:30");
    expect(describeSchedule("0 4 * * 0")).toBe("Every Sunday at 04:00");
    expect(describeSchedule("15 * * * *")).toBe("Every hour at minute 15");
    expect(describeSchedule("0 3 1 * *")).toBe("On day 1 of every month at 03:00");
  });

  it("describes the @ shortcuts", () => {
    expect(describeSchedule("@hourly")).toBe("Every hour, on the hour");
    expect(describeSchedule("@daily")).toBe("Every day at 00:00");
    expect(describeSchedule("@weekly")).toBe("Every Sunday at 00:00");
  });

  it("describes @every durations", () => {
    expect(describeSchedule("@every 15m")).toBe("Every 15 minutes");
    expect(describeSchedule("@every 1h")).toBe("Every hour");
    expect(describeSchedule("@every 1h30m")).toBe("Every 1 hour 30 minutes");
  });

  it("quotes back what it cannot describe", () => {
    expect(describeSchedule("0 7 * 6 *")).toBe("Custom schedule: 0 7 * 6 *");
    expect(describeSchedule("*/90 * * * *")).toBe("Custom schedule: */90 * * * *");
    expect(describeSchedule("@every soon")).toBe("Custom schedule: @every soon");
    expect(describeSchedule("  ")).toBe("");
  });
});

describe("scheduleError", () => {
  it("accepts the supported shapes", () => {
    expect(scheduleError("*/5 * * * *")).toBeNull();
    expect(scheduleError("@daily")).toBeNull();
    expect(scheduleError("@every 15m")).toBeNull();
  });

  it("rejects everything else", () => {
    expect(scheduleError("")).not.toBeNull();
    expect(scheduleError("* * *")).not.toBeNull();
    expect(scheduleError("@sometimes")).not.toBeNull();
    expect(scheduleError("@every soon")).not.toBeNull();
  });
});
