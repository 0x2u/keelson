// Reading and rewriting the `project:` label of the apps, jobs and databases of an apps file, as text. The dashboard has no
// YAML library (it never needed one: the agent edits entities itself), and a project rename must change many entities in ONE
// save, so this is a small, deliberately strict editor: it handles block-style sequences and refuses (with a reason) anything
// it cannot change without guessing (flow style, anchors, merge keys). Comments, order and quoting of everything else stay
// byte for byte. Whatever it writes the agent validates again before it takes it.

export type LabelSection = "apps" | "jobs" | "databases";

export interface LabelEntity {
  section: LabelSection;
  name: string;
}

/** One entity of the file: its name, the label as written (null when it has none) and why it cannot be edited here, if so. */
export interface FileEntity extends LabelEntity {
  label: string | null;
  unsupported: string | null;
}

interface Item {
  start: number;
  end: number;
  keyIndent: number;
  /** key -> index of the line that holds it */
  keys: Map<string, number>;
  /** key -> the text after `key:` on that line */
  raw: Map<string, string>;
  name: string | null;
  unsupported: string | null;
}

const KEY = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+)):(?:[ \t]|$)/;
const SECTION_END = /^(?:[^\s#-]|---(?:\s|$)|\.\.\.(?:\s|$))/;
const DASH = /^(\s*)-(?:[ \t]+|$)/;
const RESERVED: Record<string, true> = { true: true, false: true, yes: true, no: true, on: true, off: true, null: true, y: true, n: true };

const indentOf = (line: string): number => line.length - line.trimStart().length;
const stripCr = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** The text of a plain or quoted scalar, without its comment; null for what is not a single-line scalar (a block, an alias, a flow). */
function scalar(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || /^[|>*&!{[]/.test(text)) return null;
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, 1);
    if (close < 0) return null;
    const inner = text.slice(1, close);
    return inner.includes("\\") ? null : inner;
  }
  const hash = text.search(/\s#/);
  return (hash < 0 ? text : text.slice(0, hash)).trim();
}

function items(lines: string[], section: LabelSection): Item[] {
  const start = lines.findIndex((l) => new RegExp(`^${section}:[ \\t]*(?:#.*)?$`).test(stripCr(l)));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_END.test(lines[i])) {
      end = i;
      break;
    }
  }
  const out: Item[] = [];
  let dash: number | null = null;
  let current: Item | null = null;
  for (let i = start + 1; i < end; i++) {
    const line = stripCr(lines[i]);
    const m = DASH.exec(line);
    if (m && (dash === null || m[1].length === dash)) {
      dash = m[1].length;
      const rest = line.slice(m[0].length);
      current = { start: i, end: end, keyIndent: rest === "" ? -1 : m[0].length, keys: new Map(), raw: new Map(), name: null, unsupported: null };
      const previous = out[out.length - 1];
      if (previous) previous.end = i;
      out.push(current);
      if (rest !== "" && /^[{[*&!]/.test(rest)) {
        current.unsupported = "it is written in flow style or with an anchor";
        current.name = /[{,]\s*name:\s*["']?([^,}"'\s]+)/.exec(rest)?.[1] ?? null;
      } else if (rest !== "") noteKey(current, i, rest);
      continue;
    }
    if (!current || line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const ind = indentOf(line);
    if (current.keyIndent < 0) current.keyIndent = ind;
    if (ind === current.keyIndent) noteKey(current, i, line.slice(ind));
  }
  return out;
}

function noteKey(item: Item, index: number, text: string): void {
  if (/^<<:/.test(text)) {
    item.unsupported = "it uses a merge key (<<)";
    return;
  }
  const m = KEY.exec(text);
  if (!m) return;
  const key = m[1] ?? m[2] ?? m[3];
  if (item.keys.has(key)) return;
  item.keys.set(key, index);
  item.raw.set(key, text.slice(m[0].length));
  if (key === "name") item.name = scalar(item.raw.get(key) ?? "");
}

/** Every entity of the three sections of an apps file, with the `project:` label each says. */
export function fileEntities(content: string): FileEntity[] {
  const lines = content.split("\n");
  const out: FileEntity[] = [];
  for (const section of ["apps", "jobs", "databases"] as const) {
    for (const item of items(lines, section)) {
      if (item.name === null) continue;
      let label: string | null = null;
      let unsupported = item.unsupported;
      const raw = item.raw.get("project");
      if (raw !== undefined) {
        label = scalar(raw);
        if (label === null && unsupported === null) unsupported = "its project label is not a single-line value";
      }
      out.push({ section, name: item.name, label, unsupported });
    }
  }
  return out;
}

/** A project name as YAML: plain when that reads back as the same string, quoted otherwise. */
export function labelText(value: string): string {
  return /^[a-z][a-z0-9_-]*$/.test(value) && !Object.hasOwn(RESERVED, value) ? value : JSON.stringify(value);
}

type Op = { line: number; replace: string } | { line: number; insertAfter: string };

/**
 * Sets `project: <to>` on each of the named entities: the label is rewritten where there is one, and added under the name
 * where there is none. Fails, changing nothing, when an entity is not in this file (it may be in a project file) or cannot be
 * edited safely.
 */
export function setProjectLabels(content: string, entities: LabelEntity[], to: string): { ok: true; content: string } | { ok: false; reason: string } {
  const lines = content.split("\n");
  const bySection = new Map<LabelSection, Item[]>();
  const ops: Op[] = [];
  const label = labelText(to);
  for (const e of entities) {
    const list = bySection.get(e.section) ?? items(lines, e.section);
    bySection.set(e.section, list);
    const matches = list.filter((i) => i.name === e.name);
    if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? `${e.name} is not in the apps file` : `${e.name} is listed twice in the apps file` };
    const item = matches[0];
    if (item.unsupported !== null) return { ok: false, reason: `${e.name} cannot be edited here: ${item.unsupported}` };
    const at = item.keys.get("project");
    if (at !== undefined) {
      const line = stripCr(lines[at]);
      const m = /^(\s*(?:-[ \t]+)?(?:"project"|'project'|project):[ \t]*)(.*)$/.exec(line);
      if (!m) return { ok: false, reason: `${e.name} cannot be edited here: its project label is not on one line` };
      const value = m[2];
      let tail: string;
      if (value[0] === '"' || value[0] === "'") {
        const close = value.indexOf(value[0], 1);
        if (close < 0) return { ok: false, reason: `${e.name} cannot be edited here: its project label is not on one line` };
        tail = value.slice(close + 1);
      } else {
        if (scalar(value) === null) return { ok: false, reason: `${e.name} cannot be edited here: its project label is not a single-line value` };
        const hash = value.search(/\s#/);
        tail = hash < 0 ? "" : value.slice(hash);
      }
      ops.push({ line: at, replace: m[1] + label + tail + (lines[at].endsWith("\r") ? "\r" : "") });
      continue;
    }
    const nameAt = item.keys.get("name");
    if (nameAt === undefined) return { ok: false, reason: `${e.name} cannot be edited here: it has no name line` };
    ops.push({ line: nameAt, insertAfter: `${" ".repeat(item.keyIndent)}project: ${label}${lines[nameAt].endsWith("\r") ? "\r" : ""}` });
  }
  for (const op of [...ops].sort((a, b) => b.line - a.line)) {
    if ("replace" in op) lines[op.line] = op.replace;
    else lines.splice(op.line + 1, 0, op.insertAfter);
  }
  return { ok: true, content: lines.join("\n") };
}
