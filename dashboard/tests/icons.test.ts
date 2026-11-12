import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ICONS } from "@/lib/icons";

/** Concepts that intentionally share an icon. */
const ALIASES: Record<string, string> = { deploy: "app" };

describe("ICONS", () => {
  it("gives every concept its own icon except the documented aliases", () => {
    const seen = new Map<unknown, string>();
    for (const [concept, icon] of Object.entries(ICONS)) {
      const first = seen.get(icon);
      if (first !== undefined) {
        expect(ALIASES[concept], `${concept} duplicates ${first}`).toBe(first);
      } else seen.set(icon, concept);
    }
    expect(ICONS.app).toBe(ICONS.deploy);
  });

  it("renders every icon as an svg", () => {
    for (const [concept, Icon] of Object.entries(ICONS)) {
      expect(renderToStaticMarkup(createElement(Icon)), concept).toContain("<svg");
    }
  });

  it("keeps the sidebar and the palette on the shared icons", () => {
    for (const file of ["components/shell/app-sidebar.tsx", "components/shell/command-palette.tsx"]) {
      const source = readFileSync(file, "utf8");
      const lucide = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)].map((m) => m[1]).join(",");
      expect(lucide, file).not.toMatch(/\b(LayersIcon|FolderKanbanIcon)\b/);
    }
  });
});
