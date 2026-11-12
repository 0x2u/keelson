import { ENV_KEY } from "@/lib/env-core";

// A parser for the .env files people paste or upload. Pure: it reads text and returns entries and problems, nothing else.
//
// What it understands:
//   - blank lines and `# comments`, with or without leading spaces; CRLF line ends and a leading byte-order mark;
//   - an optional `export ` before the name;
//   - `KEY=value` unquoted: trimmed, and a ` #` (a space, then #) starts a comment; a `#` inside a word stays;
//   - `KEY='value'` and KEY=`value`: taken literally, may span lines;
//   - `KEY="value"`: may span lines, and understands \n \r \t \\ \" \$ (any other backslash is kept as written);
//   - after a closing quote only spaces and a comment may follow;
//   - the same name twice: the last one wins, and the repeat is reported.
// A problem never carries a value: a line without `=` is reported by its number only, since it could be anything.

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line of the assignment that won (the last one for a repeated name). */
  line: number;
}

export interface DotenvProblem {
  line: number;
  /** The name on the line, when there was one; absent for a line without `=`. */
  key?: string;
  reason: string;
}

export interface DotenvParse {
  /** One entry per name, in the order the names first appeared, holding the last value given. */
  entries: DotenvEntry[];
  duplicates: { key: string; lines: number[] }[];
  invalid: DotenvProblem[];
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', $: "$" };
const MAX_SHOWN_NAME = 64;

/** The text of a double-quoted value with its escapes resolved. */
function unescape(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (c === "\\" && next !== undefined && next in ESCAPES) {
      out += ESCAPES[next];
      i++;
    } else out += c;
  }
  return out;
}

/** Index of the quote that closes a value opened at `from` (just after the opening quote), or -1. A double quote skips escaped characters. */
function closingQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export function parseDotenv(input: string): DotenvParse {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const seen = new Map<string, { value: string; lines: number[] }>();
  const invalid: DotenvProblem[] = [];

  let pos = 0;
  let line = 1;
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    const physical = text.slice(pos, end);
    const startLine = line;
    let next = end + 1;
    let consumedLines = 1;

    const trimmed = physical.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      // Where the name starts: after the spaces and an optional `export `.
      const prefix = /^\s*(?:export\s+)?/.exec(physical)![0].length;
      const eq = physical.indexOf("=", prefix);
      if (eq === -1) {
        invalid.push({ line: startLine, reason: "no = sign" });
      } else {
        const key = physical.slice(prefix, eq).trim();
        // Everything after the = in the text itself (a quoted value may continue on later lines).
        const restStart = pos + eq + 1;
        const rest = text.slice(restStart, end);
        const afterEq = rest.trimStart();
        const shown = key.length > MAX_SHOWN_NAME ? `${key.slice(0, MAX_SHOWN_NAME)}…` : key;
        let value: string | null = null;
        let problem: string | null = null;

        const quote = afterEq[0];
        if (quote === '"' || quote === "'" || quote === "`") {
          const valueStart = restStart + (rest.length - afterEq.length) + 1;
          const close = closingQuote(text, valueStart, quote);
          if (close === -1) {
            problem = "the quote is never closed";
          } else {
            const raw = text.slice(valueStart, close);
            let lineEnd = text.indexOf("\n", close);
            if (lineEnd === -1) lineEnd = text.length;
            const tail = text.slice(close + 1, lineEnd).trim();
            if (tail !== "" && !tail.startsWith("#")) {
              problem = "text after the closing quote";
            } else {
              value = quote === '"' ? unescape(raw) : raw;
              consumedLines = text.slice(pos, lineEnd).split("\n").length;
              next = lineEnd + 1;
            }
          }
        } else {
          // Unquoted: a comment starts at a # that follows a space.
          const comment = rest.search(/\s#/);
          value = (comment === -1 ? rest : rest.slice(0, comment)).trim();
        }

        if (key === "") problem = "no name before the = sign";
        else if (problem === null && !ENV_KEY.test(key)) problem = "not a valid name (letters, digits and _, not starting with a digit, at most 128)";

        if (problem !== null || value === null) {
          invalid.push({ line: startLine, ...(key === "" ? {} : { key: shown }), reason: problem ?? "unreadable" });
        } else {
          const known = seen.get(key);
          if (known) {
            known.value = value;
            known.lines.push(startLine);
          } else seen.set(key, { value, lines: [startLine] });
        }
      }
    }
    pos = next;
    line += consumedLines;
  }

  const entries: DotenvEntry[] = [];
  const duplicates: DotenvParse["duplicates"] = [];
  for (const [key, found] of seen) {
    entries.push({ key, value: found.value, line: found.lines[found.lines.length - 1] });
    if (found.lines.length > 1) duplicates.push({ key, lines: found.lines });
  }
  return { entries, duplicates, invalid };
}
