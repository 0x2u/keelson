// How often a job schedule fires, as far as the dashboard needs to know: to tell a backup that is merely waiting for its
// next run from one that has missed several. The agent is the authority on what a schedule means; an expression this
// cannot read gives null and the caller skips the check instead of guessing.

const MINUTE = 60_000;

const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** How far ahead the scan looks for the next firings: a yearly schedule needs more than a year to show two of them. */
const HORIZON_DAYS = 800;
/** How many consecutive firings are compared: "0 9 * * 1-5" has gaps of 1 and 3 days, and the longest counts. */
const FIRINGS = 8;

function parseValue(text: string, names: string[], offset: number): number | null {
  const named = names.indexOf(text.toLowerCase());
  if (named >= 0) return named + offset;
  return /^\d+$/.test(text) ? Number(text) : null;
}

function parseField(field: string, min: number, max: number, names: string[], nameOffset: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || part === "") return null;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max;
    } else {
      const [a, b, more] = range.split("-");
      if (more !== undefined) return null;
      const from = parseValue(a, names, nameOffset);
      const to = b === undefined ? (stepText === undefined ? from : max) : parseValue(b, names, nameOffset);
      if (from === null || to === null) return null;
      lo = from;
      hi = to;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** "@every 1h30m" → milliseconds, or null. */
function parseEvery(text: string): number | null {
  if (!/^(\d+(h|m|s))+$/.test(text)) return null;
  let ms = 0;
  for (const m of text.matchAll(/(\d+)(h|m|s)/g)) ms += Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000);
  return ms > 0 ? ms : null;
}

/**
 * The longest gap between two consecutive firings of a schedule (UTC is assumed: a time zone shifts the hours, not the
 * period), in milliseconds; null when the expression is not understood or fires less than twice in over two years.
 */
export function schedulePeriodMs(schedule: string, from: number = Date.UTC(2026, 0, 1)): number | null {
  const spec = schedule.trim();
  if (spec.startsWith("@every")) return parseEvery(spec.slice("@every".length).trim());
  const fields = (DESCRIPTORS[spec] ?? spec).split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59, [], 0);
  const hour = parseField(fields[1], 0, 23, [], 0);
  const dom = parseField(fields[2], 1, 31, [], 0);
  const month = parseField(fields[3], 1, 12, MONTHS, 1);
  const dowRaw = parseField(fields[4], 0, 7, WEEKDAYS, 0);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => d % 7));
  const domStar = fields[2].startsWith("*") || fields[2] === "?";
  const dowStar = fields[4].startsWith("*") || fields[4] === "?";

  const dayMatches = (t: Date): boolean => {
    if (!month.has(t.getUTCMonth() + 1)) return false;
    const d = dom.has(t.getUTCDate());
    const w = dow.has(t.getUTCDay());
    // Classic cron: when both day fields are restricted either may match; otherwise the restricted one decides.
    return domStar || dowStar ? d && w : d || w;
  };

  const hours = [...hour].sort((x, y) => x - y);
  const minutes = [...minute].sort((x, y) => x - y);
  const DAY = 24 * 60 * MINUTE;
  const firstDay = Math.floor(from / DAY) * DAY;
  const fired: number[] = [];
  for (let day = firstDay; day < from + HORIZON_DAYS * DAY && fired.length < FIRINGS + 1; day += DAY) {
    if (!dayMatches(new Date(day))) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = day + (h * 60 + m) * MINUTE;
        if (at >= from && fired.length < FIRINGS + 1) fired.push(at);
      }
    }
  }
  if (fired.length < 2) return null;
  let longest = 0;
  for (let i = 1; i < fired.length; i++) longest = Math.max(longest, fired[i] - fired[i - 1]);
  return longest;
}
