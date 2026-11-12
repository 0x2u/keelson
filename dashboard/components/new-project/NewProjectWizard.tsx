"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { createProjectAction, inspectRepoAction, retryCreateProjectAction } from "@/app/new-project-actions";
import { CheckboxField } from "@/components/forms/fields";
import { ConfigureStep, type DnsState } from "@/components/new-project/ConfigureStep";
import { FrameworkStep, type DockerfileLookupState } from "@/components/new-project/FrameworkStep";
import { ProgressPanel } from "@/components/new-project/Progress";
import { RepositoryStep, type PickableRepo } from "@/components/new-project/RepositoryStep";
import { ReviewStep } from "@/components/new-project/ReviewStep";
import { Stepper } from "@/components/new-project/Stepper";
import { BackupKeyNotice } from "@/components/new-project/BackupKeyNotice";
import { DatabaseCard } from "@/components/new-project/DatabaseCard";
import { EnvNamesHint } from "@/components/new-project/EnvNamesHint";
import { VariablesStep } from "@/components/new-project/VariablesStep";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { toastActionError } from "@/components/unlock";
import { isStepUpError } from "@/lib/gate-core";
import { isHostname } from "@/lib/address-core";
import type { DnsChoice, ProjectOutcome, ProjectVar, RetryStep } from "@/lib/new-project-core";
import { DATABASE_ENV_KEY, portKeysFor, varProblems } from "@/lib/new-project-core";
import {
  WIZARD_STEPS,
  applySuggestion,
  chooseCandidate,
  chooseFramework,
  clearSuggestion,
  dnsSummary,
  effectiveInput,
  initialInput,
  isAdvancedField,
  stepErrors,
  stepIndex,
  type AppliedSuggestion,
  type ProjectServer,
  withDefaultDomain,
  writtenContext,
  type StepId,
} from "@/lib/new-project-wizard-core";
import { planWizard } from "@/lib/dns-record-core";
import type { PresetId, PresetOptions } from "@/lib/presets-core";
import type { ProjectSuggestion } from "@/lib/project-suggest-core";
import { suggestName, validateReview, type ReviewErrorKey, type ReviewErrors, type ReviewField, type ReviewInput } from "@/lib/repo-detect-core";
import { cn } from "@/lib/utils";

/**
 * New project: five steps on one page, each one's input kept in this component's state, so going back and forward
 * never loses anything. Choosing a repository reads it: what it suggests (a framework card, a release command, a
 * database, its variables' names) is put in or shown, and every suggestion can be changed. Nothing is written
 * before the button of the last step. Variable values exist only in this state until then.
 */
