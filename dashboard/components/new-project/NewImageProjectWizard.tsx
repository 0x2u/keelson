"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { createImageProjectAction, retryImageProjectAction } from "@/app/new-project-actions";
import { FormSection } from "@/components/config/FormParts";
import { DnsPlan } from "@/components/domains/DnsPlan";
import { CheckboxField, FieldShell, SelectField, TextField } from "@/components/forms/fields";
import { ImageCreated } from "@/components/new-project/ImageCreated";
import { ImageReviewStep } from "@/components/new-project/ImageReviewStep";
import { ProgressPanel } from "@/components/new-project/Progress";
import { Stepper } from "@/components/new-project/Stepper";
import { VariablesStep } from "@/components/new-project/VariablesStep";
import { ServerStatsLine } from "@/components/ServerStatsLine";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { toastActionError } from "@/components/unlock";
import { isHostname } from "@/lib/address-core";
import { planWizard } from "@/lib/dns-record-core";
import { isStepUpError } from "@/lib/gate-core";
import { ICONS } from "@/lib/icons";
import type { DnsChoice, ProjectVar, RetryStep } from "@/lib/new-project-core";
import { portKeysFor, varProblems } from "@/lib/new-project-core";
import {
  imageEffective,
  suggestImageName,
  validateImageProject,
  type ImageOutcome,
  type ImageProjectErrors,
  type ImageProjectField,
  type ImageProjectInput,
} from "@/lib/new-project-image-core";
import { defaultDomain, dnsSummary, writtenContext, type ProjectServer } from "@/lib/new-project-wizard-core";
import { statsSummary } from "@/lib/server-stats-core";
import { PROXY_DOCS_URL } from "@/lib/public-url-help-core";

export const IMAGE_STEPS = [
  { id: "image", label: "Image" },
  { id: "variables", label: "Variables" },
  { id: "review", label: "Review" },
] as const;
export type ImageStepId = (typeof IMAGE_STEPS)[number]["id"];

const STEP_TITLE: Record<ImageStepId, string> = {
  image: "Describe what to run",
  variables: "Variables",
  review: "Review and deploy",
};

const stepIndex = (id: ImageStepId): number => IMAGE_STEPS.findIndex((s) => s.id === id);

/**
 * New project, from an image: the image with its tag, where it runs and how it is reached, optional variables, a review
 * of exactly what will be written, then one button that writes the app and deploys that tag. Each step's input stays in
 * this component's state; variable values exist only here until the button.
 */
