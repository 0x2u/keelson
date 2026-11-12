import type { ConfigIssue } from "@/lib/agent-types";
import type { DerivedProject } from "@/lib/project-config-core";

// The spellings of the apps files that have a new name (schema v1). The agent loads them as before and reports each one in
// `GET /v1/config` `deprecations`; `keelson-agent config migrate` writes the new spelling to the files. There is no API
// route for the migration (it rewrites files and can refuse), so the notice says how to run it on the server.

/** "This file uses spellings that are deprecated: 3". */
export function deprecationsTitle(count: number): string {
  return `This file uses spellings that are deprecated: ${count}`;
}

/** How to move the files to the current spelling: the CLI of the agent, on the server. */
export const MIGRATE_COMMAND = "keelson-agent config migrate --apps /etc/keelson/config/apps.yaml --dry-run";

/** What the agent offers to fix them, for the notice; the command follows. */
export const MIGRATE_HELP =
  "The agent still reads them, so nothing stops working. To write the current spelling, run this on the server: /etc/keelson/config/apps.yaml is the file the install gives the agent (use its own path if you moved it). The command shows what it would change; run it again without --dry-run to write it, and each original is kept as <file>.pre-v1. The file belongs to the keelson user, so if your account cannot write it, put sudo -u keelson in front:";

/** The deprecations that are about one project: those in its own file, and in the apps file those of its apps, jobs and databases. */
export function projectDeprecations(issues: ConfigIssue[], project: string, derived: DerivedProject | null): ConfigIssue[] {
  const mine = new Set<string>();
  for (const [kind, names] of [
    ["apps", derived?.apps.map((a) => a.name)],
    ["jobs", derived?.jobs.map((j) => j.name)],
    ["databases", derived?.databases.map((d) => d.name)],
  ] as const) {
    for (const name of names ?? []) mine.add(`${kind}[${name}]`);
  }
  return issues.filter((i) => (i.project !== undefined && i.project !== "" ? i.project === project : mine.has(i.path.split(".", 1)[0])));
}
