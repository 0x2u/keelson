import { describe, expect, it } from "vitest";
import type { DatabaseBackup } from "@/lib/agent-types";
import { defaultRestoreTarget, extractIdentity, OVERWRITE_HELP, overwriteConfirmation, restoreProblems, restoreRequest, TARGET_PATTERN, type RestoreDraft } from "@/lib/database-restore";

const KEY = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
const backups: DatabaseBackup[] = [{ key: "shop/shop-20260101T030000Z.dump.age", name: "shop-20260101T030000Z.dump.age", size_bytes: 10, created_at: "2026-01-01T03:00:00Z" }];

function draft(over: Partial<RestoreDraft> = {}): RestoreDraft {
  return { backup: backups[0].key, identity: KEY, target: "shop_restore_20260101", overwrite: false, confirm: "", ...over };
}

describe("default restore target", () => {
  it("is the database name, _restore_ and the UTC day", () => {
    expect(defaultRestoreTarget("shop", new Date("2026-01-01T23:59:59Z"))).toBe("shop_restore_20260101");
  });

  it("is always a name the agent accepts", () => {
    for (const name of ["shop-eu", "9lives", "a".repeat(63), "my.db"]) {
      expect(defaultRestoreTarget(name, new Date("2026-03-04T00:00:00Z"))).toMatch(TARGET_PATTERN);
    }
  });
});

describe("pasted identity", () => {
  it("takes the key out of a whole age-keygen file", () => {
    const file = `# created: 2026-01-01T00:00:00Z\n# public key: age1abc\n${KEY}\n`;
    expect(extractIdentity(file)).toBe(KEY);
  });

  it("takes the key out of a file a single-line field flattened", () => {
    expect(extractIdentity(`# created: 2026-01-01T00:00:00Z# public key: age1abc${KEY}`)).toBe(KEY);
  });

  it("finds nothing in a public key", () => {
    expect(extractIdentity("age1qqqqqqqq")).toBe("");
  });
});

describe("restore form", () => {
  it("accepts a restore into a new database", () => {
    expect(restoreProblems(draft(), "shop", backups)).toEqual({});
  });

  it("refuses a missing backup, a bad key and a bad name", () => {
    const problems = restoreProblems(draft({ backup: "", identity: "age1xyz", target: "1bad-name" }), "shop", backups);
    expect(Object.keys(problems).sort()).toEqual(["backup", "identity", "target"]);
  });

  it("refuses the live database as a plain target", () => {
    expect(restoreProblems(draft({ target: "shop" }), "shop", backups).target).toMatch(/live database/);
  });

  it("gates the overwrite on typing the database name exactly", () => {
    expect(restoreProblems(draft({ overwrite: true }), "shop", backups).confirm).toBeDefined();
    expect(restoreProblems(draft({ overwrite: true, confirm: "Shop" }), "shop", backups).confirm).toBeDefined();
    expect(restoreProblems(draft({ overwrite: true, confirm: "shop" }), "shop", backups)).toEqual({});
  });

  it("ignores a stale target name while overwriting", () => {
    expect(restoreProblems(draft({ overwrite: true, confirm: "shop", target: "!!" }), "shop", backups)).toEqual({});
  });
});

describe("restore request", () => {
  it("restores into the chosen new database without overwrite fields", () => {
    expect(restoreRequest(draft(), "shop")).toEqual({ backup: backups[0].key, identity: KEY, target: "shop_restore_20260101" });
  });

  it("targets the live database and repeats its name when overwriting", () => {
    expect(restoreRequest(draft({ overwrite: true, confirm: "shop", target: "ignored" }), "shop")).toEqual({
      backup: backups[0].key,
      identity: KEY,
      target: "shop",
      overwrite: true,
      confirm: "shop",
    });
  });

  it("sends only the key, not the comments around it", () => {
    expect(restoreRequest(draft({ identity: `# comment\n${KEY}\n` }), "shop").identity).toBe(KEY);
  });
});

describe("what the overwrite says about the safety backup", () => {
  it("tells the truth the agent implements: a pre-restore backup is taken first, and nothing is overwritten if it fails", () => {
    for (const text of [OVERWRITE_HELP, overwriteConfirmation("shop")]) {
      expect(text).toContain("safety backup");
      expect(text).toContain("pre-restore");
      expect(text).not.toMatch(/no safety backup/i);
    }
    expect(overwriteConfirmation("shop")).toContain("nothing is overwritten");
    expect(OVERWRITE_HELP).toContain("new database touches nothing that exists");
  });
});
