"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { saveJobAction } from "@/app/config-actions";
import {
  compact,
  DURATION_HINT,
  durationError,
  DurationField,
  ENV_NAME,
  ENV_NAME_HINT,
  fieldIssues,
  FixFieldsNotice,
  FormFooter,
  FormSection,
  focusFirstInvalid,
  integerError,
  keyValueError,
  KeyValueField,
  keyValueRecord,
  keyValueRows,
  listRequiredError,
  NAME_HINT,
  NAME_PATTERN,
  optionalText,
  SaveProblems,
  SecretValueInput,
  sectionProblems,
  StringListField,
  toInteger,
  useFieldErrors,
  type KeyValueRow,
} from "@/components/config/FormParts";
import {
  FieldShell,
  SegmentedControl,
  SelectField,
  SwitchField,
  TextField,
  type SelectOption,
} from "@/components/forms/fields";
import { useConfigSave } from "@/components/config/useConfigSave";
import { ScheduleField, TimezoneField, timezoneError } from "@/components/config/ScheduleFields";
import { Notice } from "@/components/states";
import { scheduleError } from "@/lib/cron-describe";
import { HIDDEN, type ConfigIssue, type JobConfig } from "@/lib/agent-types";
import { liveNotice } from "@/lib/app-config-core";
import { serverListHref } from "@/lib/nav-core";
import { withProject } from "@/lib/project-hub-jobs-core";

type JobKind = "http" | "host" | "container";
type BearerMode = "none" | "file" | "app";
type HttpJob = NonNullable<JobConfig["http"]>;

/** An app a job can refer to: by name for containers, with its variable names for bearer tokens. */
export interface JobAppOption {
  name: string;
  envKeys: string[];
}

const KINDS: { value: JobKind; label: string }[] = [
  { value: "http", label: "HTTP request" },
  { value: "host", label: "Program on the host" },
  { value: "container", label: "Container of an app" },
];

const BEARER_MODES: { value: BearerMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "file", label: "Secret file" },
  { value: "app", label: "App variable" },
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const HEADER_NAME_HINT = "Letters, digits and - are the usual characters.";

interface JobDraft {
  name: string;
  schedule: string;
  timezone: string;
  kind: JobKind;
  url: string;
  method: string;
  headers: KeyValueRow[];
  body: string;
  bearerMode: BearerMode;
  bearerFile: string;
  bearerApp: string;
  bearerEnv: string;
  expectStatus: string;
  host: string[];
  dir: string;
  containerApp: string;
  containerCommand: string[];
  timeout: string;
  alertAfter: string;
  realertAfter: string;
  catchUp: boolean;
  paused: boolean;
}

export function draftFromJob(job: JobConfig | undefined): JobDraft {
  const bearer = job?.http?.bearer;
  return {
    name: job?.name ?? "",
    schedule: job?.schedule ?? "",
    timezone: job ? (job.timezone ?? "") : "UTC",
    kind: job?.container ? "container" : job?.host ? "host" : "http",
    url: job?.http?.url ?? "",
    method: job?.http?.method || "GET",
    headers: keyValueRows(job?.http?.headers),
    body: job?.http?.body ?? "",
    bearerMode: bearer?.file ? "file" : bearer?.app ? "app" : "none",
    bearerFile: bearer?.file ?? "",
    bearerApp: bearer?.app ?? "",
    bearerEnv: bearer?.env ?? "",
    expectStatus: job?.http?.expect_status?.join(", ") ?? "",
    host: job?.host?.length ? job.host : [""],
    dir: job?.dir ?? "",
    containerApp: job?.container?.app ?? "",
    containerCommand: job?.container?.command?.length ? job.container.command : [""],
    timeout: job?.timeout ?? "",
    alertAfter: job?.alert_after === undefined ? "" : String(job.alert_after),
    realertAfter: job?.realert_after ?? "",
    catchUp: job?.catch_up ?? false,
    paused: job?.paused ?? false,
  };
}