export function NewImageProjectWizard({
  servers,
  initialServer,
  initialImage,
  initialStep,
}: {
  /** At least one: online, with a deploy secret and a readable apps file. */
  servers: ProjectServer[];
  /** `?server=`: the server is given, not asked. */
  initialServer?: string;
  /** `?image=`: the field starts with it. */
  initialImage?: string;
  /** For rendering a step directly (tests, screenshots). */
  initialStep?: ImageStepId;
}) {
  const prefix = useId();
  const fixed = initialServer !== undefined && servers.some((s) => s.id === initialServer);
  const firstServer = fixed ? servers.find((s) => s.id === initialServer)! : servers[0];
  const [serverId, setServerId] = useState(firstServer.id);
  const server = servers.find((s) => s.id === serverId) ?? firstServer;
  const [input, setInput] = useState<ImageProjectInput>(() => ({
    name: initialImage ? suggestImageName(initialImage, firstServer.context.existingNames) : "",
    image: initialImage ?? "",
    port: "80",
    domain: "",
    hostPort: String(firstServer.hostPort),
    open: false,
    healthPath: "",
  }));
  const [step, setStep] = useState<ImageStepId>(initialStep ?? "image");
  const [furthest, setFurthest] = useState(stepIndex(initialStep ?? "image"));
  const [tried, setTried] = useState<Partial<Record<ImageStepId, boolean>>>({});
  const [vars, setVars] = useState<ProjectVar[]>([]);
  const [dns, setDns] = useState({ create: true, proxied: true, allowPrivate: false });
  const [replaceOk, setReplaceOk] = useState(false);
  const [outcome, setOutcome] = useState<ImageOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const sectionRef = useRef<HTMLDivElement>(null);
  // Once the operator types the name or the domain, the image and the name stop driving them.
  const nameEdited = useRef(false);
  const domainEdited = useRef(false);

  const done = outcome?.steps.config.state === "done";
  const formContext = useMemo(() => (done ? writtenContext(server.context) : server.context), [done, server.context]);
  const sent = useMemo(() => imageEffective(input), [input]);
  const checked = useMemo(() => validateImageProject(sent, formContext), [sent, formContext]);
  const errors: ImageProjectErrors = checked.ok ? {} : checked.errors;
  const supported = server.envSupported;
  const effectiveVars = supported ? vars : [];
  const exposureKind = sent.domain === "" ? "local" : "domain";
  const varIssues = varProblems({ preset: "", exposure: exposureKind }, effectiveVars);
  const domainsOffered = server.context.proxy === "caddy";
  const domain = sent.domain;
  const plan = domainsOffered && isHostname(domain) ? planWizard(domain, server.dns) : null;
  const choice = (confirmReplace?: string): DnsChoice => ({
    create: plan?.kind === "cloudflare" && dns.create,
    proxied: dns.proxied,
    ...(dns.allowPrivate ? { allowPrivate: true } : {}),
    ...(confirmReplace ? { confirmReplace } : {}),
  });
  const problem = outcome?.dnsProblem;
  const confirmation = problem?.kind === "conflict" && replaceOk ? problem.confirm : undefined;

  const withDefaults = (next: ImageProjectInput, forServer: ProjectServer): ImageProjectInput => {
    const proposed = !domainEdited.current && forServer.context.proxy === "caddy" && forServer.appsDomain !== null ? defaultDomain(next.name, forServer.appsDomain) : next.domain;
    return { ...next, domain: proposed };
  };

  const set = <K extends ImageProjectField>(field: K, value: ImageProjectInput[K]) => {
    if (field === "domain") domainEdited.current = true;
    if (field === "name") nameEdited.current = true;
    setInput((prev) => {
      let next = { ...prev, [field]: value };
      if (field === "image" && !nameEdited.current) next = { ...next, name: typeof value === "string" && value.trim() !== "" ? suggestImageName(value, server.context.existingNames) : "" };
      return field === "name" || field === "image" ? withDefaults(next, server) : next;
    });
  };

  const chooseServer = (id: string) => {
    const next = servers.find((s) => s.id === id);
    if (!next) return;
    setServerId(id);
    setInput((prev) => withDefaults({ ...prev, hostPort: String(next.hostPort), domain: next.context.proxy === "caddy" ? prev.domain : "" }, next));
  };

  const focusInvalid = () => requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('section:not([hidden]) [aria-invalid="true"]')?.focus());
  const applyOutcome = (out: ImageOutcome) => {
    setOutcome(out);
    if (out.imageErrors) setStep("image");
    else if (out.varIssues && out.steps.config.state !== "done") setStep("variables");
  };
  useEffect(() => {
    if (outcome?.imageErrors) focusInvalid();
  }, [outcome, step]);

  const go = (to: ImageStepId) => {
    setStep(to);
    setFurthest((f) => Math.max(f, stepIndex(to)));
    window.scrollTo({ top: 0 });
  };
  const next = () => {
    if (step === "image") {
      setTried((t) => ({ ...t, image: true }));
      if (Object.keys(errors).length === 0) go("variables");
      else window.setTimeout(focusInvalid);
      return;
    }
    if (step === "variables") {
      setTried((t) => ({ ...t, variables: true }));
      if (varIssues.length === 0) go("review");
    }
  };
  const back = () => {
    const i = stepIndex(step);
    if (i > 0) go(IMAGE_STEPS[i - 1].id);
  };

  const submit = () => {
    if (!checked.ok || varIssues.length > 0) return;
    startTransition(async () => {
      applyOutcome(await createImageProjectAction(server.id, sent, choice(), effectiveVars));
    });
  };
  const retry = (from: RetryStep) =>
    startTransition(async () => {
      const out = await retryImageProjectAction(server.id, sent, from === "dns" || from === "build" ? from : "env", choice(confirmation), effectiveVars);
      // Refused for want of the unlock: nothing ran, so the steps on the page stay as they are, with their Retry button.
      if (isStepUpError(out.steps.config.detail) && out.steps.config.state === "failed" && out.retry === undefined) toastActionError("Could not retry", out.steps.config.detail);
      else applyOutcome(out);
    });

  const shown: ImageProjectErrors = done ? {} : { ...(tried.image ? errors : {}), ...(outcome?.imageErrors ?? {}) };
  const id = (field: string) => `${prefix}-${field}`;
  const hasPort = sent.port.trim() !== "";

  const body: Record<ImageStepId, ReactNode> = {
    image: (
      <div className="space-y-6">
        <FormSection title="What to run" description="A ready-made image from Docker Hub or another registry: Keelson pulls it on the server, starts it and keeps it running.">
          <TextField
            id={id("image")}
            label="Image"
            required
            placeholder="traefik/whoami:v1.10.3"
            help={
              <>
                With the tag (<span className="font-mono">nginx:1.27</span>) or a digest (<span className="font-mono">repo@sha256:…</span>) to deploy first. A private registry needs its credentials in the agent&apos;s{" "}
                <span className="font-mono">registries</span> list.
              </>
            }
            error={shown.image}
            value={input.image}
            onChange={(v) => set("image", v)}
            mono
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id={id("name")}
              label="Project name"
              required
              help="Also the name of the app on the server. Lowercase letters, digits, - and _."
              error={shown.name}
              value={input.name}
              onChange={(v) => set("name", v)}
              mono
            />
            {fixed || servers.length === 1 ? (
              <FieldShell id={id("server")} label="Server" group help="The app runs there.">
                <p className="text-sm font-medium">{server.name}</p>
                <ServerStatsLine stats={server.stats} />
              </FieldShell>
            ) : (
              <SelectField
                id={id("server")}
                label="Server"
                required
                help={
                  <>
                    Online servers that are not read-only here. The app runs there.
                    <ServerStatsLine stats={server.stats} className="mt-1.5" />
                  </>
                }
                value={serverId}
                onChange={chooseServer}
                options={servers.map((s) => ({ value: s.id, label: `${s.name} · ${statsSummary(s.stats)}` }))}
              />
            )}
          </div>
        </FormSection>

        <FormSection title="How it is reached" description="The port the container listens on, and where people open it.">
          <TextField
            id={id("port")}
            label="Container port"
            inputMode="numeric"
            placeholder="80"
            optional
            help="The port the app listens on inside the container (a web server usually 80). Leave it empty when the container publishes nothing, such as a worker."
            error={shown.port}
            value={input.port}
            onChange={(v) => set("port", v)}
            mono
          />
          {domainsOffered ? (
            <>
              <TextField
                id={id("domain")}
                label="Domain"
                optional
                placeholder="app.example.com"
                help={`Leave it empty to use a port on the server instead. With a domain its DNS record must point at this server: Keelson creates it at Cloudflare when connected, and says what to create otherwise. Caddy obtains the certificate itself once the name leads here.${server.appsDomain ? ` Filled in from this server's apps domain (${server.appsDomain}).` : ""}`}
                error={shown.domain}
                value={input.domain}
                onChange={(v) => set("domain", v)}
                mono
              />
              {plan && (
                <DnsPlan
                  hostname={domain}
                  plan={plan}
                  create={dns.create}
                  onCreate={(create) => setDns((d) => ({ ...d, create }))}
                  proxied={dns.proxied}
                  onProxied={(proxied) => setDns((d) => ({ ...d, proxied }))}
                  allowPrivate={dns.allowPrivate}
                  onAllowPrivate={(allowPrivate) => setDns((d) => ({ ...d, allowPrivate }))}
                  idPrefix={prefix}
                  address={server.dns.address.ok ? { ip: server.dns.address.ip, source: server.dns.address.source, settingsHref: `/servers/${server.id}/settings` } : undefined}
                />
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {server.context.proxy === "none" ? (
                <>
                  This server has no proxy, so it cannot serve a domain: the app gets a port on the server.{" "}
                  <a href={PROXY_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    How to serve apps on a domain
                  </a>
                </>
              ) : (
                "A domain is only offered with the Caddy proxy; this server uses another one, so the app gets a port on the server."
              )}
            </p>
          )}
          {domain !== "" ? (
            <TextField
              id={id("healthPath")}
              label="Health path"
              optional
              placeholder="/healthz"
              help="A path the agent requests on the new container, which must answer 2xx before traffic switches. Without it the image's own HEALTHCHECK counts, or that it stays running."
              error={shown.healthPath}
              value={input.healthPath}
              onChange={(v) => set("healthPath", v)}
              mono
            />
          ) : hasPort ? (
            <>
              <TextField
                id={id("hostPort")}
                label="Port on the server"
                required
                inputMode="numeric"
                help="The container port is published on this port of the server. The first one from 8100 that no app of this agent uses; what else listens on the server is not known."
                error={shown.hostPort}
                value={input.hostPort}
                onChange={(v) => set("hostPort", v)}
                mono
              />
              <CheckboxField
                id={id("open")}
                label="Let other computers connect"
                help="Off: published on 127.0.0.1 of the server only (reach it on the server, or through an SSH tunnel). On: published on every interface, over plain http, with no password: anyone who can reach the server's address can open it, and Docker publishes it even past a host firewall such as ufw."
                checked={input.open}
                onChange={(v) => set("open", v)}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing is published: the container runs, but no browser can reach it. Fill in the port to get an address.</p>
          )}
        </FormSection>
      </div>
    ),
    variables: (
      <div className="space-y-4">
        <VariablesStep
          forImage
          vars={vars}
          onChange={setVars}
          rules={{ portKeys: portKeysFor("", exposureKind) }}
          supported={supported}
          serverId={server.id}
          serverName={server.name}
          issues={tried.variables || outcome?.varIssues ? [...varIssues, ...(outcome?.varIssues ?? [])].filter((i, n, all) => all.findIndex((j) => j.key === i.key && j.message === i.message) === n) : []}
        />
      </div>
    ),
    review: (
      <ImageReviewStep
        serverName={server.name}
        review={checked.ok ? checked.review : null}
        variables={effectiveVars.map(({ key, build }) => ({ key, build }))}
        envSupported={supported}
        dns={domainsOffered ? dnsSummary({ exposure: exposureKind, domain }, server.dns, plan?.kind === "cloudflare" && dns.create, dns.proxied) : null}
        errorCount={Object.keys(errors).length + varIssues.length}
      />
    ),
  };

  if (outcome?.deploymentId !== undefined && outcome.reach !== undefined) {
    return (
      <div className="max-w-3xl space-y-6">
        <ImageCreated outcome={outcome} serverId={server.id} serverName={server.name} name={sent.name} version={checked.ok ? checked.review.version : sent.image} />
      </div>
    );
  }

  const last = step === "review";
  return (
    <div className="max-w-3xl space-y-6">
      <Stepper steps={IMAGE_STEPS} step={step} furthest={furthest} onGo={go} />
      {outcome && outcome.imageErrors === undefined && outcome.deploymentId === undefined && (
        <ProgressPanel
          door="image"
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
      {outcome?.imageErrors && !done && <Notice title="The server refused some fields">Fix the fields marked below, then create the project again.</Notice>}

      <fieldset disabled={done || pending} className="min-w-0 space-y-6 border-0 p-0 disabled:opacity-80">
        <div ref={sectionRef}>
          {IMAGE_STEPS.map((s) => (
            <section key={s.id} hidden={s.id !== step} aria-labelledby={`${prefix}-h-${s.id}`} className={s.id !== step ? "hidden" : undefined}>
              <h2 id={`${prefix}-h-${s.id}`} className="mb-4 text-lg font-semibold">
                {STEP_TITLE[s.id]}
              </h2>
              {body[s.id]}
            </section>
          ))}
        </div>
      </fieldset>

      <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
        {step === "image" ? (
          <Button asChild variant="outline">
            <Link href={`/projects/new${fixed ? `?server=${encodeURIComponent(server.id)}` : ""}`}>Cancel</Link>
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
              {pending ? "Deploying…" : "Create the project and deploy now"}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
