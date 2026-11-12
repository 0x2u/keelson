import { describe, expect, it } from "vitest";
import { fileEntities, labelText, setProjectLabels } from "@/lib/config-labels-core";

const FILE = `# the apps of this server
apps:
  # the shop
  - name: shop
    image: ghcr.io/acme/shop   # the image
    env:
      A: "1"
  - name: shop-worker
    project: shop # worker of the shop
    image: ghcr.io/acme/worker
    publish:
      - "80:80"
  - name: blog
    project: "blog"
    image: ghcr.io/acme/blog
jobs:
  - name: nightly
    project: 'shop'
    schedule: "0 3 * * *"
databases:
  - name: shopdb
    host: localhost
proxy:
  type: caddy
`;

describe("fileEntities", () => {
  it("lists the entities of the three sections with the label each writes", () => {
    expect(fileEntities(FILE)).toEqual([
      { section: "apps", name: "shop", label: null, unsupported: null },
      { section: "apps", name: "shop-worker", label: "shop", unsupported: null },
      { section: "apps", name: "blog", label: "blog", unsupported: null },
      { section: "jobs", name: "nightly", label: "shop", unsupported: null },
      { section: "databases", name: "shopdb", label: null, unsupported: null },
    ]);
  });
  it("reads a sequence that is not indented, and ignores keys inside an item's own lists", () => {
    const text = `apps:\n- name: a\n  publish:\n  - "80:80"\n  project: p\n- name: b\n  image: x\n`;
    expect(fileEntities(text).map((e) => [e.name, e.label])).toEqual([
      ["a", "p"],
      ["b", null],
    ]);
  });
  it("flags what it cannot edit instead of guessing", () => {
    const flow = fileEntities(`apps:\n  - {name: a, image: x}\n`);
    expect(flow).toEqual([{ section: "apps", name: "a", label: null, unsupported: expect.stringContaining("flow") }]);
    const merge = fileEntities(`apps:\n  - name: a\n    <<: *base\n`);
    expect(merge[0].unsupported).toContain("merge");
  });
  it("finds nothing in a file without the section, or with an empty one", () => {
    expect(fileEntities("proxy:\n  type: caddy\n")).toEqual([]);
    expect(fileEntities("apps: []\n")).toEqual([]);
  });
});

describe("setProjectLabels", () => {
  const edit = (content: string, names: { section: "apps" | "jobs" | "databases"; name: string }[], to: string) => {
    const r = setProjectLabels(content, names, to);
    if (!r.ok) throw new Error(r.reason);
    return r.content;
  };
  const diff = (a: string, b: string) => {
    const x = a.split("\n");
    const y = b.split("\n");
    return { removed: x.filter((l) => !y.includes(l)), added: y.filter((l) => !x.includes(l)) };
  };

  it("rewrites a label, keeping its quotes' kind and its comment", () => {
    const out = edit(FILE, [{ section: "apps", name: "shop-worker" }, { section: "jobs", name: "nightly" }], "store");
    expect(out).toContain("    project: store # worker of the shop\n");
    expect(out).toContain("    project: store\n    schedule");
    expect(diff(FILE, out)).toEqual({
      removed: ["    project: shop # worker of the shop", "    project: 'shop'"],
      added: ["    project: store # worker of the shop", "    project: store"],
    });
  });
  it("adds the label under the name of an app that had none, at the item's indentation", () => {
    const out = edit(FILE, [{ section: "apps", name: "shop" }, { section: "databases", name: "shopdb" }], "store");
    expect(out).toContain("  - name: shop\n    project: store\n    image: ghcr.io/acme/shop   # the image\n");
    expect(out).toContain("  - name: shopdb\n    project: store\n    host: localhost\n");
    expect(diff(FILE, out).removed).toEqual([]);
  });
  it("changes only the lines it names: comments, order and everything else stay", () => {
    const out = edit(FILE, [{ section: "apps", name: "shop" }, { section: "apps", name: "shop-worker" }, { section: "jobs", name: "nightly" }, { section: "databases", name: "shopdb" }], "store");
    expect(out.split("\n").length).toBe(FILE.split("\n").length + 2);
    expect(out.startsWith("# the apps of this server\napps:\n  # the shop\n")).toBe(true);
    expect(out).toContain('    project: "blog"\n');
  });
  it("edits a sequence that is not indented and an item whose name is not first", () => {
    const text = `apps:\n- image: x\n  name: a\n- name: b\n  image: y\n`;
    expect(edit(text, [{ section: "apps", name: "a" }, { section: "apps", name: "b" }], "p")).toBe(`apps:\n- image: x\n  name: a\n  project: p\n- name: b\n  project: p\n  image: y\n`);
  });
  it("puts the label on the dash line when it is the first key", () => {
    expect(edit(`apps:\n  - project: q\n    name: a\n`, [{ section: "apps", name: "a" }], "p")).toBe(`apps:\n  - project: p\n    name: a\n`);
  });
  it("keeps Windows line endings", () => {
    const out = edit("apps:\r\n  - name: a\r\n    image: x\r\n  - name: b\r\n    project: q\r\n", [{ section: "apps", name: "a" }, { section: "apps", name: "b" }], "p");
    expect(out).toBe("apps:\r\n  - name: a\r\n    project: p\r\n    image: x\r\n  - name: b\r\n    project: p\r\n");
  });
  it("quotes a name YAML would read as something else", () => {
    expect(labelText("store")).toBe("store");
    expect(labelText("yes")).toBe('"yes"');
    expect(labelText("2024")).toBe('"2024"');
    expect(labelText("constructor")).toBe("constructor");
  });
  it("refuses, changing nothing, an entity that is not in the file or cannot be edited", () => {
    expect(setProjectLabels(FILE, [{ section: "apps", name: "elsewhere" }], "p")).toMatchObject({ ok: false });
    expect(setProjectLabels(`apps:\n  - {name: a, image: x}\n`, [{ section: "apps", name: "a" }], "p")).toMatchObject({ ok: false });
    expect(setProjectLabels(`apps:\n  - name: a\n    <<: *base\n`, [{ section: "apps", name: "a" }], "p")).toMatchObject({ ok: false });
    expect(setProjectLabels(`apps:\n  - name: a\n    project: >\n      long\n`, [{ section: "apps", name: "a" }], "p")).toMatchObject({ ok: false });
    expect(setProjectLabels(`apps:\n  - name: a\n  - name: a\n`, [{ section: "apps", name: "a" }], "p")).toMatchObject({ ok: false });
  });
});
