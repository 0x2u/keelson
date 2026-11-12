import { describe, expect, it } from "vitest";
import { duration, formatBytes, healthFromStatus, publishedPorts, relativeTimeTick, shortRef, timeAgo, timeUntil } from "@/lib/format";

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(433602560)).toBe("414 MiB");
  });

  it("formats elapsed time", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(timeAgo("2026-01-01T11:59:58Z", now)).toBe("just now");
    expect(timeAgo("2026-01-01T11:59:30Z", now)).toBe("30 s ago");
    expect(timeAgo("2026-01-01T11:50:00Z", now)).toBe("10 min ago");
    expect(timeAgo("2026-01-01T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2025-12-25T12:00:00Z", now)).toBe("7 d ago");
    expect(duration("2026-01-01T12:00:00Z", "2026-01-01T12:00:12Z")).toBe("12 s");
    expect(duration("2026-01-01T12:00:00Z", "2026-01-01T12:03:05Z")).toBe("3 min 5 s");
  });

  it("shortens image references", () => {
    expect(shortRef("ghcr.io/me/web:v1")).toBe("me/web:v1");
    expect(shortRef("nginx:alpine")).toBe("nginx:alpine");
    expect(shortRef(`ghcr.io/me/web@sha256:${"ab".repeat(32)}`)).toBe("web@abababababab");
  });

  it("reads health out of Docker's status text", () => {
    expect(healthFromStatus("Up 3 minutes (healthy)")).toBe("healthy");
    expect(healthFromStatus("Up 5 seconds (health: starting)")).toBe("starting");
    expect(healthFromStatus("Up 1 hour (unhealthy)")).toBe("unhealthy");
    expect(healthFromStatus("Up 2 days")).toBeUndefined();
    expect(healthFromStatus("Exited (0) 3 hours ago")).toBeUndefined();
  });
});

describe("publishedPorts", () => {
  it("lists each host mapping once, whatever the address family", () => {
    const ports = [
      { public_port: 8000, private_port: 8000 },
      { public_port: 8000, private_port: 8000 }, // the IPv6 twin
      { public_port: 9443, private_port: 9443 },
      { private_port: 9000 }, // exposed, not published
    ];
    expect(publishedPorts(ports)).toBe("8000→8000, 9443→9443");
    expect(publishedPorts([])).toBe("");
  });
});

describe("timeUntil", () => {
  it("describes a future instant", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(timeUntil("2026-01-01T11:59:00Z", now)).toBe("due now");
    expect(timeUntil("2026-01-01T12:00:30Z", now)).toBe("in 30 s");
    expect(timeUntil("2026-01-01T12:07:00Z", now)).toBe("in 7 min");
    expect(timeUntil("2026-01-01T16:00:00Z", now)).toBe("in 4 h");
    expect(timeUntil("2026-01-05T12:00:00Z", now)).toBe("in 4 d");
  });
});

describe("relativeTimeTick", () => {
  const now = Date.parse("2026-10-23T10:00:00Z");
  it("redraws every second while the instant is under two minutes away, in the past or the future", () => {
    expect(relativeTimeTick("2026-10-23T09:59:48Z", now)).toBe(1_000);
    expect(relativeTimeTick("2026-10-23T10:00:30Z", now)).toBe(1_000);
  });
  it("slows down to 30 s once minutes are what is shown", () => {
    expect(relativeTimeTick("2026-10-23T09:50:00Z", now)).toBe(30_000);
  });
});
