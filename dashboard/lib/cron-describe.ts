// Plain-English descriptions of job schedules. Only the common forms are described; the agent is the authority on what
// is valid, so everything else falls back to showing the expression.

const PREDEFINED: Record<string, string> = {
  "@yearly": "Every year on January 1 at 00:00",
  "@annually": "Every year on January 1 at 00:00",
  "@monthly": "On the 1st of every month at 00:00",
  "@weekly": "Every Sunday at 00:00",
  "@daily": "Every day at 00:00",
  "@midnight": "Every day at 00:00",
  "@hourly": "Every hour, on the hour",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const EVERY_UNITS: Record<string, string> = { h: "hour", m: "minute", s: "second" };

const DURATION_PART = /(\d+)(h|m|s)/g;

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function integer(field: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
}

function describeEvery(rest: string): string | null {
  const text = rest.trim();
  if (!/^(\d+[hms])+$/.test(text)) return null;
  const parts = [...text.matchAll(DURATION_PART)].map((m) => ({ n: Number(m[1]), unit: EVERY_UNITS[m[2]] }));
  if (parts.length === 0 || parts.some((p) => p.n === 0)) return null;
  if (parts.length === 1) {
    const [{ n, unit }] = parts;
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  }
  return `Every ${parts.map((p) => `${p.n} ${plural(p.n, p.unit)}`).join(" ")}`;
}

function describeFields(fields: string[]): string | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (month !== "*") return null;

  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    if (minute === "*") return "Every minute";
    const step = /^\*\/(\d{1,2})$/.exec(minute);
    if (step) {
      const n = Number(step[1]);
      if (n === 1) return "Every minute";
      return n > 1 && n < 60 ? `Every ${n} minutes` : null;
    }
    const m = integer(minute, 59);
    if (m === null) return null;
    return m === 0 ? "Every hour, on the hour" : `Every hour at minute ${m}`;
  }

  const m = integer(minute, 59);
  const h = integer(hour, 23);
  if (m === null || h === null) return null;
  const at = clock(h, m);

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}`;
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Every weekday at ${at}`;
  if (dayOfMonth === "*") {
    const d = integer(dayOfWeek, 7);
    return d === null ? null : `Every ${WEEKDAYS[d % 7]} at ${at}`;
  }
  if (dayOfWeek === "*") {
    const d = integer(dayOfMonth, 31);
    return d === null || d === 0 ? null : `On day ${d} of every month at ${at}`;
  }
  return null;
}

/** A sentence for a schedule: five-field cron, an `@` shortcut or `@every <duration>`. Unknown forms are quoted back. */
export function describeSchedule(schedule: string): string {
  const text = schedule.trim();
  if (text === "") return "";
  const predefined = PREDEFINED[text.toLowerCase()];
  if (predefined) return predefined;
  if (/^@every\s/i.test(text)) {
    return describeEvery(text.slice("@every".length)) ?? `Custom schedule: ${text}`;
  }
  const fields = text.split(/\s+/);
  if (fields.length === 5) {
    const described = describeFields(fields);
    if (described) return described;
  }
  return `Custom schedule: ${text}`;
}

/** Why a schedule cannot be valid, from its shape alone; null when it looks like a schedule. */
export function scheduleError(schedule: string): string | null {
  const text = schedule.trim();
  if (text === "") return "Enter a schedule.";
  if (text.startsWith("@")) {
    if (PREDEFINED[text.toLowerCase()]) return null;
    if (/^@every\s+(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/i.test(text)) return null;
    return "Use @hourly, @daily, @weekly, @monthly, @yearly or @every followed by a duration such as 15m.";
  }
  return text.split(/\s+/).length === 5 ? null : "A cron schedule has five fields: minute hour day-of-month month day-of-week.";
}
