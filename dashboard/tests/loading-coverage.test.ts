import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "app", "(app)");

/** Every directory under `dir` (relative to ROOT, posix separators) that holds a page.tsx. */
function pageDirs(dir = ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...pageDirs(join(dir, entry.name)));
  }
  if (existsSync(join(dir, "page.tsx"))) found.push(relative(ROOT, dir).split(sep).join("/"));
  return found.sort();
}

const PAGES = pageDirs();

/** Pages that only call redirect(): nothing is ever shown, so there is nothing to load. */
const REDIRECT_ONLY: Record<string, string> = {
  "add-app": "redirects to New project",
  "servers/[id]/add-app": "redirects to New project with the server given",
  "servers/[id]/audit": "redirects to the server's Activity",
  "projects/[project]/services": "redirects to the project's Apps tab, the old name of it",
  "servers/[id]/jobs": "redirects to the jobs list narrowed to the server",
  "servers/[id]/databases": "redirects to the databases list narrowed to the server",
};

/** Pages whose own folder holds the generic (app)/loading.tsx, which is deliberately their loading state. */
const GENERIC_LOADING: Record<string, string> = {
  "": "the home page sits at the root of (app), whose loading.tsx is its own",
};

/** The loading.tsx that covers a page: its own folder or an ancestor below app/(app). */
function coveringLoading(page: string): string | null {
  const parts = page === "" ? [] : page.split("/");
  for (let n = parts.length; n > 0; n--) {
    const dir = parts.slice(0, n).join("/");
    if (existsSync(join(ROOT, dir, "loading.tsx"))) return dir;
  }
  return null;
}

describe("loading states", () => {
  it("finds the pages", () => {
    expect(PAGES.length).toBeGreaterThan(30);
  });

  it("gives every page a specific loading.tsx, in its folder or an ancestor", () => {
    const missing = PAGES.filter((p) => !(p in REDIRECT_ONLY) && !(p in GENERIC_LOADING) && coveringLoading(p) === null);
    expect(missing).toEqual([]);
  });

  it("keeps the allow-lists honest", () => {
    for (const p of Object.keys(REDIRECT_ONLY)) {
      expect(PAGES, `${p} no longer exists`).toContain(p);
      expect(readFileSync(join(ROOT, p, "page.tsx"), "utf8"), `${p} no longer only redirects`).toContain("redirect(");
      expect(existsSync(join(ROOT, p, "loading.tsx")), `${p} has a loading.tsx: drop it from the allow-list`).toBe(false);
    }
    for (const p of Object.keys(GENERIC_LOADING)) expect(PAGES).toContain(p);
  });

  it("gives the tab frames of projects and servers an error.tsx that keeps the layout", () => {
    for (const dir of ["projects/[project]/(tabs)", "servers/[id]/(tabs)"]) {
      expect(existsSync(join(ROOT, dir, "error.tsx")), `${dir}/error.tsx`).toBe(true);
      expect(existsSync(join(ROOT, dir, "layout.tsx")), `${dir}/layout.tsx`).toBe(true);
    }
  });
});

describe("page metadata", () => {
  it("gives every dynamic page a generateMetadata, so browser tabs differ", () => {
    const dynamic = PAGES.filter((p) => p.includes("[") && !(p in REDIRECT_ONLY));
    expect(dynamic.length).toBeGreaterThan(20);
    const without = dynamic.filter((p) => !/export\s+(async\s+)?function\s+generateMetadata\b|export\s+const\s+generateMetadata\b/.test(readFileSync(join(ROOT, p, "page.tsx"), "utf8")));
    expect(without).toEqual([]);
  });
});