export function NewProjectWizard({
  repos,
  servers,
  initialRepo,
  initialServer,
  initialStep,
}: {
  repos: PickableRepo[];
  /** At least one: online, with a deploy secret and a readable apps file. */
  servers: ProjectServer[];
  /** `?repo=`: starts on the framework step with it chosen. */
  initialRepo?: string;
  /** `?server=`: the server is given, not asked. */
  initialServer?: string;
  /** For rendering a step directly (tests, screenshots). */
  initialStep?: StepId;
}) {
  const prefix = useId();
  const fixed = initialServer !== undefined && servers.some((s) => s.id === initialServer);
  const firstServer = fixed ? servers.find((s) => s.id === initialServer)! : servers[0];
  const startRepo = repos.find((r) => r.fullName === initialRepo);

  const [serverId, setServerId] = useState(firstServer.id);
  const server = servers.find((s) => s.id === serverId) ?? firstServer;
  const [repo, setRepo] = useState(startRepo?.fullName ?? "");
  const [step, setStep] = useState<StepId>(initialStep ?? (startRepo ? "framework" : "repository"));
  const [furthest, setFurthest] = useState(stepIndex(initialStep ?? (startRepo ? "framework" : "repository")));
  const [input, setInput] = useState<ReviewInput>(() => {
    const base = initialInput({ name: "", branch: startRepo?.defaultBranch ?? "main", hostPort: firstServer.hostPort, domains: firstServer.context.proxy === "caddy" });
    return withDefaultDomain(startRepo ? { ...base, name: suggestName(startRepo.fullName, firstServer.context.existingNames).name } : base, firstServer, false);
  });
  const [nameTaken, setNameTaken] = useState(startRepo ? suggestName(startRepo.fullName, firstServer.context.existingNames).taken : false);
  const [lookup, setLookup] = useState<DockerfileLookupState>({ status: "idle" });
  const [candidate, setCandidate] = useState("");
  // The branches of the chosen repository, for the menu; empty until read, or when GitHub does not give them.
  const [branches, setBranches] = useState<string[]>([]);
  // What the chosen repository suggests, and what of it is in the form (taken out again if another repository is chosen).
  const [suggestion, setSuggestion] = useState<ProjectSuggestion | null>(null);
  const applied = useRef<AppliedSuggestion | null>(null);
  const inputRef = useRef<ReviewInput | null>(null);
  const [vars, setVars] = useState<ProjectVar[]>([]);
  const [dns, setDns] = useState<DnsState>({ create: true, proxied: true, allowPrivate: false });
  const [replaceOk, setReplaceOk] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [tried, setTried] = useState<Partial<Record<StepId, boolean>>>({});
  const [outcome, setOutcome] = useState<ProjectOutcome | null>(null);
  const [database, setDatabase] = useState(false);
  // The backup key of the new database: held here from the moment it arrives until the operator says it is saved.
  const [backupKey, setBackupKey] = useState<{ key: string; recipient?: string } | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const sectionRef = useRef<HTMLDivElement>(null);
  const lookupFor = useRef("");
  // Set once the operator types a domain: the apps domain's default then stops following the name.
  const domainEdited = useRef(false);

  const done = outcome?.steps.config.state === "done";
  const formContext = useMemo(() => (done ? writtenContext(server.context) : server.context), [done, server.context]);
  const databaseWanted = database && server.databaseSupported;
  // The build only gets a database that is created with the project.
  const sent = useMemo(() => ({ ...effectiveInput(input, formContext), buildDatabase: input.buildDatabase && databaseWanted }), [input, formContext, databaseWanted]);
  const checked = useMemo(() => validateReview(sent, formContext), [sent, formContext]);
  const errors: ReviewErrors = checked.ok ? {} : checked.errors;
  const supported = server.envSupported;
  const effectiveVars = supported ? vars : [];
  const varIssues = varProblems(sent, effectiveVars, databaseWanted);

  const set = <K extends ReviewField>(field: K, value: ReviewInput[K]) => {
    if (field === "domain") domainEdited.current = true;
    const edited = domainEdited.current;
    // the name drives the default domain, until the operator types one
    setInput((prev) => {
      const next = { ...prev, [field]: value };
      return field === "name" ? withDefaultDomain(next, server, edited) : next;
    });
  };
  const current = lookup.status === "ready" ? lookup.candidates.find((c) => c.path === candidate) : undefined;
  const previewsOffered = server.context.previewApps.includes(input.name.trim());

  // The first invalid field of the step that is showing (the other steps are hidden, not unmounted, to keep what they hold).
  const focusInvalid = () => requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('section:not([hidden]) [aria-invalid="true"]')?.focus());

  // A field the server refused, or variables it found wrong, bring the operator to the step that has them.
  const applyOutcome = (out: ProjectOutcome) => {
    setOutcome(out);
    if (out.database?.backupKey) {
      setBackupKey({ key: out.database.backupKey, ...(out.database.backupRecipient ? { recipient: out.database.backupRecipient } : {}) });
      setKeySaved(false);
    }
    if (out.fieldErrors) {
      const keys = Object.keys(out.fieldErrors);
      setStep(keys.every((k) => k === "preset" || k === "dockerfile" || k === "context") ? "framework" : "configure");
    } else if (out.varIssues && out.steps.config.state !== "done") setStep("variables");
  };
  useEffect(() => {
    if (outcome?.fieldErrors) focusInvalid();
  }, [outcome, step]);

  const go = (to: StepId) => {
    setStep(to);
    setFurthest((f) => Math.max(f, stepIndex(to)));
    window.scrollTo({ top: 0 });
  };

  const selectRepo = (r: PickableRepo) => {
    if (r.fullName === repo) return;
    const named = suggestName(r.fullName, server.context.existingNames);
    setRepo(r.fullName);
    setNameTaken(named.taken);
    // what the previous repository suggested goes, unless the operator changed it
    const before = applied.current;
    applied.current = null;
    const edited = domainEdited.current;
    setInput((prev) =>
      withDefaultDomain({ ...(before ? clearSuggestion(prev, before) : prev), name: named.name, branch: r.defaultBranch, dockerfile: "Dockerfile", context: ".", ...(prev.preset === "dockerfile" ? { port: "" } : {}) }, server, edited),
    );
    setCandidate("");
    setBranches([]);
    void inspect(r.fullName);
  };

  // Reads the repository: its Dockerfiles and what it suggests. A suggestion only fills a form on which no card was chosen.
  const inspect = async (fullName: string) => {
    lookupFor.current = fullName;
    setLookup({ status: "loading" });
    setSuggestion(null);
    const found = await inspectRepoAction(fullName);
    if (lookupFor.current !== fullName) return; // another repository was chosen meanwhile
    if (!found.ok) {
      setLookup({ status: "error", error: found.error });
      return;
    }
    setLookup({ status: "ready", candidates: found.candidates, truncated: found.truncated });
    setSuggestion(found.suggestion);
    setBranches(found.branches);
    const first = found.candidates[0];
    if (first) setCandidate(first.path);
    const latest = inputRef.current;
    if (latest === null) return;
    if (latest.preset === "dockerfile" && first) {
      setInput(chooseCandidate(latest, first));
      return;
    }
    const out = applySuggestion(latest, found.suggestion, first);
    if (out.applied !== null) {
      applied.current = out.applied;
      setInput(out.input);
    }
  };

  const choose = (id: PresetId) => {
    setInput((prev) => chooseFramework(prev, id, id === "dockerfile" ? current : undefined));
    if (id === "dockerfile" && repo !== "" && lookupFor.current !== repo) void inspect(repo);
  };

  // The latest form, for the repository's answer, which comes after the render that asked.
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  // A repository the page was opened with (`?repo=`) is read at once, like one that is clicked.
  useEffect(() => {
    if (startRepo) void inspect(startRepo.fullName);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount: `inspect` only uses state setters and refs
  }, []);

  const pickCandidate = (path: string) => {
    if (lookup.status !== "ready") return;
    const c = lookup.candidates.find((x) => x.path === path);
    if (!c) return;
    setCandidate(path);
    setInput((prev) => chooseCandidate(prev, c));
  };

  const chooseServer = (id: string) => {
    const next = servers.find((s) => s.id === id);
    if (!next) return;
    setServerId(id);
    const edited = domainEdited.current;
    setInput((prev) => withDefaultDomain({ ...prev, hostPort: String(next.hostPort), exposure: next.context.proxy === "caddy" ? prev.exposure : "local" }, next, edited));
    if (repo !== "") setNameTaken(suggestName(repo, next.context.existingNames).taken);
  };

  const plan = sent.exposure === "domain" && isHostname(sent.domain.trim().toLowerCase()) ? planWizard(sent.domain.trim().toLowerCase(), server.dns) : null;
  const choice = (confirmReplace?: string): DnsChoice => ({
    create: plan?.kind === "cloudflare" && dns.create,
    proxied: dns.proxied,
    ...(dns.allowPrivate ? { allowPrivate: true } : {}),
    ...(confirmReplace ? { confirmReplace } : {}),
  });
  const problem = outcome?.dnsProblem;
  const confirmation = problem?.kind === "conflict" && replaceOk ? problem.confirm : undefined;
  const domain = sent.domain.trim().toLowerCase();

  // Our own problems show after a first attempt to go on from their step; the server's (a name taken meanwhile) always. Once written nothing shows.
  const serverErrors: ReviewErrors = done ? {} : (outcome?.fieldErrors ?? {});
  const shownErrors: ReviewErrors = { ...(tried.configure && !done ? stepErrors("configure", errors, input.preset) : {}), ...serverErrors };
  const frameworkErrors: ReviewErrors = { ...(tried.framework && !done ? stepErrors("framework", errors, input.preset) : {}), ...serverErrors };

  const next = () => {
    if (step === "repository") {
      setTried((t) => ({ ...t, repository: true }));
      if (repo !== "") go("framework");
      return;
    }
    if (step === "framework") {
      setTried((t) => ({ ...t, framework: true }));
      if (Object.keys(stepErrors("framework", errors, input.preset)).length === 0) go("configure");
      else window.setTimeout(focusInvalid);
      return;
    }
    if (step === "configure") {
      setTried((t) => ({ ...t, configure: true }));
      const here = stepErrors("configure", errors, input.preset);
      if (Object.keys(here).length === 0) {
        go("variables");
        return;
      }
      if ((Object.keys(here) as ReviewErrorKey[]).some(isAdvancedField)) setAdvanced(true);
      window.setTimeout(focusInvalid);
      return;
    }
    if (step === "variables") {
      setTried((t) => ({ ...t, variables: true }));
      if (varIssues.length === 0) go("review");
    }
  };
  const back = () => {
    const i = stepIndex(step);
    if (i > 0) go(WIZARD_STEPS[i - 1].id);
  };

  const submit = () => {
    if (!checked.ok || varIssues.length > 0) return;
    startTransition(async () => {
      // A successful creation redirects to the deployment; what comes back is what went wrong.
      applyOutcome(await createProjectAction(server.id, repo, sent, choice(), effectiveVars, databaseWanted));
    });
  };
  const retry = (from: RetryStep) =>
    startTransition(async () => {
      const out = await retryCreateProjectAction(server.id, repo, sent, from, choice(confirmation), effectiveVars, databaseWanted, backupKey !== null && !keySaved);
      // Refused for want of the unlock: nothing ran, so the steps on the page stay as they are, with their Retry button.
      if (isStepUpError(out.steps.config.detail) && out.steps.config.state === "failed" && out.retry === undefined) toastActionError("Could not retry", out.steps.config.detail);
      else applyOutcome(out);
    });

  const last = step === "review";
  const body: Record<StepId, ReactNode> = {
    repository: (
      <>
        {tried.repository && repo === "" && <p role="alert" className="mb-3 text-sm font-medium text-destructive">Choose the repository to build.</p>}
        <RepositoryStep repos={repos} selected={repo} onSelect={selectRepo} />
      </>
    ),
    framework: (
      <FrameworkStep
        preset={input.preset}
        onChoose={choose}
        lookup={lookup}
        suggested={suggestion?.framework ?? null}
        input={input}
        candidate={candidate}
        onPick={pickCandidate}
        onField={(f, v) => set(f, v)}
        errors={frameworkErrors}
        idPrefix={prefix}
      />
    ),
    configure: (
      <ConfigureStep
        input={input}
        onField={set}
        onOptions={(o: PresetOptions) => setInput((prev) => ({ ...prev, options: o }))}
        errors={shownErrors}
        servers={servers}
        serverId={serverId}
        serverFixed={fixed}
        onServer={chooseServer}
        branches={branches}
        candidate={current}
        dnsState={dns}
        onDns={(n) => setDns((d) => ({ ...d, ...n }))}
        advancedOpen={advanced}
        onAdvancedOpen={setAdvanced}
        previewsOffered={previewsOffered}
        nameTaken={nameTaken}
        repo={repo}
        releaseHint={suggestion?.release && input.release === suggestion.release.command ? `Suggested: ${suggestion.release.reason}` : undefined}
      />
    ),
    variables: (
      <div className="space-y-6">
        <DatabaseCard
          enabled={database}
          onChange={setDatabase}
          supported={server.databaseSupported}
          serverId={server.id}
          serverName={server.name}
          existingUrl={effectiveVars.some((v) => v.key === DATABASE_ENV_KEY)}
          suggestion={suggestion?.database?.reason}
          buildDatabase={input.buildDatabase}
          onBuildDatabase={(on) => set("buildDatabase", on)}
        />
        <EnvNamesHint names={suggestion?.envNames ?? []} already={vars.map((v) => v.key)} />
        <VariablesStep
          vars={vars}
          onChange={setVars}
          rules={{ portKeys: portKeysFor(input.preset, input.exposure) }}
          supported={supported}
          serverId={server.id}
          serverName={server.name}
          issues={tried.variables || outcome?.varIssues ? [...varIssues, ...(outcome?.varIssues ?? [])].filter((i, n, all) => all.findIndex((j) => j.key === i.key && j.message === i.message) === n) : []}
        />
      </div>
    ),
    review: (
      <ReviewStep
        repo={repo}
        serverName={server.name}
        review={checked.ok ? checked.review : null}
        variables={effectiveVars.map(({ key, build }) => ({ key, build }))}
        envSupported={supported}
        database={databaseWanted}
        dns={dnsSummary(sent, server.dns, plan?.kind === "cloudflare" && dns.create, dns.proxied)}
        errorCount={Object.keys(errors).length + varIssues.length}
      />
    ),
  };

  return (
    <div className="max-w-3xl space-y-6">
      <Stepper steps={WIZARD_STEPS} step={step} furthest={furthest} onGo={go} />
      {backupKey && (
        <BackupKeyNotice
          backupKey={backupKey.key}
          recipient={backupKey.recipient}
          saved={keySaved}
          onSaved={setKeySaved}
          deploymentHref={outcome?.deploymentId ? `/servers/${encodeURIComponent(server.id)}/deployments/${encodeURIComponent(outcome.deploymentId)}` : undefined}
        />
      )}
      {outcome && outcome.fieldErrors === undefined && outcome.deploymentId === undefined && (
        <ProgressPanel
          outcome={outcome}
          onRetry={retry}
          pending={pending}
          retryBlocked={problem?.kind === "conflict" && !replaceOk}
          dnsDecision={
            problem?.kind === "conflict" ? (
              <div className="mt-2 grid gap-2 rounded-md border border-warning/30 bg-warning/5 p-3">
                <p className="text-sm">
                  Now at Cloudflare: <span className="font-mono text-xs">{problem.confirm}</span>
                </p>
                <CheckboxField
                  id={`${prefix}-replace`}
                  label={`Replace ${problem.confirm} with ${plan?.kind === "cloudflare" ? `${plan.type} ${domain} → ${plan.ip}, ${dns.proxied ? "proxied" : "DNS only"}` : "the new record"}`}
                  checked={replaceOk}
                  onChange={setReplaceOk}
                />
              </div>
            ) : problem?.kind === "private" ? (
              <div className="mt-2">
                <CheckboxField id={`${prefix}-private`} label={`Use ${problem.ip} anyway (a private network or split-horizon DNS)`} checked={dns.allowPrivate} onChange={(v) => setDns((d) => ({ ...d, allowPrivate: v }))} />
              </div>
            ) : undefined
          }
        />
      )}
      {outcome?.fieldErrors && !done && (
        <Notice title="The server refused some fields">Fix the fields marked below, then create the project again.</Notice>
      )}

      <fieldset disabled={done || pending} className="min-w-0 space-y-6 border-0 p-0 disabled:opacity-80">
        <div ref={sectionRef}>
          {WIZARD_STEPS.map((s) => (
            <section key={s.id} hidden={s.id !== step} aria-labelledby={`${prefix}-h-${s.id}`} className={cn(s.id !== step && "hidden")}>
              <h2 id={`${prefix}-h-${s.id}`} className="mb-4 text-lg font-semibold">
                {STEP_TITLE[s.id]}
              </h2>
              {body[s.id]}
            </section>
          ))}
        </div>
      </fieldset>

      <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
        {step === "repository" ? (
          <Button asChild variant="outline">
            <Link href="/projects">Cancel</Link>
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={back} disabled={pending}>
            <ArrowLeftIcon />
            Back
          </Button>
        )}
        {!last ? (
          <Button type="button" onClick={next} disabled={pending}>
            Next
            <ArrowRightIcon />
          </Button>
        ) : (
          !done && (
            <Button type="button" onClick={submit} loading={pending} disabled={!checked.ok || varIssues.length > 0}>
              <ICONS.deploy />
              {pending ? "Creating…" : "Create the project and build it"}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

const STEP_TITLE: Record<StepId, string> = {
  repository: "Choose the repository",
  framework: "Choose how it is built",
  configure: "Configure the project",
  variables: "Variables",
  review: "Review and create",
};
