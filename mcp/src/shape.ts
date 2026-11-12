import { randomBytes } from "node:crypto";

/**
 * Output shaping: what a tool returns to the model.
 *
 * - Compact JSON, bounded: long arrays and strings are cut and every cut is listed in `truncated`.
 * - Untrusted text (logs, events, commit messages, audit details, anything a user or an attacker can write) is
 *   wrapped in a delimited block whose delimiter carries a random id, so it cannot close its own block.
 */

export const MAX_ITEMS = 100;
export const MAX_STRING = 4000;
export const MAX_OUTPUT = 100_000;
const MAX_NOTES = 20;
const MAX_DEPTH = 12;
/** A string that is not a known free-text field is still wrapped when it looks like prose. */
const MAX_PLAIN_STRING = 200;

/** Fields whose value is text written by someone else: log lines, messages, errors, commit data, branch names... */
const FREE_TEXT_KEYS = new Set([
  "line",
  "lines",
  "logs",
  "message",
  "output",
  "detail",
  "details",
  "error",
  "live_error",
  "reason",
  "generated",
  "command",
  "commit",
  "commit_message",
  "title",
  "subject",
  "description",
  "body",
  "summary",
  "branch",
  "author",
  "actor",
  "note",
  "text",
  "path",
  "events_text",
]);
/** Objects whose every value is free text. */
const FREE_TEXT_OBJECTS = new Set(["labels"]);
/** For these, the end of the text matters more than the start. */
const KEEP_TAIL_KEYS = new Set(["logs", "events_text"]);

export interface ShapeOptions {
  maxItems?: number;
  maxString?: number;
  maxOutput?: number;
  /** Delimiter id; random per call unless a test pins it. */
  nonce?: string;
}

export function newNonce(): string {
  return randomBytes(6).toString("hex");
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// C0 controls except tab and newline, DEL, and the bidirectional overrides that make text read differently from how it is stored.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export function sanitize(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "");
}

/** Wraps text in a block that says what it is; a copy of the delimiter inside the text is defused. */
export function untrusted(text: string, nonce: string): string {
  const defused = text.replace(/<(\/?)untrusted/gi, "<$1_untrusted");
  return `<untrusted:${nonce}>\n${defused}\n</untrusted:${nonce}>`;
}

class Notes {
  private readonly list: string[] = [];
  private extra = 0;
  add(note: string): void {
    if (this.list.length < MAX_NOTES) this.list.push(note);
    else this.extra++;
  }
  toArray(): string[] {
    return this.extra ? [...this.list, `and ${this.extra} more cuts`] : this.list;
  }
}

function cut(text: string, max: number, tail: boolean): string {
  if (text.length <= max) return text;
  return tail ? text.slice(text.length - max) : text.slice(0, max);
}

function walk(value: unknown, path: string, key: string, free: boolean, o: Required<ShapeOptions>, notes: Notes, depth: number): unknown {
  if (typeof value === "string") {
    const clean = sanitize(value);
    const isFree = free || FREE_TEXT_KEYS.has(key);
    if (!isFree && clean.length <= MAX_PLAIN_STRING && !clean.includes("\n")) return clean;
    if (clean === "") return clean;
    const tail = KEEP_TAIL_KEYS.has(key);
    const kept = cut(clean, o.maxString, tail);
    if (kept.length < clean.length) {
      notes.add(`${path}: kept the ${tail ? "last" : "first"} ${kept.length} of ${clean.length} characters`);
    }
    return untrusted(kept, o.nonce);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) {
    notes.add(`${path}: nested too deeply, omitted`);
    return "[omitted]";
  }
  if (Array.isArray(value)) {
    let items = value;
    if (value.length > o.maxItems) {
      items = value.slice(0, o.maxItems);
      notes.add(`${path}: showing ${o.maxItems} of ${value.length} items`);
    }
    return items.map((item, i) => walk(item, `${path}[${i}]`, key, free, o, notes, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = walk(v, path ? `${path}.${k}` : k, k, free || FREE_TEXT_OBJECTS.has(k), o, notes, depth + 1);
  }
  return out;
}

/**
 * Shapes `value` into the text a tool returns: `{"data": ..., "truncated": [...]}` (`truncated` only when something was cut).
 * If the result is still larger than `maxOutput`, the limits are halved until it fits.
 */
export function shape(value: unknown, options: ShapeOptions = {}): string {
  const base: Required<ShapeOptions> = {
    maxItems: options.maxItems ?? MAX_ITEMS,
    maxString: options.maxString ?? MAX_STRING,
    maxOutput: options.maxOutput ?? MAX_OUTPUT,
    nonce: options.nonce ?? newNonce(),
  };
  let o = base;
  let text = "";
  for (let round = 0; round < 8; round++) {
    const notes = new Notes();
    const data = walk(value, "", "", false, o, notes, 0);
    const cuts = notes.toArray();
    text = JSON.stringify(cuts.length ? { data, truncated: cuts } : { data });
    if (text.length <= base.maxOutput) return text;
    o = { ...o, maxItems: Math.max(3, Math.floor(o.maxItems / 2)), maxString: Math.max(200, Math.floor(o.maxString / 2)) };
  }
  // Last resort: a hard cut of the text itself, reported as such.
  return JSON.stringify({
    data: untrusted(sanitize(text.slice(0, base.maxOutput - 1000)), base.nonce),
    truncated: [`output: cut at ${base.maxOutput - 1000} of ${text.length} characters`],
  });
}
