import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppStatus, Deployment } from "@/lib/agent-types";
import type { DnsSetup } from "@/lib/dns-record-core";
import type { ImageOutcome } from "@/lib/new-project-image-core";
import { projectView, type ProjectContext } from "@/lib/project-view-core";
import { groupProjects, type Placement, type ServerRef } from "@/lib/projects-core";
import type { ProjectServer } from "@/lib/new-project-wizard-core";
import type { ReviewContext } from "@/lib/repo-detect-core";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/new-project-actions", () => ({
  createImageProjectAction: async () => ({}),
  retryImageProjectAction: async () => ({}),
}));

const { NewImageProjectWizard } = await import("@/components/new-project/NewImageProjectWizard");
const { NewProjectDoors } = await import("@/components/new-project/NewProjectDoors");
const { GithubRequiredNotice } = await import("@/components/new-project/GithubRequiredNotice");
const { ImageCreated } = await import("@/components/new-project/ImageCreated");
const { ProgressPanel } = await import("@/components/new-project/Progress");
const { GithubConnectForm } = await import("@/components/repository/GithubConnectForm");
const { PasskeysSection } = await import("@/components/security/PasskeysSection");
const { ProductionHero } = await import("@/components/projects/ProductionHero");
const { EnvironmentList } = await import("@/components/projects/EnvironmentList");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ existingNames: [], usedDomains: [], usedHostPorts: [], proxy: "none", previewApps: [], ...extra });
const SETUP: DnsSetup = { connected: false, zones: [], zonesError: null, address: { ok: true, ip: "203.0.113.7", type: "A", source: "the host of the agent's URL", private: null } };
const server = (extra: Partial<ProjectServer> = {}): ProjectServer => ({
  id: "srv",
  name: "staging",
  context: ctx(),
  hostPort: 8100,
  dns: SETUP,
  envSupported: true,
  databaseSupported: true,
  appsDomain: null,
  stats: { online: true, cpus: 2, load1: 0.4, memTotal: 4 * 1024 ** 3, memAvailable: 2.8 * 1024 ** 3, diskFree: 24 * 1024 ** 3 },
  ...extra,
});

describe("the two doors of New project", () => {
  it("offers both, and with GitHub connected the repository leads to its wizard", () => {
    const out = html(createElement(NewProjectDoors, { githubConnected: true }));
    expect(out).toContain("From a repository");
    expect(out).toContain("From an image");
    expect(out).toContain('href="/projects/new?door=repository"');
    expect(out).toContain('href="/projects/new?door=image"');
    expect(out).not.toContain("not connected");
  });

  it("without GitHub says what it gives and where to set it up, and the image door is fully usable", () => {
    const out = html(createElement(NewProjectDoors, { githubConnected: false, server: "s 1" }));
    expect(text(out)).toContain("deploy on push");
    expect(text(out)).toContain("previews of pull requests");
    expect(out).toContain('href="/settings/integrations"');
    expect(text(out)).toContain("GitHub is not connected yet");
    expect(out).not.toContain("door=repository");
    expect(out).toContain('href="/projects/new?server=s+1&amp;door=image"');
    expect(text(out)).toContain("No GitHub needed");
  });

  it("the old notice for a repository link without GitHub points to Integrations and to the image door", () => {
    const out = html(createElement(GithubRequiredNotice, { server: "s1" }));
    expect(out).toContain('href="/settings/integrations"');
    expect(out).toContain('href="/projects/new?server=s1&amp;door=image"');
    expect(text(out)).toContain("It is optional");
  });
});

/** The opening tag of the button that creates the project. */
const deployButton = (markup: string): string => markup.match(/<button[^>]*>(?=(?:(?!<\/button>)[\s\S])*Create the project and deploy now)/)?.[0] ?? "";

