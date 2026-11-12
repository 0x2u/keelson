"use client";

import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { saveAppAction } from "@/app/config-actions";
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
  moveItem,
  NAME_HINT,
  NAME_PATTERN,
  optionalList,
  optionalText,
  ReorderButtons,
  SaveProblems,
  sectionProblems,
  StringListField,
  toInteger,
  useFieldErrors,
  type KeyValueRow,
} from "@/components/config/FormParts";
import { FieldShell, SegmentedControl, SelectField, SwitchField, TextField } from "@/components/forms/fields";
import { AppReviewDialog } from "@/components/config/AppReviewDialog";
import { PresetOptionsFields } from "@/components/new-project/PresetOptionsFields";
import { useConfigSave } from "@/components/config/useConfigSave";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AppConfig, BuildConfig, ConfigIssue, PortConfig, ReleaseStepConfig } from "@/lib/agent-types";
import { createdNotice, portParts, reviewChanges, saveEffect, saveNotice } from "@/lib/app-config-core";
import { verifyError, verifyFromLines, verifyLine } from "@/lib/soak-config-core";
import { mergeBuild, optionsFromBuild, presetOf, PRESET_LIST, validatePresetOptions, type PresetErrors, type PresetField, type PresetId, type PresetOptions } from "@/lib/presets-core";

type AppRestart = Exclude<NonNullable<AppConfig["restart"]>, "">;

const RESTART_OPTIONS: { value: AppRestart | "default"; label: string }[] = [
  { value: "default", label: "Default (not set)" },
  { value: "no", label: "Never restart" },
  { value: "always", label: "Always restart" },
  { value: "unless-stopped", label: "Restart unless stopped" },
  { value: "on-failure", label: "Restart on failure" },
];

type LogDriver = NonNullable<NonNullable<AppConfig["log"]>["driver"]>;

const LOG_DRIVER_OPTIONS: { value: LogDriver | "default"; label: string }[] = [
  { value: "default", label: "Default (json-file)" },
  { value: "json-file", label: "json-file" },
  { value: "local", label: "local" },
];

const BUILD_FIELDS: readonly PresetField[] = ["context", "install", "build_command", "start", "output_dir", "node", "dockerfile", "target"];

const LOG_SIZE = /^[1-9][0-9]{0,5}[kmg]$/;

interface StepDraft {
  name: string;
  kind: "host" | "container" | "backup";
  /** The database a backup step backs up. */
  database: string;
  /** The command of a host step. */
  host: string[];
  dir: string;
  /** The command of a container step. */
  command: string[];
  image: string;
  timeout: string;
  continueOnFailure: boolean;
}

/** What the app has that this form has no field for: it goes back as the file has it, so that saving the form loses nothing. */
type Untouched = Pick<AppConfig, "previews" | "database" | "source" | "deploy">;

interface AppDraft {
  name: string;
  project: string;
  environment: string;
  image: string;
  restart: AppRestart | "default";
  command: string[];
  envFile: string;
  env: KeyValueRow[];
  network: string;
  publish: string[];
  volumes: string[];
  domains: string[];
  /** `port` (or `port.container`). */
  port: string;
  /** `port.host`: the two host ports of an app on the host network. */
  hostPorts: [string, string];
  /** `port.env`. */
  portEnv: string;
  healthPath: string;
  stopTimeout: string;
  healthTimeout: string;
  stableAfter: string;
  drain: string;
  soak: string;
  verify: string[];
  steps: StepDraft[];
  onRollback: boolean;
  logDriver: LogDriver | "default";
  logMaxSize: string;
  logMaxFile: string;
  keepImages: string;
  untouched: Untouched;
  /**
   * The `build:` block the app has (absent for an app that is not built by the agent). The form shows its preset and the
   * options of it; whatever else it holds (limits, `args`, `max_source`) goes back as it was.
   */
  build: BuildConfig | undefined;
  buildPreset: PresetId;
  buildOptions: PresetOptions;
  /** The build runs on the server's own network (`build.network: host`): it can then reach a database on 127.0.0.1. */
  buildHostNetwork: boolean;
  /** The build uses the app's managed database (`build.database: true`). */
  buildDatabase: boolean;
}

