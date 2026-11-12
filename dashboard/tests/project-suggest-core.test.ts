import { describe, expect, it } from "vitest";
import { envNamesOf, needsBuildkit, NO_SUGGESTION, suggestProject, type RepoFiles } from "@/lib/project-suggest-core";

const files = (extra: Partial<RepoFiles> = {}): RepoFiles => ({ root: [], hasDockerfile: false, packageJson: null, prismaSchema: null, prismaMigrations: false, envExample: null, ...extra });
const pkg = (value: object) => JSON.stringify(value);

describe("the framework a repository points to", () => {
  it("is the Dockerfile when the repository has one: the operator's own statement beats a guess from package.json", () => {
    expect(suggestProject(files({ hasDockerfile: true, packageJson: pkg({ dependencies: { next: "16" } }) })).framework).toEqual({ id: "dockerfile", reason: "The repository has a Dockerfile." });
  });

  it("reads Next.js, Vite, Node servers and static sites from what package.json and the root hold", () => {
    expect(suggestProject(files({ packageJson: pkg({ dependencies: { next: "16", react: "19" } }) })).framework?.id).toBe("nextjs");
    expect(suggestProject(files({ packageJson: pkg({ devDependencies: { next: "16" } }) })).framework?.id).toBe("nextjs");
    expect(suggestProject(files({ packageJson: pkg({ devDependencies: { vite: "7" }, scripts: { build: "vite build" } }) })).framework?.id).toBe("vite");
    expect(suggestProject(files({ packageJson: pkg({ dependencies: { express: "5" } }) })).framework).toEqual({ id: "node", reason: "package.json depends on express." });
    expect(suggestProject(files({ packageJson: pkg({ scripts: { start: "node index.js" } }) })).framework?.id).toBe("node");
    expect(suggestProject(files({ root: ["index.html", "style.css"] })).framework?.id).toBe("static");
  });

  it("calls a Vite project that also serves or starts something a Node.js app, not a static site", () => {
    expect(suggestProject(files({ packageJson: pkg({ devDependencies: { vite: "7" }, scripts: { start: "node server.js" } }) })).framework?.id).toBe("node");
    expect(suggestProject(files({ packageJson: pkg({ dependencies: { fastify: "5" }, devDependencies: { vite: "7" } }) })).framework?.id).toBe("node");
  });

  it("says nothing rather than guess: a bare package.json, one that is not JSON, or an empty repository", () => {
    expect(suggestProject(files({ packageJson: pkg({ name: "x", dependencies: { lodash: "4" } }) })).framework).toBeNull();
    expect(suggestProject(files({ packageJson: "{ not json" })).framework).toBeNull();
    expect(suggestProject(files({ packageJson: "[1, 2]" })).framework).toBeNull();
    expect(suggestProject(files())).toEqual(NO_SUGGESTION);
  });

  it("prefers package.json to an index.html that a framework project may also have", () => {
    expect(suggestProject(files({ root: ["index.html"], packageJson: pkg({ devDependencies: { vite: "7" } }) })).framework?.id).toBe("vite");
  });
});

describe("the release command", () => {
  const prisma = { prismaSchema: 'datasource db { provider = "postgresql" }', prismaMigrations: true };

  it("is prisma migrate deploy for a Next.js or Node.js project that has migrations", () => {
    expect(suggestProject(files({ ...prisma, packageJson: pkg({ dependencies: { next: "16" } }) })).release).toEqual({ command: "npx prisma migrate deploy", reason: "prisma/migrations exists." });
    expect(suggestProject(files({ ...prisma, packageJson: pkg({ dependencies: { express: "5" } }) })).release?.command).toBe("npx prisma migrate deploy");
  });

  it("is not suggested without migrations (a project that pushes its schema), without Prisma, or for a Dockerfile whose image may not carry the CLI", () => {
    expect(suggestProject(files({ ...prisma, prismaMigrations: false, packageJson: pkg({ dependencies: { next: "16" } }) })).release).toBeNull();
    expect(suggestProject(files({ packageJson: pkg({ dependencies: { next: "16" } }) })).release).toBeNull();
    expect(suggestProject(files({ ...prisma, hasDockerfile: true })).release).toBeNull();
  });
});