/** Status codes typed as "200, 204": null when something is not a code. */
function parseStatusCodes(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  const codes = parts.map((p) => (/^\d{3}$/.test(p) ? Number(p) : NaN));
  return codes.some((c) => c < 100 || c > 599 || Number.isNaN(c)) ? null : codes;
}

function httpFromDraft(d: JobDraft): HttpJob {
  const http: HttpJob = { url: d.url.trim() };
  if (d.method !== "") http.method = d.method;
  const headers = keyValueRecord(d.headers);
  if (headers) http.headers = headers;
  if (d.body !== "") http.body = d.body;
  if (d.bearerMode === "file") http.bearer = { file: d.bearerFile.trim() };
  if (d.bearerMode === "app") http.bearer = { app: d.bearerApp, env: d.bearerEnv.trim() };
  const codes = parseStatusCodes(d.expectStatus);
  if (codes && codes.length > 0) http.expect_status = codes;
  return http;
}

/** The job to send: only the chosen kind's fields, and no empty optional fields. */
export function jobFromDraft(d: JobDraft): JobConfig {
  const job: JobConfig = { name: d.name.trim(), schedule: d.schedule.trim() };
  const timezone = optionalText(d.timezone);
  if (timezone) job.timezone = timezone;
  if (d.kind === "http") job.http = httpFromDraft(d);
  if (d.kind === "host") {
    job.host = compact(d.host);
    const dir = optionalText(d.dir);
    if (dir) job.dir = dir;
  }
  if (d.kind === "container") job.container = { app: d.containerApp, command: compact(d.containerCommand) };
  const timeout = optionalText(d.timeout);
  if (timeout) job.timeout = timeout;
  const alertAfter = toInteger(d.alertAfter);
  if (alertAfter !== undefined) job.alert_after = alertAfter;
  const realertAfter = optionalText(d.realertAfter);
  if (realertAfter) job.realert_after = realertAfter;
  if (d.catchUp) job.catch_up = true;
  if (d.paused) job.paused = true;
  return job;
}

function urlError(url: string): string | undefined {
  const text = url.trim();
  if (text === "") return "Enter the URL to request.";
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "The URL must start with http:// or https://.";
  } catch {
    return "That is not a valid URL. Include the scheme, for example https://example.com/ping.";
  }
}

function validateJob(d: JobDraft, creating: boolean, existingNames: string[], bodyStored: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (creating) {
    const name = d.name.trim();
    if (name === "") errors.name = "Enter a name.";
    else if (!NAME_PATTERN.test(name)) errors.name = `"${name}" is not a valid name. ${NAME_HINT}`;
    else if (existingNames.includes(name)) errors.name = `A job named ${name} already exists.`;
  }
  const schedule = scheduleError(d.schedule);
  if (schedule) errors.schedule = schedule;
  const timezone = d.timezone.trim() === "" ? undefined : timezoneError(d.timezone.trim());
  if (timezone) errors.timezone = timezone;

  if (d.kind === "http") {
    const url = urlError(d.url);
    if (url) errors.url = url;
    const headers = keyValueError(d.headers, "header", HEADER_NAME, HEADER_NAME_HINT);
    if (headers) errors.headers = headers;
    if (d.body === HIDDEN && !bodyStored) errors.body = "Enter the body, or clear the field.";
    if (d.bearerMode === "file" && d.bearerFile.trim() === "") errors.bearer_file = "Enter the path of the file that holds the token.";
    if (d.bearerMode === "app") {
      if (d.bearerApp === "") errors.bearer_app = "Choose the app whose variable holds the token.";
      const env = d.bearerEnv.trim();
      if (env === "") errors.bearer_env = "Enter the variable name.";
      else if (!ENV_NAME.test(env)) errors.bearer_env = `Not a valid variable name. ${ENV_NAME_HINT}`;
    }
    if (parseStatusCodes(d.expectStatus) === null) errors.expect_status = "Use status codes from 100 to 599, separated by commas.";
  }
  if (d.kind === "host") {
    const host = listRequiredError(d.host, "entry: the program to run");
    if (host) errors.host = host;
  }
  if (d.kind === "container") {
    if (d.containerApp === "") errors.container_app = "Choose the app whose container runs the command.";
    const command = listRequiredError(d.containerCommand, "argument");
    if (command) errors.container_command = command;
  }

  const timeout = durationError(d.timeout);
  if (timeout) errors.timeout = timeout;
  const alertAfter = integerError(d.alertAfter, "The failure count", 1, 1000);
  if (alertAfter) errors.alert_after = alertAfter;
  const realertAfter = durationError(d.realertAfter);
  if (realertAfter) errors.realert_after = realertAfter;
  return errors;
}

