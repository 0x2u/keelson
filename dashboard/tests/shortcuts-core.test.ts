import { describe, expect, it } from "vitest";
import { CHORD_TIMEOUT_MS, GO_SHORTCUTS, PALETTE_FOOTER, SHORTCUT_SHEET, createShortcuts, isTypingTarget, type KeyLike } from "@/lib/shortcuts-core";

function keys() {
  let t = 1_000;
  const shortcuts = createShortcuts(() => t);
  return {
    press: (key: string, over: Partial<KeyLike> = {}, blocked = false) => shortcuts.handle({ key, ...over }, blocked),
    wait: (ms: number) => {
      t += ms;
    },
  };
}

describe("go-to shortcuts", () => {
  it("goes to each page on g then its letter", () => {
    const k = keys();
    for (const [letter, href] of [["h", "/"], ["p", "/projects"], ["s", "/servers"], ["d", "/databases"], ["j", "/jobs"], ["a", "/activity"]]) {
      expect(k.press("g")).toEqual({ type: "pending" });
      expect(k.press(letter)).toEqual({ type: "go", href });
    }
    expect(GO_SHORTCUTS.map((g) => g.key).join("")).toBe("hpsdja");
  });
  it("needs the letter to follow g quickly, and a letter alone does nothing", () => {
    const k = keys();
    expect(k.press("h")).toBeNull();
    k.press("g");
    k.wait(CHORD_TIMEOUT_MS + 1);
    expect(k.press("h")).toBeNull();
  });
  it("is cancelled by any other key, and a second g starts again", () => {
    const k = keys();
    k.press("g");
    expect(k.press("x")).toBeNull();
    expect(k.press("h")).toBeNull();
    k.press("g");
    expect(k.press("g")).toEqual({ type: "pending" });
    expect(k.press("a")).toEqual({ type: "go", href: "/activity" });
  });
  it("ignores an unknown letter after g", () => {
    const k = keys();
    k.press("g");
    expect(k.press("z")).toBeNull();
  });
  it("opens the shortcut sheet on ?", () => {
    expect(keys().press("?", { target: { tagName: "BODY" } })).toEqual({ type: "help" });
  });
});

describe("shortcuts leave typing alone", () => {
  const typing: [string, { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null }][] = [
    ["an input", { tagName: "INPUT" }],
    ["a textarea", { tagName: "textarea" }],
    ["a select", { tagName: "SELECT" }],
    ["an editor", { tagName: "DIV", isContentEditable: true }],
    ["a textbox role", { tagName: "DIV", getAttribute: (n) => (n === "role" ? "textbox" : null) }],
    ["a combobox role", { tagName: "DIV", getAttribute: (n) => (n === "role" ? "combobox" : null) }],
  ];
  for (const [name, target] of typing) {
    it(`does nothing in ${name}`, () => {
      const k = keys();
      expect(k.press("g", { target })).toBeNull();
      expect(k.press("h", { target })).toBeNull();
      expect(k.press("?", { target })).toBeNull();
    });
  }
  it("does not complete a chord begun outside when focus moved into a field", () => {
    const k = keys();
    k.press("g");
    expect(k.press("h", { target: { tagName: "INPUT" } })).toBeNull();
  });
  it("does nothing while a dialog or the palette is open", () => {
    const k = keys();
    expect(k.press("g", {}, true)).toBeNull();
    expect(k.press("?", {}, true)).toBeNull();
  });
  it("does nothing with a modifier held (the browser's and the palette's own keys)", () => {
    const k = keys();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(k.press("g", mod)).toBeNull();
      k.press("g");
      expect(k.press("h", mod)).toBeNull();
    }
  });
  it("ignores a key held down", () => {
    const k = keys();
    expect(k.press("g", { repeat: true })).toBeNull();
  });
  it("tells what is typed in", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "A", getAttribute: () => null })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
  });
});

describe("documentation of the shortcuts", () => {
  it("lists every go-to shortcut in the sheet, and the footer mentions them", () => {
    const goTo = SHORTCUT_SHEET.find((s) => s.title === "Go to")?.items ?? [];
    expect(goTo.map((i) => i.keys.join(" "))).toEqual(GO_SHORTCUTS.map((g) => `g ${g.key}`));
    expect(SHORTCUT_SHEET.flatMap((s) => s.items).some((i) => i.keys[0] === "?")).toBe(true);
    expect(PALETTE_FOOTER).toContain("g then h p s d j a");
    expect(PALETTE_FOOTER).toContain("? shortcuts");
  });
});