function numberText(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

function emptyStep(): StepDraft {
  return { name: "", kind: "host", database: "", host: [""], dir: "", command: [""], image: "", timeout: "", continueOnFailure: false };
}

function stepDraft(step: ReleaseStepConfig): StepDraft {
  return {
    name: step.name,
    kind: step.backup ? "backup" : step.container ? "container" : "host",
    database: step.backup ?? "",
    host: step.host?.length ? step.host : [""],
    dir: step.dir ?? "",
    command: step.container?.command?.length ? step.container.command : [""],
    image: step.container?.image ?? "",
    timeout: step.timeout ?? "",
    continueOnFailure: step.continue_on_failure ?? false,
  };
}

export function draftFromApp(app: AppConfig | undefined): AppDraft {
  const port = portParts(app?.port);
  const untouched: Untouched = {};
  if (app?.previews !== undefined) untouched.previews = app.previews;
  if (app?.database !== undefined) untouched.database = app.database;
  if (app?.source !== undefined) untouched.source = app.source;
  if (app?.deploy !== undefined) untouched.deploy = app.deploy;
  return {
    name: app?.name ?? "",
    project: app?.project ?? "",
    environment: app?.environment ?? "",
    image: app?.image ?? "",
    restart: app?.restart ? app.restart : "default",
    command: app?.command ?? [],
    envFile: app?.env_file ?? "",
    env: keyValueRows(app?.env),
    network: app?.network ?? "",
    publish: app?.publish ?? [],
    volumes: app?.volumes ?? [],
    domains: app?.domains ?? [],
    port: numberText(port.container),
    hostPorts: [numberText(port.host?.[0]), numberText(port.host?.[1])],
    portEnv: port.env ?? "",
    healthPath: app?.health_path ?? "",
    stopTimeout: app?.stop_timeout ?? "",
    healthTimeout: app?.health_timeout ?? "",
    stableAfter: app?.stable_after ?? "",
    drain: app?.drain ?? "",
    soak: app?.soak ?? "",
    verify: (app?.verify ?? []).map(verifyLine),
    steps: app?.release?.steps.map(stepDraft) ?? [],
    onRollback: app?.release?.on_rollback ?? false,
    logDriver: app?.log?.driver ?? "default",
    logMaxSize: app?.log?.max_size ?? "",
    logMaxFile: numberText(app?.log?.max_file),
    keepImages: numberText(app?.keep_images),
    untouched,
    build: app?.build,
    buildPreset: presetOf(app?.build),
    buildOptions: optionsFromBuild(app?.build),
    buildHostNetwork: app?.build?.network === "host",
    buildDatabase: app?.build?.database === true,
  };
}

function stepConfig(step: StepDraft): ReleaseStepConfig {
  const out: ReleaseStepConfig = { name: step.name.trim() };
  if (step.kind === "backup") {
    out.backup = step.database.trim();
  } else if (step.kind === "host") {
    out.host = compact(step.host);
    const dir = optionalText(step.dir);
    if (dir) out.dir = dir;
  } else {
    out.container = { command: compact(step.command) };
    const image = optionalText(step.image);
    if (image) out.container.image = image;
  }
  const timeout = optionalText(step.timeout);
  if (timeout) out.timeout = timeout;
  if (step.continueOnFailure) out.continue_on_failure = true;
  return out;
}

/** The `port` to send: the number alone when only the container port is set, else the mapping. */
function portConfig(d: AppDraft): PortConfig | undefined {
  const container = toInteger(d.port);
  const first = toInteger(d.hostPorts[0]);
  const second = toInteger(d.hostPorts[1]);
  const env = optionalText(d.portEnv);
  const host = first !== undefined && second !== undefined ? [first, second] : undefined;
  if (host === undefined && env === undefined) return container;
  const out: Exclude<PortConfig, number> = {};
  if (container !== undefined) out.container = container;
  if (host !== undefined) out.host = host;
  if (env !== undefined) out.env = env;
  return out;
}

/** The app to send: empty optional fields are left out entirely. */
export function appFromDraft(d: AppDraft): AppConfig {
  const app: AppConfig = { name: d.name.trim(), image: d.image.trim() };
  const project = optionalText(d.project);
  if (project) app.project = project;
  const environment = optionalText(d.environment);
  if (environment) app.environment = environment;
  if (d.restart !== "default") app.restart = d.restart;
  const command = optionalList(d.command);
  if (command) app.command = command;
  const envFile = optionalText(d.envFile);
  if (envFile) app.env_file = envFile;
  const env = keyValueRecord(d.env);
  if (env) app.env = env;
  const network = optionalText(d.network);
  if (network) app.network = network;
  const publish = optionalList(d.publish);
  if (publish) app.publish = publish;
  const volumes = optionalList(d.volumes);
  if (volumes) app.volumes = volumes;
  const domains = optionalList(d.domains);
  if (domains) app.domains = domains;
  const port = portConfig(d);
  if (port !== undefined) app.port = port;
  const healthPath = optionalText(d.healthPath);
  if (healthPath) app.health_path = healthPath;
  const stopTimeout = optionalText(d.stopTimeout);
  if (stopTimeout) app.stop_timeout = stopTimeout;
  const healthTimeout = optionalText(d.healthTimeout);
  if (healthTimeout) app.health_timeout = healthTimeout;
  const stableAfter = optionalText(d.stableAfter);
  if (stableAfter) app.stable_after = stableAfter;
  const drain = optionalText(d.drain);
  if (drain) app.drain = drain;
  const soak = optionalText(d.soak);
  if (soak) app.soak = soak;
  const verify = verifyFromLines(d.verify);
  if (verify.length > 0) app.verify = verify;
  if (d.steps.length > 0) {
    app.release = { steps: d.steps.map(stepConfig) };
    if (d.onRollback) app.release.on_rollback = true;
  }
  const logDriver = d.logDriver === "default" ? undefined : d.logDriver;
  const logMaxSize = optionalText(d.logMaxSize);
  const logMaxFile = toInteger(d.logMaxFile);
  if (logDriver || logMaxSize || logMaxFile !== undefined) {
    app.log = {};
    if (logDriver) app.log.driver = logDriver;
    if (logMaxSize) app.log.max_size = logMaxSize;
    if (logMaxFile !== undefined) app.log.max_file = logMaxFile;
  }
  const keepImages = toInteger(d.keepImages);
  if (keepImages !== undefined) app.keep_images = keepImages;
  if (d.build !== undefined) {
    app.build = mergeBuild(d.build, d.buildPreset, d.buildOptions);
    // a network the form has no switch for (a user-defined network's name) stays as the file has it
    const named = d.build.network !== undefined && d.build.network !== "host" ? d.build.network : undefined;
    if (d.buildHostNetwork) app.build.network = "host";
    else if (named !== undefined) app.build.network = named;
    else delete app.build.network;
    if (d.buildDatabase) app.build.database = true;
    else delete app.build.database;
  }
  return { ...app, ...d.untouched };
}

/** The image is a repository: the tag or digest is chosen by each deploy. */
function imageError(image: string): string | undefined {
  const text = image.trim();
  if (text === "") return "Enter the image repository, for example ghcr.io/acme/web.";
  if (/\s/.test(text)) return "An image name has no spaces.";
  const lastSegment = text.slice(text.lastIndexOf("/") + 1);
  if (text.includes("@") || lastSegment.includes(":")) {
    return "Enter the repository only, without a tag or digest. Each deploy chooses the version.";
  }
  return undefined;
}

/** Every problem the form can find itself, by field. The agent has the last word on the rest. */
function validateApp(d: AppDraft, creating: boolean, existingNames: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (creating) {
    const name = d.name.trim();
    if (name === "") errors.name = "Enter a name.";
    else if (!NAME_PATTERN.test(name)) errors.name = `"${name}" is not a valid name. ${NAME_HINT}`;
    else if (existingNames.includes(name)) errors.name = `An app named ${name} already exists.`;
  }
  const image = imageError(d.image);
  if (image) errors.image = image;
  for (const [field, label] of [["project", "project"], ["environment", "environment"]] as const) {
    const value = d[field].trim();
    if (value !== "" && !NAME_PATTERN.test(value)) errors[field] = `"${value}" is not a valid ${label}. ${NAME_HINT}`;
  }

  const env = keyValueError(d.env, "variable", ENV_NAME, ENV_NAME_HINT);
  if (env) errors.env = env;

  const port = integerError(d.port, "The port", 1, 65535);
  if (port) errors.port = port;
  const [first, second] = d.hostPorts.map((p) => p.trim());
  const hostPorts =
    integerError(first, "The first host port", 1, 65535) ??
    integerError(second, "The second host port", 1, 65535) ??
    ((first === "") !== (second === "") ? "Give both host ports, or leave both empty." : undefined) ??
    (first !== "" && first === second ? "The two host ports must differ." : undefined);
  if (hostPorts) errors.port_host = hostPorts;
  const portEnv = optionalText(d.portEnv);
  if (portEnv && !ENV_NAME.test(portEnv)) errors.port_env_var = `Not a valid variable name. ${ENV_NAME_HINT}`;
  const healthPath = optionalText(d.healthPath);
  if (healthPath && !healthPath.startsWith("/")) errors.health_path = "The path starts with /, for example /healthz.";

  const stopTimeout = durationError(d.stopTimeout);
  if (stopTimeout) errors.stop_timeout = stopTimeout;
  const healthTimeout = durationError(d.healthTimeout);
  if (healthTimeout) errors.health_timeout = healthTimeout;
  const stableAfter = durationError(d.stableAfter);
  if (stableAfter) errors.stable_after = stableAfter;
  const drain = durationError(d.drain);
  if (drain) errors.drain = drain;
  const soak = durationError(d.soak);
  if (soak) errors.soak = soak;
  const verify = verifyError(d.verify);
  if (verify) errors.verify = verify;

  const logSize = optionalText(d.logMaxSize);
  if (logSize && !LOG_SIZE.test(logSize)) errors["log.max_size"] = "A number and k, m or g, for example 10m.";
  const logFiles = integerError(d.logMaxFile, "The number of files", 1, 100);
  if (logFiles) errors["log.max_file"] = logFiles;
  const keepImages = integerError(d.keepImages, "The number of versions", 1, 100);
  if (keepImages) errors.keep_images = keepImages;

  if (d.build !== undefined) {
    for (const [field, message] of Object.entries(validatePresetOptions(d.buildPreset, d.buildOptions))) errors[`build.${field}`] = message;
  }

  d.steps.forEach((step, i) => {
    const key = `release.${i}`;
    if (step.name.trim() === "") errors[`${key}.name`] = "Name this step.";
    if (step.kind === "backup") {
      if (step.database.trim() === "") errors[`${key}.backup`] = "Name the database to back up.";
    } else {
      const field = step.kind === "host" ? "host" : "command";
      const list = listRequiredError(step.kind === "host" ? step.host : step.command, "argument");
      if (list) errors[`${key}.${field}`] = list;
    }
    const timeout = durationError(step.timeout);
    if (timeout) errors[`${key}.timeout`] = timeout;
  });
  return errors;
}

const SECTION_FIELDS = {
  image: ["name", "project", "environment", "image", "restart", "command"],
  environment: ["env_file", "env"],
  networking: ["network", "publish", "volumes", "domains", "port", "health_path"],
  timing: ["stop_timeout", "health_timeout", "stable_after", "drain", "soak", "verify"],
  housekeeping: ["log", "keep_images"],
  release: ["release"],
  build: ["build"],
};

interface Problems {
  issues: ConfigIssue[];
  message?: string;
  entity: string;
}

/** Create (no `app`) or edit one app's configuration. */
export function AppForm({
  serverId,
  baseHash,
  app,
  existingNames,
  hasProxy,
  servingImage = "",
  redirectTo,
  cancelHref,
  fixedProject,
}: {
  serverId: string;
  baseHash: string;
  /** Where to go after a save instead of the app's page (the project hub's `?from=`, already validated by the page). */
  redirectTo?: string;
  /** Creating from a project's hub: the new app is saved with this project label, shown read-only. Ignored when editing. */
  fixedProject?: string;
  /** Where Cancel goes instead of the server or the app's page. */
  cancelHref?: string;
  /** The app being edited; absent when creating. */
  app?: AppConfig;
  /** Names already taken, so that creating cannot silently replace an app. */
  existingNames: string[];
  hasProxy: boolean;
  /** The image reference that serves now (the container's image): the "Deploy" of a saved change opens prefilled with its tag. */
  servingImage?: string;
}) {
  const creating = app === undefined;
  const router = useRouter();
  const save = useConfigSave();
  const base = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<AppDraft>(() => (creating && fixedProject ? { ...draftFromApp(app), project: fixedProject } : draftFromApp(app)));
  const [problems, setProblems] = useState<Problems | null>(null);
  /** The app about to be saved while the review is open: nothing has been sent yet. */
  const [review, setReview] = useState<AppConfig | null>(null);

  const errors = validateApp(draft, creating, existingNames);
  const server = problems ? fieldIssues(problems.issues, problems.entity) : {};
  const fe = useFieldErrors(errors, server);
  const errorCount = Object.keys(errors).length;

  function set<K extends keyof AppDraft>(key: K, value: AppDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function setStep(index: number, step: StepDraft) {
    set(
      "steps",
      draft.steps.map((s, i) => (i === index ? step : s)),
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    fe.touchAll();
    if (errorCount > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setReview(appFromDraft(draft));
  }

  async function confirm(config: AppConfig) {
    setReview(null);
    const notice = creating ? createdNotice({ serverId, app: config.name }) : saveNotice(saveEffect(app, config), { serverId, app: config.name, servingImage });
    const { saved, result } = await save.run(
      `app ${config.name}`,
      ({ force }) => saveAppAction(serverId, config.name, config, { base_hash: baseHash, force }),
      notice,
    );
    if (saved) {
      router.push(redirectTo ?? `/servers/${serverId}/apps/${config.name}`);
      return;
    }
    if (!result.ok && result.kind === "invalid") {
      setProblems({ issues: result.issues, message: result.message, entity: `apps[${config.name}]` });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const id = (field: string) => `${base}-${field}`;
  const touch = (field: string) => () => fe.touch(field);
  const buildErrors: PresetErrors = {};
  for (const field of BUILD_FIELDS) {
    const message = fe.error(`build.${field}`);
    if (message !== undefined) buildErrors[field] = message;
  }
  const domainsWithoutProxy = !hasProxy && compact(draft.domains).length > 0;

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="max-w-3xl space-y-6">
      {problems && <SaveProblems issues={problems.issues} message={problems.message} />}
      {fe.submitted && errorCount > 0 && <FixFieldsNotice count={errorCount} />}

      <FormSection
        title="Image"
        description="What to run: the image repository, how it restarts and the command it starts with."
        flagged={sectionProblems(server, SECTION_FIELDS.image) !== undefined}
      >
        <TextField
          id={id("name")}
          label="Name"
          required
          help={creating ? NAME_HINT : "The name cannot be changed. To rename the app, delete it and create it again."}
          error={fe.error("name")}
          value={draft.name}
          onChange={(v) => set("name", v)}
          onBlur={touch("name")}
          readOnly={!creating}
          placeholder="web"
          mono
        />
        <TextField
          id={id("project")}
          label="Project"
          help={creating && fixedProject ? "The project this app is added to." : "Optional. Groups this app with the same project on other servers in the Projects view. Defaults to the app's name."}
          error={fe.error("project")}
          value={draft.project}
          onChange={(v) => set("project", v)}
          onBlur={touch("project")}
          readOnly={creating && !!fixedProject}
          placeholder={draft.name.trim() || "my-app"}
          mono
        />
        <TextField
          id={id("environment")}
          label="Environment"
          help="Optional: production, staging, dev… Which copy of the project this is. Defaults to production."
          error={fe.error("environment")}
          value={draft.environment}
          onChange={(v) => set("environment", v)}
          onBlur={touch("environment")}
          placeholder="production"
          mono
        />
        <TextField
          id={id("image")}
          label="Image repository"
          required
          help="The repository without a tag or digest, for example ghcr.io/acme/web. Each deploy chooses the tag."
          error={fe.error("image")}
          value={draft.image}
          onChange={(v) => set("image", v)}
          onBlur={touch("image")}
          placeholder="ghcr.io/acme/web"
          mono
        />
        <SelectField
          id={id("restart")}
          label="Restart policy"
          help="What Docker does when the container exits."
          error={fe.error("restart")}
          value={draft.restart}
          onChange={(value) => {
            const option = RESTART_OPTIONS.find((o) => o.value === value);
            if (option) set("restart", option.value);
          }}
          options={RESTART_OPTIONS}
        />
        <StringListField
          id={id("command")}
          label="Command"
          help="Replaces the image's own command. One entry per argument; leave empty to use the image's command."
          error={fe.error("command")}
          values={draft.command}
          onChange={(v) => set("command", v)}
          addLabel="Add argument"
        />
      </FormSection>

      <FormSection
        title="Variables"
        description="Variables the container starts with."
        flagged={sectionProblems(server, SECTION_FIELDS.environment) !== undefined}
      >
        <TextField
          id={id("env_file")}
          label="Environment file"
          help="Path of an env file on the server, read when the container starts."
          error={fe.error("env_file")}
          value={draft.envFile}
          onChange={(v) => set("envFile", v)}
          onBlur={touch("env_file")}
          placeholder="/etc/acme/web.env"
          mono
        />
        <KeyValueField
          id={id("env")}
          label="Variables"
          noun="variable"
          help="Values are write-only: once saved they are shown as Set and never displayed again. Replace a value to change it."
          error={fe.error("env")}
          rows={draft.env}
          onChange={(rows) => set("env", rows)}
          onBlur={touch("env")}
          keyPlaceholder="NAME"
          addLabel="Add variable"
        />
      </FormSection>

      <FormSection
        title="Networking and routing"
        description="How the app is reached."
        flagged={sectionProblems(server, SECTION_FIELDS.networking) !== undefined}
      >
        <TextField
          id={id("network")}
          label="Docker network"
          help="Leave empty to use the default network."
          error={fe.error("network")}
          value={draft.network}
          onChange={(v) => set("network", v)}
          onBlur={touch("network")}
          placeholder="my-network"
          mono
        />
        <StringListField
          id={id("publish")}
          label="Published ports"
          help="host:container, for example 8080:80."
          error={fe.error("publish")}
          values={draft.publish}
          onChange={(v) => set("publish", v)}
          placeholder="8080:80"
          addLabel="Add port"
        />
        <StringListField
          id={id("volumes")}
          label="Volumes"
          help="source:target, for example /srv/data:/data or a named volume."
          error={fe.error("volumes")}
          values={draft.volumes}
          onChange={(v) => set("volumes", v)}
          placeholder="/srv/data:/data"
          addLabel="Add volume"
        />
        <div className="space-y-5 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm text-muted-foreground">
            Setting domains, port and host ports makes deploys blue/green: the new version starts beside the old one and traffic switches
            over with no downtime. This needs a proxy section in the{" "}
            <Link href={`/servers/${serverId}/config`} className="font-medium text-foreground underline underline-offset-4">
              Configuration
            </Link>
            .
          </p>
          {domainsWithoutProxy && (
            <Notice tone="warning" title="No proxy section">
              The configuration has no proxy section, so these domains will not be routed. Add one in the Configuration before deploying.
            </Notice>
          )}
          <StringListField
            id={id("domains")}
            label="Domains"
            help="Hostnames the proxy routes to this app."
            error={fe.error("domains")}
            values={draft.domains}
            onChange={(v) => set("domains", v)}
            placeholder="app.example.com"
            addLabel="Add domain"
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id={id("port")}
              label="Container port"
              help="The port the app listens on inside the container."
              error={fe.error("port")}
              value={draft.port}
              onChange={(v) => set("port", v)}
              onBlur={touch("port")}
              inputMode="numeric"
              placeholder="8080"
              mono
            />
            <FieldShell
              id={id("port_host")}
              label="Host ports"
              help="Two free ports on the server that the two versions take turns on."
              error={fe.error("port_host")}
              group
            >
              <div className="grid grid-cols-2 gap-2">
                {([0, 1] as const).map((i) => (
                  <Input
                    key={i}
                    value={draft.hostPorts[i]}
                    onChange={(event) =>
                      set("hostPorts", i === 0 ? [event.target.value, draft.hostPorts[1]] : [draft.hostPorts[0], event.target.value])
                    }
                    onBlur={touch("port_host")}
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label={i === 0 ? "First host port" : "Second host port"}
                    aria-invalid={fe.error("port_host") ? true : undefined}
                    aria-describedby={`${id("port_host")}-help${fe.error("port_host") ? ` ${id("port_host")}-error` : ""}`}
                    placeholder={i === 0 ? "9001" : "9002"}
                    className="font-mono"
                  />
                ))}
              </div>
            </FieldShell>
            <TextField
              id={id("port_env_var")}
              label="Port variable"
              help="Environment variable that tells the app which port to listen on."
              error={fe.error("port_env_var")}
              value={draft.portEnv}
              onChange={(v) => set("portEnv", v)}
              onBlur={touch("port_env_var")}
              placeholder="PORT"
              mono
            />
            <TextField
              id={id("health_path")}
              label="Health check path"
              help="Requested on the new version before traffic switches."
              error={fe.error("health_path")}
              value={draft.healthPath}
              onChange={(v) => set("healthPath", v)}
              onBlur={touch("health_path")}
              placeholder="/healthz"
              mono
            />
          </div>
        </div>
      </FormSection>

      <FormSection
        title="Health and timing"
        description="How long a deploy waits at each stage."
        flagged={sectionProblems(server, SECTION_FIELDS.timing) !== undefined}
      >
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <DurationField
            id={id("stop_timeout")}
            label="Stop timeout"
            help={`How long the old container gets to stop. ${DURATION_HINT}`}
            error={fe.error("stop_timeout")}
            value={draft.stopTimeout}
            onChange={(v) => set("stopTimeout", v)}
            onBlur={touch("stop_timeout")}
            placeholder="30s"
          />
          <DurationField
            id={id("health_timeout")}
            label="Health timeout"
            help={`How long the new version has to become healthy. ${DURATION_HINT}`}
            error={fe.error("health_timeout")}
            value={draft.healthTimeout}
            onChange={(v) => set("healthTimeout", v)}
            onBlur={touch("health_timeout")}
            placeholder="90s"
          />
          <DurationField
            id={id("stable_after")}
            label="Stable after"
            help={`How long it must stay healthy before the deploy counts as done. ${DURATION_HINT}`}
            error={fe.error("stable_after")}
            value={draft.stableAfter}
            onChange={(v) => set("stableAfter", v)}
            onBlur={touch("stable_after")}
            placeholder="5m"
          />
          <DurationField
            id={id("drain")}
            label="Drain"
            help={`With a proxy: how long the old version keeps running after traffic moves, so no request is refused. ${DURATION_HINT}`}
            error={fe.error("drain")}
            value={draft.drain}
            onChange={(v) => set("drain", v)}
            onBlur={touch("drain")}
            placeholder="5s"
          />
          <DurationField
            id={id("soak")}
            label="Soak"
            help={`With a proxy: how long the new version is watched after traffic moves, with the old one still running. If it fails, traffic goes back. Default 30s, 0s turns it off. ${DURATION_HINT}`}
            error={fe.error("soak")}
            value={draft.soak}
            onChange={(v) => set("soak", v)}
            onBlur={touch("soak")}
            placeholder="30s"
          />
        </div>
        <StringListField
          id={id("verify")}
          label="Pages checked during the soak"
          help="One per line: the path, then the status it must answer if it is not a 2xx (for example /moved 301). The health path is always checked. They are requested on the new container, not through your domain."
          error={fe.error("verify")}
          values={draft.verify}
          onChange={(v) => set("verify", v)}
          placeholder="/products/1"
          addLabel="Add page"
        />
      </FormSection>

      <FormSection
        title="Logs and old images"
        description="Keep the server's disk from filling up. Logs are rotated and old images removed after each successful deploy."
        flagged={sectionProblems(server, SECTION_FIELDS.housekeeping) !== undefined}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <SelectField
            id={id("log_driver")}
            label="Log driver"
            help="Both rotate by size. Local is more compact; json-file is what Docker shows by default."
            error={fe.error("log.driver")}
            value={draft.logDriver}
            onChange={(value) => {
              const option = LOG_DRIVER_OPTIONS.find((o) => o.value === value);
              if (option) set("logDriver", option.value);
            }}
            options={LOG_DRIVER_OPTIONS}
          />
          <TextField
            id={id("keep_images")}
            label="Versions kept on the server"
            help="The running version counts. Older images of this app are removed after a successful deploy (3 when empty)."
            error={fe.error("keep_images")}
            value={draft.keepImages}
            onChange={(v) => set("keepImages", v)}
            onBlur={touch("keep_images")}
            inputMode="numeric"
            placeholder="3"
            mono
          />
          <TextField
            id={id("log_max_size")}
            label="Rotate a log file at"
            help="A number and k, m or g (10m when empty)."
            error={fe.error("log.max_size")}
            value={draft.logMaxSize}
            onChange={(v) => set("logMaxSize", v)}
            onBlur={touch("log.max_size")}
            placeholder="10m"
            mono
          />
          <TextField
            id={id("log_max_file")}
            label="Log files kept"
            help="Rotated files per container (3 when empty)."
            error={fe.error("log.max_file")}
            value={draft.logMaxFile}
            onChange={(v) => set("logMaxFile", v)}
            onBlur={touch("log.max_file")}
            inputMode="numeric"
            placeholder="3"
            mono
          />
        </div>
      </FormSection>

      {draft.build !== undefined && (
        <FormSection
          title="Build"
          description="How the agent builds this app from its repository: a framework preset, which writes the Dockerfile itself, or the repository's own Dockerfile. Limits and build arguments set in the server's configuration are kept."
          problems={sectionProblems(server, SECTION_FIELDS.build)}
        >
          <SelectField
            id={id("build-preset")}
            label="Framework"
            value={draft.buildPreset}
            onChange={(v) => set("buildPreset", v as PresetId)}
            options={PRESET_LIST.map((p) => ({ value: p.id, label: p.label }))}
          />
          <PresetOptionsFields
            preset={draft.buildPreset}
            options={draft.buildOptions}
            onChange={(o) => set("buildOptions", o)}
            errors={buildErrors}
            idPrefix={id("build")}
          />
          <SwitchField
            id={id("build-host-network")}
            label="Build on the server's network"
            help="Lets the build reach a database on this server (127.0.0.1) while it builds, for a framework that queries it. The build's code then sees every port this server listens on: turn it on only for a repository you trust."
            checked={draft.buildHostNetwork}
            onChange={(v) => set("buildHostNetwork", v)}
          />
          <SwitchField
            id={id("build-database")}
            label="The build uses the app's database"
            help="For a build that queries its database to build (static pages filled from it). The managed database's URL is given to the build as a build argument, which leaves its password in the build's own layers on this server, and the build runs on the network that reaches the database. Make sure the Dockerfile creates the tables itself on a new, empty database."
            checked={draft.buildDatabase}
            onChange={(v) => set("buildDatabase", v)}
          />
        </FormSection>
      )}

      <FormSection
        title="Release steps"
        description="Commands that run in order on every deploy, before anything serving is touched."
        problems={sectionProblems(server, SECTION_FIELDS.release)}
      >
        {draft.steps.length === 0 && <p className="text-sm text-muted-foreground">No release steps. Add one to run migrations or other preparation before a deploy.</p>}
        {draft.steps.map((step, i) => (
          <ReleaseStepEditor
            key={i}
            id={id(`step-${i}`)}
            index={i}
            count={draft.steps.length}
            step={step}
            errors={{ name: fe.error(`release.${i}.name`), host: fe.error(`release.${i}.host`), command: fe.error(`release.${i}.command`), backup: fe.error(`release.${i}.backup`), timeout: fe.error(`release.${i}.timeout`) }}
            onChange={(next) => setStep(i, next)}
            onMove={(delta) => set("steps", moveItem(draft.steps, i, delta))}
            onRemove={() =>
              set(
                "steps",
                draft.steps.filter((_, j) => j !== i),
              )
            }
          />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => set("steps", [...draft.steps, emptyStep()])}>
          <ICONS.add />
          Add step
        </Button>
        {draft.steps.length > 0 && (
          <SwitchField
            id={id("on_rollback")}
            label="Run the steps on rollback too"
            help="By default release steps only run when deploying."
            checked={draft.onRollback}
            onChange={(v) => set("onRollback", v)}
          />
        )}
      </FormSection>

      <FormFooter pending={save.pending} saveLabel={creating ? "Create app" : "Save changes"} cancelHref={cancelHref ?? (creating ? `/servers/${serverId}` : `/servers/${serverId}/apps/${draft.name}`)} />
      <AppReviewDialog
        open={review !== null}
        onOpenChange={(open) => !open && setReview(null)}
        changes={review === null ? [] : reviewChanges(app, review)}
        creating={creating}
        pending={save.pending}
        onConfirm={() => review !== null && void confirm(review)}
      />
      {save.dialogs}
    </form>
  );
}

interface StepErrors {
  name?: string;
  host?: string;
  command?: string;
  backup?: string;
  timeout?: string;
}

function ReleaseStepEditor({
  id,
  index,
  count,
  step,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  index: number;
  count: number;
  step: StepDraft;
  errors: StepErrors;
  onChange: (step: StepDraft) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const noun = `step ${index + 1}${step.name.trim() ? ` (${step.name.trim()})` : ""}`;
  return (
    <fieldset className="space-y-4 rounded-lg border p-4">
      <legend className="sr-only">Release {noun}</legend>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium" aria-hidden>
          Step {index + 1}
        </p>
        <ReorderButtons noun={noun} index={index} count={count} onMove={onMove} onRemove={onRemove} />
      </div>
      <TextField
        id={`${id}-name`}
        label="Step name"
        required
        error={errors.name}
        value={step.name}
        onChange={(name) => onChange({ ...step, name })}
        placeholder="migrate"
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">
          Runs as
        </p>
        <SegmentedControl
          label={`How ${noun} runs`}
          value={step.kind}
          options={[
            { value: "host", label: "Program on the host" },
            { value: "container", label: "Container command" },
            { value: "backup", label: "Database backup" },
          ]}
          onChange={(kind) => {
            if (kind === "host" || kind === "container" || kind === "backup") onChange({ ...step, kind });
          }}
        />
      </div>
      {step.kind === "backup" ? (
        <TextField
          id={`${id}-backup`}
          label="Database"
          required
          help="A database declared under Databases, with a backup section. It is backed up and the stored copy checked first; if that fails, nothing after this step runs. Put it before the migration."
          error={errors.backup}
          value={step.database}
          onChange={(database) => onChange({ ...step, database })}
          placeholder="shop"
          mono
        />
      ) : step.kind === "host" ? (
        <>
          <StringListField
            id={`${id}-run`}
            label="Program and arguments"
            required
            help="The first entry is the program; the rest are its arguments."
            error={errors.host}
            values={step.host}
            onChange={(host) => onChange({ ...step, host })}
            placeholder="./scripts/migrate.sh"
            addLabel="Add argument"
          />
          <TextField
            id={`${id}-dir`}
            label="Working directory"
            help="Optional: the directory on the server the program starts in."
            value={step.dir}
            onChange={(dir) => onChange({ ...step, dir })}
            placeholder="/srv/web"
            mono
          />
        </>
      ) : (
        <>
          <StringListField
            id={`${id}-command`}
            label="Command"
            required
            help="One entry per argument."
            error={errors.command}
            values={step.command}
            onChange={(command) => onChange({ ...step, command })}
            placeholder="migrate"
            addLabel="Add argument"
          />
          <TextField
            id={`${id}-image`}
            label="Image"
            help="Optional: the image to run the command in."
            value={step.image}
            onChange={(image) => onChange({ ...step, image })}
            placeholder="ghcr.io/acme/web"
            mono
          />
        </>
      )}
      <DurationField
        id={`${id}-timeout`}
        label="Timeout"
        help={`Optional: stop the step after this long. ${DURATION_HINT}`}
        error={errors.timeout}
        value={step.timeout}
        onChange={(timeout) => onChange({ ...step, timeout })}
        placeholder="5m"
      />
      <SwitchField
        id={`${id}-continue`}
        label="Continue if this step fails"
        help="Otherwise a failing step stops the deploy."
        checked={step.continueOnFailure}
        onChange={(continueOnFailure) => onChange({ ...step, continueOnFailure })}
      />
    </fieldset>
  );
}
