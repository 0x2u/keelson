"use client";

import Link from "next/link";
import { CheckboxField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { DATABASE_ENV_KEY } from "@/lib/new-project-core";

/**
 * Asks for a PostgreSQL database for the new project. It is made after the app is written and before the variables and
 * the first build, by the agent, which keeps the URL in the app's variables: nothing about it travels through this page
 * except the backup key, once, after creation.
 */
export function DatabaseCard({
  enabled,
  onChange,
  supported,
  serverId,
  serverName,
  existingUrl,
  suggestion,
  buildDatabase,
  onBuildDatabase,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  /** The agent has the managed PostgreSQL API; without it the card only says why. */
  supported: boolean;
  serverId: string;
  serverName: string;
  /** A variable of the list below is already named like the one the database fills. */
  existingUrl: boolean;
  /** Why the repository suggests a database ("prisma/schema.prisma uses PostgreSQL."); nothing when it does not. */
  suggestion?: string;
  /** The build gets the database too (`build.database`). */
  buildDatabase: boolean;
  onBuildDatabase: (on: boolean) => void;
}) {
  if (!supported) {
    return (
      <Notice
        tone="warning"
        title="This agent is too old to create databases"
        action={
          <Link href={`/servers/${serverId}/update`} className="text-sm font-medium underline underline-offset-4">
            Update the agent
          </Link>
        }
      >
        A database created from here needs a newer Keelson agent on {serverName}. You can create the project without one.
      </Notice>
    );
  }
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <CheckboxField
        id="new-project-database"
        label="Create a PostgreSQL database for this app"
        help={
          <>
            {serverName} runs one PostgreSQL for all its apps (a container the agent creates the first time); this app gets its own database and role, and its URL becomes the <span className="font-mono">{DATABASE_ENV_KEY}</span> variable.
            It is backed up every day at 03:00, encrypted, on this server&apos;s disk, and you are given the key to read those backups once, right after the project is created.
          </>
        }
        checked={enabled}
        onChange={onChange}
      />
      {suggestion !== undefined && !enabled && (
        <p className="text-xs text-muted-foreground" data-testid="database-suggestion">
          Suggested: {suggestion} Nothing is created unless you tick the box.
        </p>
      )}
      {enabled && (
        <CheckboxField
          id="new-project-build-database"
          label="The first build and every later one can use this database too"
          help={
            <>
              For a build that queries the database to build (static pages filled from it). The URL is then also given to the build as a build argument, so its password stays in the build&apos;s own layers on this server, and the build runs on
              the network that reaches the database. A new database has no tables: the Dockerfile must create them before the build queries them (for Prisma, <span className="font-mono">prisma migrate deploy</span>). Untick it when the build
              does not need the database: then the URL is only read when the app starts.
            </>
          }
          checked={buildDatabase}
          onChange={onBuildDatabase}
        />
      )}
      {enabled && existingUrl && (
        <p role="alert" className="text-sm font-medium text-destructive">
          <span className="font-mono">{DATABASE_ENV_KEY}</span> is also in the variables below: remove it there, or turn the database off.
        </p>
      )}
    </div>
  );
}