interface Problems {
  issues: ConfigIssue[];
  message?: string;
  entity: string;
}

/** Create (no `job`) or edit one scheduled job. */
export function JobForm({
  serverId,
  baseHash,
  job,
  apps,
  existingNames,
  redirectTo,
  cancelHref,
  project,
}: {
  serverId: string;
  baseHash: string;
  /** The job being edited; absent when creating. */
  job?: JobConfig;
  apps: JobAppOption[];
  /** Names already taken, so that creating cannot silently replace a job. */
  existingNames: string[];
  /** Where to go after a save instead of the job's page (a validated return path). */
  redirectTo?: string;
  /** Where Cancel goes instead of the jobs list or the job's page. */
  cancelHref?: string;
  /** The project a NEW job is created for (from the hub); an edited job keeps the project it has. */
  project?: string;
}) {
  const creating = job === undefined;
  const owner = creating ? project : job.project;
  const router = useRouter();
  const save = useConfigSave();
  const base = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<JobDraft>(() => draftFromJob(job));
  const [problems, setProblems] = useState<Problems | null>(null);
  const bodyStored = job?.http?.body === HIDDEN;

  const errors = validateJob(draft, creating, existingNames, bodyStored);
  const server = problems ? fieldIssues(problems.issues, problems.entity) : {};
  const fe = useFieldErrors(errors, server);
  const errorCount = Object.keys(errors).length;

  function set<K extends keyof JobDraft>(key: K, value: JobDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    fe.touchAll();
    if (errorCount > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const config = withProject(jobFromDraft(draft), owner);
    const { saved, result } = await save.run(
      `job ${config.name}`,
      ({ force }) => saveJobAction(serverId, config.name, config, { base_hash: baseHash, force }),
      liveNotice(`Job ${config.name}`),
    );
    if (saved) {
      router.push(redirectTo ?? `/servers/${serverId}/jobs/${config.name}`);
      return;
    }
    if (!result.ok && result.kind === "invalid") {
      setProblems({ issues: result.issues, message: result.message, entity: `jobs[${config.name}]` });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const id = (field: string) => `${base}-${field}`;
  const touch = (field: string) => () => fe.touch(field);

  const appOptions: SelectOption[] = apps.map((a) => ({ value: a.name, label: a.name }));
  const withCurrent = (current: string): SelectOption[] =>
    current === "" || appOptions.some((o) => o.value === current) ? appOptions : [...appOptions, { value: current, label: `${current} (not configured)` }];
  const bearerKeys = apps.find((a) => a.name === draft.bearerApp)?.envKeys ?? [];
  const methods = METHODS.includes(draft.method) ? METHODS : [...METHODS, draft.method];
  const noApps = apps.length === 0;

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="max-w-3xl space-y-6">
      {owner && (
        <p className="text-sm text-muted-foreground" data-testid="form-project">
          Project: <span className="font-medium text-foreground">{owner}</span>
        </p>
      )}
      {problems && <SaveProblems issues={problems.issues} message={problems.message} />}
      {fe.submitted && errorCount > 0 && <FixFieldsNotice count={errorCount} />}

      <FormSection
        title="Schedule"
        description="When the job runs."
        flagged={sectionProblems(server, ["name", "schedule", "timezone"]) !== undefined}
      >
        <TextField
          id={id("name")}
          label="Name"
          required
          help={creating ? NAME_HINT : "The name cannot be changed. To rename the job, delete it and create it again."}
          error={fe.error("name")}
          value={draft.name}
          onChange={(v) => set("name", v)}
          onBlur={touch("name")}
          readOnly={!creating}
          placeholder="backup"
          mono
        />
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
      </FormSection>

      <FormSection
        title="What to run"
        description="Each job does exactly one of these."
        flagged={sectionProblems(server, ["http", "host", "dir", "container"]) !== undefined}
        problems={sectionProblems(server, ["http", "container"])}
      >
        <SegmentedControl
          label="Kind of job"
          value={draft.kind}
          options={KINDS}
          onChange={(kind) => {
            const option = KINDS.find((k) => k.value === kind);
            if (option) set("kind", option.value);
          }}
        />

        {draft.kind === "http" && (
          <>
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <TextField
                id={id("url")}
                label="URL"
                required
                help="Requested each time the job runs."
                error={fe.error("url")}
                value={draft.url}
                onChange={(v) => set("url", v)}
                onBlur={touch("url")}
                placeholder="https://example.com/internal/cron"
                mono
              />
              <SelectField
                id={id("method")}
                label="Method"
                value={draft.method}
                onChange={(v) => set("method", v)}
                options={methods.map((m) => ({ value: m, label: m }))}
              />
            </div>
            <KeyValueField
              id={id("headers")}
              label="Headers"
              noun="header"
              help="Header values are write-only: once saved they show as Set and are never displayed again."
              error={fe.error("headers")}
              rows={draft.headers}
              onChange={(rows) => set("headers", rows)}
              onBlur={touch("headers")}
              keyPlaceholder="X-Header"
              addLabel="Add header"
            />
            <FieldShell
              id={id("body")}
              label="Body"
              help="Optional. Write-only: a stored body shows as Set and is never displayed again."
              error={fe.error("body")}
            >
              <SecretValueInput
                id={id("body")}
                label="request body"
                value={draft.body}
                onChange={(v) => set("body", v)}
                onBlur={touch("body")}
                stored={bodyStored}
                invalid={Boolean(fe.error("body"))}
                describedBy={`${id("body")}-help${fe.error("body") ? ` ${id("body")}-error` : ""}`}
                multiline
              />
            </FieldShell>
            <FieldShell
              id={id("bearer")}
              label="Bearer token"
              group
              help="Sent as an Authorization: Bearer header. The token is read on the server: from a file, or from an app's environment variable."
            >
              <div className="space-y-3">
                <SegmentedControl
                  label="Where the bearer token comes from"
                  value={draft.bearerMode}
                  options={BEARER_MODES}
                  onChange={(mode) => {
                    const option = BEARER_MODES.find((m) => m.value === mode);
                    if (option) set("bearerMode", option.value);
                  }}
                />
                {draft.bearerMode === "file" && (
                  <TextField
                    id={id("bearer_file")}
                    label="Token file"
                    required
                    help="Path of a file on the server that holds the token."
                    error={fe.error("bearer_file")}
                    value={draft.bearerFile}
                    onChange={(v) => set("bearerFile", v)}
                    onBlur={touch("bearer_file")}
                    placeholder="/etc/acme/cron-token"
                    mono
                  />
                )}
                {draft.bearerMode === "app" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <SelectField
                      id={id("bearer_app")}
                      label="App"
                      required
                      error={fe.error("bearer_app")}
                      value={draft.bearerApp}
                      onChange={(v) => set("bearerApp", v)}
                      options={withCurrent(draft.bearerApp)}
                      placeholder={noApps ? "No apps configured" : "Choose an app"}
                    />
                    <TextField
                      id={id("bearer_env")}
                      label="Variable"
                      required
                      help="The environment variable of that app that holds the token."
                      error={fe.error("bearer_env")}
                      value={draft.bearerEnv}
                      onChange={(v) => set("bearerEnv", v)}
                      onBlur={touch("bearer_env")}
                      list={id("bearer_keys")}
                      placeholder="CRON_TOKEN"
                      mono
                    />
                    <datalist id={id("bearer_keys")}>
                      {bearerKeys.map((key) => (
                        <option key={key} value={key} />
                      ))}
                    </datalist>
                  </div>
                )}
              </div>
            </FieldShell>
            <TextField
              id={id("expect_status")}
              label="Expected status codes"
              help="Status codes that count as success, separated by commas. Leave empty for the agent's default."
              error={fe.error("expect_status")}
              value={draft.expectStatus}
              onChange={(v) => set("expectStatus", v)}
              onBlur={touch("expect_status")}
              placeholder="200, 204"
              mono
            />
          </>
        )}

        {draft.kind === "host" && (
          <>
            <StringListField
              id={id("host")}
              label="Program and arguments"
              required
              help="The first entry is the program; the rest are its arguments."
              error={fe.error("host")}
              values={draft.host}
              onChange={(v) => set("host", v)}
              onBlur={touch("host")}
              placeholder="/usr/local/bin/backup"
              addLabel="Add argument"
            />
            <TextField
              id={id("dir")}
              label="Working directory"
              help="Optional: the directory on the server the program starts in."
              error={fe.error("dir")}
              value={draft.dir}
              onChange={(v) => set("dir", v)}
              placeholder="/srv"
              mono
            />
          </>
        )}

        {draft.kind === "container" && (
          <>
            {noApps && !draft.containerApp && (
              <Notice tone="warning" title="No apps configured">
                A container job runs a command in an app&apos;s container. Create an app first.
              </Notice>
            )}
            <SelectField
              id={id("container_app")}
              label="App"
              required
              help="The command runs in this app's container."
              error={fe.error("container_app")}
              value={draft.containerApp}
              onChange={(v) => set("containerApp", v)}
              options={withCurrent(draft.containerApp)}
              placeholder={noApps ? "No apps configured" : "Choose an app"}
            />
            <StringListField
              id={id("container_command")}
              label="Command"
              required
              help="One entry per argument."
              error={fe.error("container_command")}
              values={draft.containerCommand}
              onChange={(v) => set("containerCommand", v)}
              onBlur={touch("container_command")}
              placeholder="./manage.py"
              addLabel="Add argument"
            />
          </>
        )}
      </FormSection>

      <FormSection
        title="Limits and alerts"
        flagged={sectionProblems(server, ["timeout", "alert_after", "realert_after", "catch_up", "paused"]) !== undefined}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <DurationField
            id={id("timeout")}
            label="Timeout"
            help={`Optional: stop a run that takes longer. ${DURATION_HINT}`}
            error={fe.error("timeout")}
            value={draft.timeout}
            onChange={(v) => set("timeout", v)}
            onBlur={touch("timeout")}
            placeholder="10m"
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
            placeholder="3"
            mono
          />
          <DurationField
            id={id("realert_after")}
            label="Repeat the alert after"
            help={`While a job keeps failing, send the alert again this often (an alert that did not get through is sent again at the next failed run whatever this says). Default 24h, 0s never repeats. ${DURATION_HINT}`}
            error={fe.error("realert_after")}
            value={draft.realertAfter}
            onChange={(v) => set("realertAfter", v)}
            onBlur={touch("realert_after")}
            placeholder="24h"
          />
        </div>
        <SwitchField
          id={id("catch_up")}
          label="Catch up after downtime"
          help="If the agent or the server was not running at a scheduled time, run the job once, late, when the agent starts again. Off by default: a missed run is always recorded and alerted (job.missed), but not run."
          checked={draft.catchUp}
          onChange={(v) => set("catchUp", v)}
        />
        <SwitchField
          id={id("paused")}
          label="Paused"
          help="A paused job keeps its configuration but does not run on its schedule."
          checked={draft.paused}
          onChange={(v) => set("paused", v)}
        />
      </FormSection>

      <FormFooter
        pending={save.pending}
        saveLabel={creating ? "Create job" : "Save changes"}
        cancelHref={cancelHref ?? (creating ? serverListHref("jobs", serverId) : `/servers/${serverId}/jobs/${draft.name}`)}
      />
      {save.dialogs}
    </form>
  );
}
