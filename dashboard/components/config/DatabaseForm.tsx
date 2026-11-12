"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { saveDatabaseAction } from "@/app/config-actions";
import {
  DURATION_HINT,
  DurationField,
  fieldIssues,
  FixFieldsNotice,
  FormFooter,
  FormSection,
  focusFirstInvalid,
  NAME_HINT,
  SaveProblems,
  sectionProblems,
  StringListField,
  useFieldErrors,
} from "@/components/config/FormParts";
import {
  FieldShell,
  SegmentedControl,
  SelectField,
  SwitchField,
  TextField,
  type SelectOption,
} from "@/components/forms/fields";
import { ScheduleField, TimezoneField } from "@/components/config/ScheduleFields";
import { withProject } from "@/lib/project-hub-jobs-core";
import { NO_PROJECT, projectOptions } from "@/lib/database-config";
import { useConfigSave } from "@/components/config/useConfigSave";
import { Notice } from "@/components/states";
import {
  databaseFromDraft,
  draftFromDatabase,
  validateDatabase,
  type DatabaseDraft,
  type DestinationKind,
  type SslMode,
} from "@/lib/database-config";
import type { ConfigIssue, DatabaseConfig } from "@/lib/agent-types";
import { liveNotice } from "@/lib/app-config-core";
import { serverListHref } from "@/lib/nav-core";

const SSL_MODES: SelectOption[] = [
  { value: "default", label: "Default (the client's choice)" },
  { value: "disable", label: "disable" },
  { value: "allow", label: "allow" },
  { value: "prefer", label: "prefer" },
  { value: "require", label: "require" },
  { value: "verify-ca", label: "verify-ca" },
  { value: "verify-full", label: "verify-full" },
];

const DESTINATIONS: { value: DestinationKind; label: string }[] = [
  { value: "local", label: "Directory on the server" },
  { value: "s3", label: "S3-compatible storage" },
];

interface Problems {
  issues: ConfigIssue[];
  message?: string;
  entity: string;
}