describe("the database", () => {
  it("is suggested for a Prisma schema on PostgreSQL, not for another provider", () => {
    expect(suggestProject(files({ prismaSchema: 'datasource db {\n  provider = "postgresql"\n}' })).database).toEqual({ reason: "prisma/schema.prisma uses PostgreSQL." });
    expect(suggestProject(files({ prismaSchema: 'datasource db { provider = "postgres" }' })).database).not.toBeNull();
    expect(suggestProject(files({ prismaSchema: 'datasource db { provider = "mysql" }' })).database).toBeNull();
    expect(suggestProject(files({ prismaSchema: 'datasource db { provider = "sqlite" }' })).database).toBeNull();
  });

  it("is suggested for a PostgreSQL driver or an example file that points DATABASE_URL at PostgreSQL", () => {
    expect(suggestProject(files({ packageJson: pkg({ dependencies: { pg: "8" } }) })).database).toEqual({ reason: "package.json depends on pg." });
    expect(suggestProject(files({ envExample: "DATABASE_URL=postgresql://user:pass@localhost:5432/app\n" })).database?.reason).toContain("example environment file");
    expect(suggestProject(files({ envExample: "DATABASE_URL=mysql://root@localhost/app\n" })).database).toBeNull();
  });
});

describe("the variables an example file lists", () => {
  it("reads names only, in order, each once, and ignores comments, blank lines and values", () => {
    const text = "# secrets\nSESSION_SECRET=change-me\n\nexport API_URL=\"https://x\"\nSESSION_SECRET=again\n  SPACED = 1\nnot a variable\n#COMMENTED=1\n";
    expect(envNamesOf(text)).toEqual(["SESSION_SECRET", "API_URL", "SPACED"]);
    expect(envNamesOf(null)).toEqual([]);
  });

  it("never returns a value, even one that looks like a secret", () => {
    expect(JSON.stringify(envNamesOf("TOKEN=ghp_supersecretvalue123\n"))).not.toContain("ghp_");
  });

  it("is capped, because every name is a row the operator reads", () => {
    const many = Array.from({ length: 200 }, (_, i) => `VAR_${i}=1`).join("\n");
    expect(envNamesOf(many)).toHaveLength(60);
  });

  it("leaves DATABASE_URL out when a database is suggested (the database card fills it), and keeps it otherwise", () => {
    const withDb = suggestProject(files({ prismaSchema: 'provider = "postgresql"', envExample: "DATABASE_URL=postgresql://x\nSESSION_SECRET=1\n" }));
    expect(withDb.envNames).toEqual(["SESSION_SECRET"]);
    const without = suggestProject(files({ envExample: "DATABASE_URL=mysql://x\nSESSION_SECRET=1\n" }));
    expect(without.envNames).toEqual(["DATABASE_URL", "SESSION_SECRET"]);
  });
});

describe("a Dockerfile only BuildKit can build", () => {
  it("is recognised by RUN --mount, with the instruction continued over lines, and by COPY --link and RUN --network", () => {
    expect(needsBuildkit("FROM node\nRUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \\\n    pnpm install\n")).toBe(true);
    expect(needsBuildkit("FROM node\nCOPY --chown=1:1 --link a b\n")).toBe(true);
    expect(needsBuildkit("FROM node\nRUN --network=none echo\n")).toBe(true);
    expect(needsBuildkit("FROM node\nrun --mount=type=secret,id=x cat /run/secrets/x\n")).toBe(true);
  });

  it("is not triggered by what the classic builder runs: plain RUN, COPY --from and --chown, the syntax comment, text that merely says --mount", () => {
    expect(needsBuildkit("# syntax=docker/dockerfile:1\nFROM node\nRUN pnpm install\nCOPY --from=build --chown=1:1 /a /b\n")).toBe(false);
    expect(needsBuildkit('FROM node\nRUN echo "use --mount for caches"\n')).toBe(false);
    expect(needsBuildkit("")).toBe(false);
  });
});
