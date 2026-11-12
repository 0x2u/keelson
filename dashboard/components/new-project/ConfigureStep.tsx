"use client";

import { ChevronDownIcon } from "lucide-react";
import { useId } from "react";
import { FormSection } from "@/components/config/FormParts";
import { CheckboxField, FieldShell, SegmentedControl, SelectField, TextField } from "@/components/forms/fields";
import { DnsPlan } from "@/components/domains/DnsPlan";
import { ServerStatsLine } from "@/components/ServerStatsLine";
import { PresetOptionsFields } from "@/components/new-project/PresetOptionsFields";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isHostname } from "@/lib/address-core";
import { planWizard } from "@/lib/dns-record-core";
import type { DockerfileCandidate } from "@/lib/github-detect";
import type { ProjectServer } from "@/lib/new-project-wizard-core";
import { getPreset, isPresetId, type PresetErrors, type PresetField, type PresetOptions } from "@/lib/presets-core";
import { statsSummary } from "@/lib/server-stats-core";
import { PROXY_DOCS_URL } from "@/lib/public-url-help-core";
import type { ReviewErrorKey, ReviewErrors, ReviewField, ReviewInput } from "@/lib/repo-detect-core";

export interface DnsState {
  create: boolean;
  proxied: boolean;
  allowPrivate: boolean;
}