describe("the image wizard", () => {
  it("asks the image, the project name, the port (80) and a local port, and offers no domain on a server without a proxy", () => {
    const out = html(createElement(NewImageProjectWizard, { servers: [server()] }));
    expect(text(out)).toContain("Describe what to run");
    expect(out).toContain('placeholder="traefik/whoami:v1.10.3"');
    expect(out).toMatch(/inputMode="numeric"[^>]*placeholder="80"[^>]*value="80"|value="80"/);
    expect(text(out)).toContain("Port on the server");
    expect(out).toContain('value="8100"');
    expect(text(out)).toContain("Let other computers connect");
    expect(text(out)).toContain("This server has no proxy");
    expect(out).not.toContain("app.example.com");
    // the steps: image, variables, review
    for (const label of ["Image", "Variables", "Review"]) expect(text(out)).toContain(label);
  });

  it("offers the domain, optional, when the server has Caddy, and a server choice when there are several", () => {
    const caddy = server({ context: ctx({ proxy: "caddy" }) });
    const out = html(createElement(NewImageProjectWizard, { servers: [caddy, server({ id: "b", name: "prod" })] }));
    expect(out).toContain('placeholder="app.example.com"');
    expect(text(out)).toContain("Leave it empty to use a port on the server instead");
    expect(out).toContain("<select");
    expect(text(out)).toContain("Online servers that are not read-only here");
  });

  it("names the server instead of asking when it comes in the address", () => {
    const out = html(createElement(NewImageProjectWizard, { servers: [server(), server({ id: "b", name: "prod" })], initialServer: "b" }));
    expect(out).not.toContain("<select");
    expect(text(out)).toContain("prod");
  });

  it("starts with the image and the name it suggests when the address carries one", () => {
    const out = html(createElement(NewImageProjectWizard, { servers: [server()], initialImage: "traefik/whoami:v1.10.3" }));
    expect(out).toContain('value="traefik/whoami:v1.10.3"');
    expect(out).toContain('value="whoami"');
  });

  it("reviews exactly what will be written, with the version it deploys and where it will answer, and a deploy button", () => {
    const out = html(createElement(NewImageProjectWizard, { servers: [server()], initialImage: "traefik/whoami:v1.10.3", initialStep: "review" }));
    const t = text(out);
    expect(t).toContain("Review and deploy");
    expect(t).toContain("traefik/whoami");
    expect(t).toMatch(/First deployment\s+v1\.10\.3/);
    expect(t).toContain("127.0.0.1:8100 on the server only");
    expect(t).toContain("Start the first deployment");
    expect(t).not.toContain("PostgreSQL");
    expect(t).not.toContain("repository");
    expect(out).toContain("Create the project and deploy now");
    expect(deployButton(out)).not.toContain('disabled=""');
  });

  it("does not let an incomplete form be sent: the review says how many fields need attention and the button is off", () => {
    const out = html(createElement(NewImageProjectWizard, { servers: [server()], initialStep: "review" }));
    expect(text(out)).toContain("The form is not complete");
    expect(deployButton(out)).toContain('disabled=""');
  });
});

describe("the screen after the deployment started", () => {
  const outcome = (reach: ImageOutcome["reach"], extra: Partial<ImageOutcome> = {}): ImageOutcome => ({
    steps: {
      config: { state: "done", detail: "whoami is in the server's configuration." },
      database: { state: "skipped", detail: "Not used for an image." },
      env: { state: "skipped", detail: "No variables." },
      link: { state: "skipped", detail: "Not used for an image." },
      dns: { state: "skipped", detail: "No domain: the app is on a local port." },
      build: { state: "done", detail: "The first deployment of v1.10.3 started." },
    },
    issues: [],
    deploymentId: "dep-1",
    ...(reach ? { reach } : {}),
    ...extra,
  });
  const created = (o: ImageOutcome) => html(createElement(ImageCreated, { outcome: o, serverId: "s1", serverName: "staging", name: "whoami", version: "v1.10.3" }));

  it("links the address when the browser can reach it, and the deployment to watch", () => {
    const out = created(outcome({ kind: "local", port: 8100, loopback: true, address: "127.0.0.1:8100", url: "http://127.0.0.1:8100" }));
    expect(out).toContain('href="http://127.0.0.1:8100"');
    expect(out).toContain('href="/servers/s1/deployments/dep-1"');
    expect(out).toContain('href="/projects/whoami"');
    expect(text(out)).toContain("whoami is created and deploying");
    expect(text(out)).not.toMatch(/is running|is live now/);
  });

  it("for a loopback port of another machine gives the tunnel, not a dead link", () => {
    const out = created(outcome({ kind: "local", port: 8100, loopback: true, address: "127.0.0.1:8100", url: null }));
    expect(out).not.toContain('href="http://127.0.0.1');
    expect(out).toContain("ssh -L 8100:127.0.0.1:8100");
    expect(text(out)).toContain("127.0.0.1:8100");
    expect(text(out)).toContain("SSH tunnel");
  });

  it("says a domain, and what is left to do when its DNS record was not created", () => {
    const out = created(outcome({ kind: "domain", url: "https://who.example.com" }, { steps: { ...outcome(undefined).steps, dns: { state: "skipped", detail: "Create A who.example.com → 203.0.113.7 at your DNS provider." } } }));
    expect(out).toContain('href="https://who.example.com"');
    expect(text(out)).toContain("Create A who.example.com");
  });

  it("says plainly that a container with no port has nothing to open", () => {
    expect(text(created(outcome({ kind: "none" })))).toContain("publishes no port");
  });

  it("shows the failed step with its retry, under the image door's own names", () => {
    const failed = outcome(undefined, {
      deploymentId: undefined,
      retry: "build",
      steps: { ...outcome(undefined).steps, build: { state: "failed", detail: "a deployment is already running" } },
    });
    const out = html(createElement(ProgressPanel, { outcome: failed, onRetry: () => {}, pending: false, door: "image" }));
    expect(text(out)).toContain("Start the first deployment");
    expect(text(out)).toContain("Retry: start the first deployment");
    expect(text(out)).not.toContain("PostgreSQL");
    expect(text(out)).not.toContain("Link the app to the repository");
  });
});

