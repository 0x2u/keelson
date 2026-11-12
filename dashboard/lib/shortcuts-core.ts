// Keyboard shortcuts that work from anywhere in the dashboard: "g" then a letter goes to a page, "?" lists them. They never
// act while you type (in a field, a select, an editor) or while a dialog is open, and never with a modifier held, so they
// cannot get in the way of the browser's or the page's own keys. Pure: the provider feeds it the keyboard events.

/** The pages "g" goes to, by the letter that follows. */
export const GO_SHORTCUTS: { key: string; label: string; href: string }[] = [
  { key: "h", label: "Home", href: "/" },
  { key: "p", label: "Projects", href: "/projects" },
  { key: "s", label: "Servers", href: "/servers" },
  { key: "d", label: "Databases", href: "/databases" },
  { key: "j", label: "Jobs", href: "/jobs" },
  { key: "a", label: "Activity", href: "/activity" },
];

/** How long "g" waits for the letter after it. */
export const CHORD_TIMEOUT_MS = 1500;

/** The sections of the shortcuts sheet, and the footer of the palette says the same in one line. */
export const SHORTCUT_SHEET: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: "Anywhere",
    items: [
      { keys: ["⌘", "K"], label: "Open the command palette (Ctrl K on Windows and Linux)" },
      { keys: ["?"], label: "Show this list" },
    ],
  },
  { title: "Go to", items: GO_SHORTCUTS.map((g) => ({ keys: ["g", g.key], label: g.label })) },
  {
    title: "In the command palette",
    items: [
      { keys: ["↑", "↓"], label: "Move through the results" },
      { keys: ["↵"], label: "Open the selected one" },
      { keys: ["Esc"], label: "Close" },
    ],
  },
];

export const PALETTE_FOOTER = "↑↓ move · ↵ open · esc close · g then h p s d j a go to · ? shortcuts";

/** What of a key event the shortcuts read: an event, or a stand-in for one. */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: TargetLike | null;
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const TYPING_ROLES = new Set(["textbox", "combobox", "searchbox", "spinbutton"]);

/** Whether the key goes to something you type in. */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (TYPING_TAGS.has((target.tagName ?? "").toUpperCase())) return true;
  if (target.isContentEditable === true) return true;
  const role = target.getAttribute?.("role");
  return role !== null && role !== undefined && TYPING_ROLES.has(role);
}

export type ShortcutResult = { type: "go"; href: string } | { type: "help" } | { type: "pending" } | null;

/**
 * A shortcut recogniser. `handle` returns what the key means: "pending" after a "g" (the next key completes it), a page to
 * go to, "help" for "?", or null when the key is not for the shortcuts (and must be left alone). `blocked` is true while a
 * dialog or the palette is open.
 */
export function createShortcuts(now: () => number = Date.now): { handle: (e: KeyLike, blocked?: boolean) => ShortcutResult } {
  let armedAt: number | null = null;
  return {
    handle(e, blocked = false) {
      const armed = armedAt !== null && now() - armedAt <= CHORD_TIMEOUT_MS;
      armedAt = null;
      if (blocked || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return null;
      if (e.key === "?") return { type: "help" };
      if (armed && !e.repeat) {
        const go = GO_SHORTCUTS.find((g) => g.key === e.key);
        if (go) return { type: "go", href: go.href };
      }
      if (e.key === "g" && !e.repeat) {
        armedAt = now();
        return { type: "pending" };
      }
      return null;
    },
  };
}