/** Create (no `database`) or edit one database and its backup schedule. */
export function DatabaseForm({
  serverId,
  baseHash,
  database,
  existingNames,
  redirectTo,
  cancelHref,
  project,
  projects,
}: {
  serverId: string;
  baseHash: string;
  /** The database being edited; absent when creating. */
  database?: DatabaseConfig;
  /** Names already taken, so that creating cannot silently replace a database. */
  existingNames: string[];
  /** Where to go after a save instead of the database's page (a validated return path). */
  redirectTo?: string;
  /** Where Cancel goes instead of the databases list or the database's page. */
  cancelHref?: string;
  /** The project a NEW database is created for (from the hub); an edited database keeps the project it has. */
  project?: string;
  /** The names of the projects to choose from. */
  projects: string[];
}) {
  const creating = database === undefined;
  const router = useRouter();
  const save = useConfigSave();
  const base = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<DatabaseDraft>(() => draftFromDatabase(database));
  const [problems, setProblems] = useState<Problems | null>(null);
  const [owner, setOwner] = useState<string>((creating ? project : database.project) ?? "");

  const errors = validateDatabase(draft, creating, existingNames);
  const server = problems ? fieldIssues(problems.issues, problems.entity) : {};
  const fe = useFieldErrors(errors, server);
  const errorCount = Object.keys(errors).length;

  function set<K extends keyof DatabaseDraft>(key: K, value: DatabaseDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    fe.touchAll();
    if (errorCount > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const config = withProject(databaseFromDraft(draft), owner);
    const { saved, result } = await save.run(
      `database ${config.name}`,
      ({ force }) => saveDatabaseAction(serverId, config.name, config, { base_hash: baseHash, force }),
      liveNotice(`Database ${config.name}`),
    );
    if (saved) {
      router.push(redirectTo ?? `/servers/${serverId}/databases/${encodeURIComponent(config.name)}`);
      return;
    }
    if (!result.ok && result.kind === "invalid") {
      setProblems({ issues: result.issues, message: result.message, entity: `databases[${config.name}]` });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const id = (field: string) => `${base}-${field}`;
  const touch = (field: string) => () => fe.touch(field);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="max-w-3xl space-y-6">
      {problems && <SaveProblems issues={problems.issues} message={problems.message} />}
      {fe.submitted && errorCount > 0 && <FixFieldsNotice count={errorCount} />}

      <FormSection
        title="Connection"
        description="An existing PostgreSQL database. The agent reaches it from a throwaway client container."
        flagged={sectionProblems(server, ["name", "host", "port", "database", "user", "password_file", "ssl_mode", "version", "network"]) !== undefined}
      >
        <TextField
          id={id("name")}
          label="Name"
          required
          help={creating ? NAME_HINT : "The name cannot be changed. To rename the database, delete it and declare it again."}
          error={fe.error("name")}
          value={draft.name}
          onChange={(v) => set("name", v)}
          onBlur={touch("name")}
          readOnly={!creating}
          placeholder="shop"
          mono
        />
        <SelectField
          id={id("project")}
          label="Project"
          help="The project this database belongs to: it is listed on the project's page, with its Test restore and Prove the key checks, wherever its apps run."
          value={owner === "" ? NO_PROJECT : owner}
          onChange={(v) => setOwner(v === NO_PROJECT ? "" : v)}
          options={projectOptions(projects, owner)}
        />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <TextField
            id={id("host")}
            label="Host"
            required
            error={fe.error("host")}
            value={draft.host}
            onChange={(v) => set("host", v)}
            onBlur={touch("host")}
            placeholder="127.0.0.1"
            mono
          />
          <TextField
            id={id("port")}
            label="Port"
            error={fe.error("port")}
            value={draft.port}
            onChange={(v) => set("port", v)}
            onBlur={touch("port")}
            inputMode="numeric"
            placeholder="5432"
            mono
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            id={id("database")}
            label="Database"
            required
            help="The PostgreSQL database name."
            error={fe.error("database")}
            value={draft.database}
            onChange={(v) => set("database", v)}
            onBlur={touch("database")}
            placeholder="shop"
            mono
          />
          <TextField
            id={id("user")}
            label="User"
            required
            error={fe.error("user")}
            value={draft.user}
            onChange={(v) => set("user", v)}
            onBlur={touch("user")}
            placeholder="shop"
            mono
          />
        </div>
        <TextField
          id={id("password_file")}
          label="Password file"
          help="Path of a file on the server that holds the password. It is read at every run, so rotating the password needs no restart. Leave empty for a server that needs none."
          error={fe.error("password_file")}
          value={draft.passwordFile}
          onChange={(v) => set("passwordFile", v)}
          onBlur={touch("password_file")}
          placeholder="/etc/acme/db-shop"
          mono
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <SelectField
            id={id("ssl_mode")}
            label="SSL mode"
            value={draft.sslMode === "" ? "default" : draft.sslMode}
            onChange={(v) => set("sslMode", v === "default" ? "" : (v as SslMode))}
            options={SSL_MODES}
          />
          <TextField
            id={id("version")}
            label="Client version"
            help="The PostgreSQL major version of pg_dump. Empty detects it from the server. A newer client can read an older server, never the reverse."
            error={fe.error("version")}
            value={draft.version}
            onChange={(v) => set("version", v)}
            onBlur={touch("version")}
            inputMode="numeric"
            placeholder="16"
            mono
          />
        </div>
        <TextField
          id={id("network")}
          label="Docker network"
          help="The network of the throwaway client containers. Empty uses the host network, which reaches a database on this machine as 127.0.0.1."
          error={fe.error("network")}
          value={draft.network}
          onChange={(v) => set("network", v)}
          placeholder="host"
          mono
        />
      </FormSection>

      <FormSection
        title="Backup"
        description="Scheduled dumps, encrypted with age on the server, then stored at the destination."
        flagged={sectionProblems(server, ["backup"]) !== undefined}
      >
        <SwitchField
          id={id("backup")}
          label="Back up this database on a schedule"
          help={
            draft.backup
              ? "Backups made so far stay at the destination if you turn this off later."
              : "Without a schedule the database is only listed here."
          }
          checked={draft.backup}
          onChange={(v) => set("backup", v)}
        />

        {draft.backup && (
          <>
            <ScheduleField
              id={id("schedule")}
              value={draft.schedule}
              onChange={(v) => set("schedule", v)}
              onBlur={touch("schedule")}
              error={fe.error("schedule")}
            />
            <TimezoneField
              id={id("timezone")}
              value={draft.timezone}
              onChange={(v) => set("timezone", v)}
              onBlur={touch("timezone")}
              error={fe.error("timezone")}
            />
            <StringListField
              id={id("recipients")}
              label="Recipients (age public keys)"
              required
              help="Backups are encrypted to these public keys and can only be read with a matching secret key, which this dashboard never stores. Generate one with age-keygen and keep the secret key safe: without it a backup cannot be restored."
              error={fe.error("recipients")}
              values={draft.recipients}
              onChange={(v) => set("recipients", v)}
              onBlur={touch("recipients")}
              placeholder="age1…"
              addLabel="Add recipient"
            />

            {draft.destinations ? (
              <Notice tone="info" title={`Backups go to ${draft.destinations.length} destinations`}>
                Every one of them holds every backup, or the backup fails. They are listed in the configuration (`destinations:`) and kept as they are when you save here:
                to change them, use the raw editor.
              </Notice>
            ) : (
            <FieldShell id={id("destination")} label="Destination" group>
              <div className="space-y-4">
                <SegmentedControl
                  label="Where backups are stored"
                  value={draft.destination}
                  options={DESTINATIONS}
                  onChange={(v) => {
                    const option = DESTINATIONS.find((d) => d.value === v);
                    if (option) set("destination", option.value);
                  }}
                />
                {draft.destination === "local" ? (
                  <TextField
                    id={id("local_dir")}
                    label="Directory"
                    required
                    help="Absolute path on the server. Each database gets a folder in it."
                    error={fe.error("local_dir")}
                    value={draft.localDir}
                    onChange={(v) => set("localDir", v)}
                    onBlur={touch("local_dir")}
                    placeholder="/var/backups/acme"
                    mono
                  />
                ) : (
                  <div className="space-y-5">
                    <TextField
                      id={id("s3_endpoint")}
                      label="Endpoint"
                      required
                      help="Requests are path-style (endpoint/bucket/key): AWS, MinIO, Cloudflare R2, Scaleway and Backblaze should work (only MinIO has been tried)."
                      error={fe.error("s3_endpoint")}
                      value={draft.s3Endpoint}
                      onChange={(v) => set("s3Endpoint", v)}
                      onBlur={touch("s3_endpoint")}
                      placeholder="https://s3.eu-west-1.amazonaws.com"
                      mono
                    />
                    <div className="grid gap-5 sm:grid-cols-2">
                      <TextField
                        id={id("s3_region")}
                        label="Region"
                        required
                        error={fe.error("s3_region")}
                        value={draft.s3Region}
                        onChange={(v) => set("s3Region", v)}
                        onBlur={touch("s3_region")}
                        placeholder="eu-west-1"
                        mono
                      />
                      <TextField
                        id={id("s3_bucket")}
                        label="Bucket"
                        required
                        error={fe.error("s3_bucket")}
                        value={draft.s3Bucket}
                        onChange={(v) => set("s3Bucket", v)}
                        onBlur={touch("s3_bucket")}
                        placeholder="my-backups"
                        mono
                      />
                    </div>
                    <TextField
                      id={id("s3_prefix")}
                      label="Prefix"
                      help="Optional folder in the bucket, without leading or trailing slash."
                      error={fe.error("s3_prefix")}
                      value={draft.s3Prefix}
                      onChange={(v) => set("s3Prefix", v)}
                      onBlur={touch("s3_prefix")}
                      placeholder="backups"
                      mono
                    />
                    <div className="grid gap-5 sm:grid-cols-2">
                      <TextField
                        id={id("s3_access_key_id")}
                        label="Access key ID"
                        required
                        error={fe.error("s3_access_key_id")}
                        value={draft.s3AccessKeyId}
                        onChange={(v) => set("s3AccessKeyId", v)}
                        onBlur={touch("s3_access_key_id")}
                        mono
                      />
                      <TextField
                        id={id("s3_secret_key_file")}
                        label="Secret key file"
                        required
                        help="Path of a file on the server that holds the secret access key, read at every run."
                        error={fe.error("s3_secret_key_file")}
                        value={draft.s3SecretKeyFile}
                        onChange={(v) => set("s3SecretKeyFile", v)}
                        onBlur={touch("s3_secret_key_file")}
                        placeholder="/etc/acme/s3-secret"
                        mono
                      />
                    </div>
                  </div>
                )}
              </div>
            </FieldShell>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                id={id("keep")}
                label="Keep the newest"
                help="Older backups are deleted after each run. Empty or 0 keeps 14. The newest backup is never deleted."
                error={fe.error("keep")}
                value={draft.keep}
                onChange={(v) => set("keep", v)}
                onBlur={touch("keep")}
                inputMode="numeric"
                placeholder="14"
                mono
              />
              <TextField
                id={id("keep_days")}
                label="Also delete after (days)"
                help="Optional: delete backups older than this. Both rules apply."
                error={fe.error("keep_days")}
                value={draft.keepDays}
                onChange={(v) => set("keepDays", v)}
                onBlur={touch("keep_days")}
                inputMode="numeric"
                placeholder="0"
                mono
              />
              <TextField
                id={id("keep_pre_deploy")}
                label="Kept from before a deployment"
                help="Backups taken by a deployment's backup step (and before a restore over the live database) are kept apart from the scheduled ones, so one kind never pushes the other out. Empty keeps 5."
                error={fe.error("keep_pre_deploy")}
                value={draft.keepPreDeploy}
                onChange={(v) => set("keepPreDeploy", v)}
                onBlur={touch("keep_pre_deploy")}
                inputMode="numeric"
                placeholder="5"
                mono
              />
              <DurationField
                id={id("timeout")}
                label="Timeout"
                help={`Optional: stop a run that takes longer (30m by default, 6h at most). ${DURATION_HINT}`}
                error={fe.error("timeout")}
                value={draft.timeout}
                onChange={(v) => set("timeout", v)}
                onBlur={touch("timeout")}
                placeholder="30m"
              />
              <TextField
                id={id("alert_after")}
                label="Alert after failures"
                help="Optional: raise an alert after this many failed runs in a row."
                error={fe.error("alert_after")}
                value={draft.alertAfter}
                onChange={(v) => set("alertAfter", v)}
                onBlur={touch("alert_after")}
                inputMode="numeric"
                placeholder="1"
                mono
              />
            </div>
            <SwitchField
              id={id("paused")}
              label="Paused"
              help="A paused schedule keeps its configuration but does not run on its own."
              checked={draft.paused}
              onChange={(v) => set("paused", v)}
            />
          </>
        )}
      </FormSection>

      <FormFooter
        pending={save.pending}
        saveLabel={creating ? "Add database" : "Save changes"}
        cancelHref={cancelHref ?? (creating ? serverListHref("databases", serverId) : `/servers/${serverId}/databases/${encodeURIComponent(draft.name)}`)}
      />
      {save.dialogs}
    </form>
  );
}