describe("the https help", () => {
  it("tells why GitHub needs it, how with the installer or dashboard.env, and that it is optional", () => {
    const out = html(createElement(GithubConnectForm, { defaultName: "keelson-x", replacing: false, disabledReason: "Set KEELSON_PUBLIC_URL" }));
    const t = text(out);
    expect(t).toContain("GitHub can only call this dashboard back over https");
    expect(t).toContain("--domain keelson.example.com");
    expect(t).toContain("/opt/keelson/dashboard.env");
    expect(t).toContain("KEELSON_PUBLIC_URL=https://keelson.example.com");
    expect(t).toContain("docker compose up -d");
    expect(t).toContain("This step is optional");
    expect(out).toContain('href="/projects/new?door=image"');
    expect(out).not.toContain("Name of the GitHub App");
  });

  it("says the same for passkeys", () => {
    const t = text(html(createElement(PasskeysSection, { available: false, passkeys: [] })));
    expect(t).toContain("Passkeys are off");
    expect(t).toContain("--domain keelson.example.com");
    expect(t).toContain("/opt/keelson/dashboard.env");
  });
});

describe("a published port is an address", () => {
  const ref: ServerRef = { id: "s1", name: "vps-1", canDeploy: true, host: "203.0.113.7" };
  const dep = (): Deployment => ({ id: "d1", app: "whoami", ref: "traefik/whoami:v1.10.3", status: "succeeded", trigger: "api", started_at: "2026-10-23T10:00:00Z", finished_at: "2026-10-23T10:00:10Z" });
  const app = (ports: { ip?: string; public_port?: number; private_port: number; type: string }[], over: Partial<AppStatus> = {}): AppStatus => ({
    name: "whoami",
    image: "traefik/whoami",
    project: "whoami",
    environment: "",
    digest: "",
    container: { id: "c", name: "whoami", image: "traefik/whoami:v1.10.3", created: "", tty: false, restart_count: 0, ports, state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 } },
    last_deployment: dep(),
    ...over,
  });
  const ctxOf = (): ProjectContext => ({ sources: {}, commits: {}, deployments: {} });
  const view = (a: AppStatus, s: ServerRef = ref) => projectView(groupProjects([{ server: s, app: a, jobs: [] } satisfies Placement])[0]!, ctxOf()).primary;

  it("shows server-host:port on the project page, as a link when the host is reachable", () => {
    const out = html(createElement(ProductionHero, { env: view(app([{ ip: "0.0.0.0", public_port: 8100, private_port: 80, type: "tcp" }])) }));
    expect(out).toContain('href="http://203.0.113.7:8100"');
    expect(text(out)).toContain("203.0.113.7:8100");
    expect(text(out)).not.toContain("No public address known");
  });

  it("says where a loopback port works instead of linking it, and never says no address", () => {
    const out = html(createElement(ProductionHero, { env: view(app([{ ip: "127.0.0.1", public_port: 3281, private_port: 80, type: "tcp" }])) }));
    expect(text(out)).toContain("127.0.0.1:3281");
    expect(text(out)).toContain("on vps-1 only");
    expect(out).not.toContain('href="http://127.0.0.1');
    expect(text(out)).not.toContain("No public address known");
  });

  it("links a loopback port when the server is this machine", () => {
    const out = html(createElement(ProductionHero, { env: view(app([{ ip: "127.0.0.1", public_port: 3281, private_port: 80, type: "tcp" }]), { ...ref, host: "127.0.0.1" }) }));
    expect(out).toContain('href="http://127.0.0.1:3281"');
  });

  it("still says no address for an app that publishes nothing, and prefers the domain when there is one", () => {
    expect(text(html(createElement(ProductionHero, { env: view(app([])) })))).toContain("No public address known");
    const withDomain = view(app([{ ip: "0.0.0.0", public_port: 8100, private_port: 80, type: "tcp" }], { domains: ["who.example.com"] }));
    expect(withDomain.localAddresses).toEqual([]);
  });

  it("is shown in the list of environments too, and not for an app that is down", () => {
    const up = view(app([{ ip: "0.0.0.0", public_port: 8100, private_port: 80, type: "tcp" }]));
    expect(html(createElement(EnvironmentList, { environments: [up] }))).toContain('href="http://203.0.113.7:8100"');
    const stopped = app([{ ip: "0.0.0.0", public_port: 8100, private_port: 80, type: "tcp" }]);
    stopped.container!.state = { ...stopped.container!.state, running: false, status: "exited" };
    expect(view(stopped).localAddresses).toEqual([]);
  });
});
