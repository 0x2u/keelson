"use client";

import { FieldShell, describeField, TextField } from "@/components/forms/fields";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeSchedule, scheduleError } from "@/lib/cron-describe";

type SchedulePreset = "every5" | "hourly" | "daily" | "custom";

const PRESETS: { value: SchedulePreset; label: string }[] = [
  { value: "every5", label: "Every 5 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day at a set time" },
  { value: "custom", label: "Custom" },
];

const TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function timezoneError(timezone: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return undefined;
  } catch {
    return "Unknown time zone. Use an IANA name such as Europe/Paris, or UTC.";
  }
}

/** The time of day of a "M H * * *" schedule, as HH:MM for a time input; null for other schedules. */
function dailyTime(schedule: string): string | null {
  const text = schedule.trim();
  if (text.toLowerCase() === "@daily" || text.toLowerCase() === "@midnight") return "00:00";
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(text);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return null;
  return `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
}

function presetOf(schedule: string): SchedulePreset {
  const text = schedule.trim();
  if (text === "*/5 * * * *") return "every5";
  if (text === "0 * * * *" || text.toLowerCase() === "@hourly") return "hourly";
  return dailyTime(text) !== null ? "daily" : "custom";
}

/** A cron schedule: a preset, a time of day, or the expression itself, with a plain-language reading under it. */
export function ScheduleField({
  id,
  value,
  onChange,
  onBlur,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error: string | undefined;
}) {
  const preset = presetOf(value);
  const time = dailyTime(value);
  const preview = scheduleError(value) === null ? describeSchedule(value) : "";
  return (
    <FieldShell
      id={id}
      label="Schedule"
      required
      help="A cron expression (minute hour day-of-month month weekday), @hourly, @daily, or @every followed by a duration such as 15m."
      error={error}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={preset}
          onValueChange={(next) => {
            if (next === "every5") onChange("*/5 * * * *");
            if (next === "hourly") onChange("0 * * * *");
            if (next === "daily" && time === null) onChange("0 3 * * *");
          }}
        >
          <SelectTrigger className="w-60" aria-label="Schedule preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset === "daily" && (
          <Input
            type="time"
            value={time ?? "03:00"}
            onChange={(event) => {
              const [hours, minutes] = event.target.value.split(":");
              if (hours && minutes) onChange(`${Number(minutes)} ${Number(hours)} * * *`);
            }}
            aria-label="Time of day"
            className="w-32"
          />
        )}
      </div>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder="*/5 * * * *  or  @every 15m"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        {...describeField(id, true, error)}
        aria-describedby={`${id}-help ${id}-preview${error ? ` ${id}-error` : ""}`}
      />
      <p id={`${id}-preview`} aria-live="polite" className="min-h-5 text-sm font-medium">
        {preview}
      </p>
    </FieldShell>
  );
}

/** An IANA time zone with suggestions. */
export function TimezoneField({
  id,
  value,
  onChange,
  onBlur,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error: string | undefined;
}) {
  return (
    <>
      <TextField
        id={id}
        label="Time zone"
        help="An IANA name such as Europe/Paris. The schedule is read in this zone."
        error={error}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        list={`${id}-zones`}
        placeholder="UTC"
        mono
      />
      <datalist id={`${id}-zones`}>
        {TIMEZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}