/** The third step: everything the project needs besides its framework. The release command may arrive proposed by the repository; the rest is the operator's. */
export function ConfigureStep({
  input,
  onField,
  onOptions,
  errors,
  servers,
  serverId,
  serverFixed,
  onServer,
  candidate,
  dnsState,
  onDns,
  advancedOpen,
  onAdvancedOpen,
  previewsOffered,
  nameTaken,
  repo,
  releaseHint,
  branches,
}: {
  input: ReviewInput;
  onField: <K extends ReviewField>(field: K, value: ReviewInput[K]) => void;
  onOptions: (options: PresetOptions) => void;
  /** The problems to show: empty until a first attempt to go on. */
  errors: ReviewErrors;
  servers: ProjectServer[];
  serverId: string;
  /** The server was given in the address (opened from its page): it is named, not chosen. */
  serverFixed: boolean;
  onServer: (id: string) => void;
  /** The Dockerfile detected for the Dockerfile card, for what it says about the port and the health check. */
  candidate: DockerfileCandidate | undefined;
  dnsState: DnsState;
  onDns: (next: Partial<DnsState>) => void;
  advancedOpen: boolean;
  onAdvancedOpen: (open: boolean) => void;
  previewsOffered: boolean;
  nameTaken: boolean;
  repo: string;
  /** Why the release command was proposed ("prisma/migrations exists."), shown under the field; nothing when it was not. */
  releaseHint?: string;
  /** The repository's branches, for a menu; empty when they are not known and the branch is typed. */
  branches: string[];
}) {
  const prefix = useId();
  const id = (field: string) => `${prefix}-${field}`;
  const server = servers.find((s) => s.id === serverId) ?? servers[0];
  const domainsOffered = server.context.proxy === "caddy";
  const preset = isPresetId(input.preset) ? getPreset(input.preset) : null;
  const isDockerfile = input.preset === "dockerfile";
  const domain = input.domain.trim().toLowerCase();
  const plan = input.exposure === "domain" && isHostname(domain) ? planWizard(domain, server.dns) : null;
  const optionErrors: PresetErrors = {};
  for (const [key, message] of Object.entries(errors) as [ReviewErrorKey, string][]) if (key.startsWith("options.")) optionErrors[key.slice("options.".length) as PresetField] = message;
  // `ports` cannot go with `port`: a generated image listens on its default port when the app is on a local port.
  const portFixed = preset !== null && !isDockerfile && input.exposure === "local";

  return (
    <div className="space-y-6">
      <FormSection title="Project" description={`Built from ${repo}.`}>
        {nameTaken && (
          <p className="text-sm text-muted-foreground">This server already has an app named like the repository, so the name below is another one. To build that app from the repository, link it from its Source page instead.</p>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField id={id("name")} label="Name" required help="The project and app name, also the image name (keelson-local/<name>)." error={errors.name} value={input.name} onChange={(v) => onField("name", v)} mono />
          {branches.length > 0 ? (
            <SelectField
              id={id("branch")}
              label="Branch"
              required
              help="Built and deployed at each push when that is on."
              error={errors.branch}
              value={input.branch}
              onChange={(v) => onField("branch", v)}
              options={(branches.includes(input.branch) || input.branch === "" ? branches : [input.branch, ...branches]).map((b) => ({ value: b, label: b }))}
            />
          ) : (
            <TextField id={id("branch")} label="Branch" required help="Built and deployed at each push when that is on." error={errors.branch} value={input.branch} onChange={(v) => onField("branch", v)} mono />
          )}
          {serverFixed || servers.length === 1 ? (
            <FieldShell id={id("server")} label="Server" group help="The app is built and runs there.">
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
                  Online servers that are not read-only here. The app is built and runs there.
                  <ServerStatsLine stats={server.stats} className="mt-1.5" />
                </>
              }
              value={serverId}
              onChange={onServer}
              options={servers.map((s) => ({ value: s.id, label: `${s.name} · ${statsSummary(s.stats)}` }))}
            />
          )}
        </div>
      </FormSection>

      <FormSection title="How it is exposed" description="Where the app listens, and how traffic reaches it.">
        <TextField
          id={id("port")}
          label="Container port"
          required
          inputMode="numeric"
          readOnly={portFixed}
          help={
            portFixed
              ? `The ${preset?.label} image listens on ${preset?.defaultPort} on a local port. Choose a domain to use another port.`
              : preset !== null && !isDockerfile
                ? `The generated image listens on this port (default ${preset.defaultPort}).`
                : candidate?.port != null
                  ? "Read from the Dockerfile's EXPOSE."
                  : candidate?.portFromVariable
                    ? "The Dockerfile's EXPOSE uses a variable, so the port is not guessed: enter the port the app listens on."
                    : "Enter the port the app listens on inside the container (a Dockerfile's EXPOSE fills it when there is one)."
          }
          error={errors.port}
          value={portFixed && preset?.defaultPort ? String(preset.defaultPort) : input.port}
          onChange={(v) => onField("port", v)}
          mono
        />
        <FieldShell id={id("exposure")} label="Exposed as" group error={errors.exposure}>
          <SegmentedControl
            label="Exposed as"
            value={input.exposure}
            onChange={(v) => onField("exposure", v)}
            options={domainsOffered ? [{ value: "domain", label: "A domain" }, { value: "local", label: "A local port" }] : [{ value: "local", label: "A local port" }]}
          />
          {!domainsOffered && (
            <p className="text-xs text-muted-foreground">
              {server.context.proxy === "none" ? (
                <>
                  This server has no proxy, so a domain cannot be served from here.{" "}
                  <a href={PROXY_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    How to serve apps on a domain
                  </a>
                </>
              ) : (
                "A domain is only offered with the Caddy proxy; this server uses another one."
              )}
            </p>
          )}
        </FieldShell>
        {input.exposure === "domain" ? (
          <>
            <TextField
              id={id("domain")}
              label="Domain"
              required
              placeholder="app.example.com"
              help={`Its DNS record must point at this server: Keelson creates it at Cloudflare when connected, and says what to create otherwise. Caddy obtains the certificate itself once the name leads here, so ports 80 and 443 must be reachable from the internet.${server.appsDomain ? ` Filled in from this server's apps domain (${server.appsDomain}): change it if this project needs another address.` : ""}`}
              error={errors.domain}
              value={input.domain}
              onChange={(v) => onField("domain", v)}
              mono
            />
            {plan && (
              <DnsPlan
                hostname={domain}
                plan={plan}
                create={dnsState.create}
                onCreate={(create) => onDns({ create })}
                proxied={dnsState.proxied}
                onProxied={(proxied) => onDns({ proxied })}
                allowPrivate={dnsState.allowPrivate}
                onAllowPrivate={(allowPrivate) => onDns({ allowPrivate })}
                idPrefix={prefix}
                address={server.dns.address.ok ? { ip: server.dns.address.ip, source: server.dns.address.source, settingsHref: `/servers/${server.id}/settings` } : undefined}
              />
            )}
            <TextField
              id={id("healthPath")}
              label="Health path"
              placeholder={preset?.defaultHealthPath || "/healthz"}
              help={
                isDockerfile && candidate?.healthcheck
                  ? "The image has a HEALTHCHECK, which the agent already waits for: a path is not needed."
                  : preset !== null && !isDockerfile
                    ? "The generated image's HEALTHCHECK requests this path, and the agent waits for a 2xx on the new container before traffic switches."
                    : "Optional. A path the agent requests on the new container, which must answer 2xx before traffic switches."
              }
              error={errors.healthPath}
              value={input.healthPath}
              onChange={(v) => onField("healthPath", v)}
              mono
            />
          </>
        ) : (
          <TextField
            id={id("hostPort")}
            label="Local port"
            required
            inputMode="numeric"
            help="Published on 127.0.0.1 of the server only (127.0.0.1:<port>:<container port>); put your own proxy in front. The first port from 8100 that no app of this agent uses; what else listens on the server is not known."
            error={errors.hostPort}
            value={input.hostPort}
            onChange={(v) => onField("hostPort", v)}
            mono
          />
        )}
      </FormSection>

      <FormSection title="Run and deploy" description="Optional.">
        <TextField
          id={id("release")}
          label="Run before each deploy"
          placeholder="npx prisma migrate deploy"
          help={`A command for migrations or other preparation. It runs in the new image, with the app's variables, before traffic switches; if it fails, the deployment stops and the running version stays. Stored as a release step of the app.${releaseHint ? ` ${releaseHint}` : ""}`}
          error={errors.release}
          value={input.release}
          onChange={(v) => onField("release", v)}
          mono
        />
        <CheckboxField
          id={id("push")}
          label="Deploy each push to the branch"
          help="Needs the GitHub App, which is set up. The first build starts as soon as the project is created."
          checked={input.buildOnPush}
          onChange={(v) => onField("buildOnPush", v)}
        />
        {previewsOffered && (
          <CheckboxField
            id={id("previews")}
            label="Deploy a preview of each pull request"
            help="The agent has a previews template for this app. Same repository only: forks never build."
            checked={input.previews}
            onChange={(v) => onField("previews", v)}
          />
        )}
        <Collapsible open={advancedOpen} onOpenChange={onAdvancedOpen}>
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDownIcon aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
            Advanced: {preset !== null && !isDockerfile ? "build options, " : ""}build limits, environment file
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 grid gap-6">
            {preset !== null && !isDockerfile && isPresetId(input.preset) && (
              <div className="grid gap-3">
                <p className="text-sm font-medium">{preset.label} options</p>
                <p className="text-xs text-muted-foreground">Blank means the default shown in the field.</p>
                <PresetOptionsFields preset={input.preset} options={input.options} onChange={onOptions} errors={optionErrors} idPrefix={prefix} />
              </div>
            )}
            <div className="grid gap-3">
              <p className="text-sm font-medium">Build limits</p>
              <div className="grid gap-5 sm:grid-cols-3">
                <TextField id={id("memory")} label="Build memory" help="At most 2g by default." error={errors.memory} value={input.memory} onChange={(v) => onField("memory", v)} mono />
                <TextField id={id("cpus")} label="Build CPUs" help="Cores." error={errors.cpus} value={input.cpus} onChange={(v) => onField("cpus", v)} mono />
                <TextField id={id("timeout")} label="Build timeout" help="At most 1h." error={errors.timeout} value={input.timeout} onChange={(v) => onField("timeout", v)} mono />
              </div>
            </div>
            <CheckboxField
              id={id("buildHostNetwork")}
              label="Build on the server's network"
              help="Lets the build reach a database on this server (127.0.0.1) while it builds, for a framework that queries it. The build's code then sees every port this server listens on: turn it on only for a repository you trust."
              checked={input.buildHostNetwork}
              onChange={(v) => onField("buildHostNetwork", v)}
            />
            <TextField
              id={id("envFile")}
              label="Environment file"
              placeholder="/etc/acme/app.env"
              help="A path on the server, for a file you manage yourself. Variables set in the next step are stored by the agent and win over it."
              error={errors.envFile}
              value={input.envFile}
              onChange={(v) => onField("envFile", v)}
              mono
            />
          </CollapsibleContent>
        </Collapsible>
      </FormSection>
    </div>
  );
}
