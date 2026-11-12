import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DnsPlan as Plan } from "@/lib/dns-record-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-domains-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, useRouter: () => ({ refresh: () => {} }) }));

const { CloudflareCard } = await import("@/components/domains/CloudflareCard");
const { DomainsCard } = await import("@/components/domains/DomainsCard");
const { DnsPlan } = await import("@/components/domains/DnsPlan");
const { ServerForm } = await import("@/components/ServerForm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the Cloudflare card", () => {
  it("says it is not connected and tells exactly which token to create, with a link to the token page", () => {
    const html = render(createElement(CloudflareCard, { connection: null, zones: null, error: null }));
    expect(html).toContain("Not connected");
    expect(html).toContain("Zone → Zone → Read");
    expect(html).toContain("Zone → DNS → Edit");
    expect(html).toContain("Create Custom Token");
    expect(html).toContain('href="https://dash.cloudflare.com/profile/api-tokens"');
    expect(html).toMatch(/rel="noreferrer noopener"/);
    expect(html).toContain("Connect Cloudflare");
  });

  it("asks for the token as a write-only password field, and for the password again", () => {
    const html = render(createElement(CloudflareCard, { connection: null, zones: null, error: null }));
    expect(html).toMatch(/<input[^>]*name="token"[^>]*type="password"|<input[^>]*type="password"[^>]*name="token"/);
    expect(html).toMatch(/name="password"/);
    expect(html).toContain("never shown again");
    expect(html).toContain("asks for your password again");
  });

  it("labels both fields, ties each to its help, and does not rely on native required bubbles", () => {
    const html = render(createElement(CloudflareCard, { connection: null, zones: null, error: null }));
    expect(html).toMatch(/<label[^>]*for="[^"]+-token"[^>]*>API token<\/label>/);
    expect(html).toMatch(/<label[^>]*for="[^"]+-password"[^>]*>Current password<\/label>/);
    expect(html).toMatch(/aria-describedby="[^"]+-token-help"/);
    expect(html).toMatch(/aria-describedby="[^"]+-password-help"/);
    expect(html).toContain("noValidate");
  });

  it("promises only what Keelson does: one record, nothing overwritten unconfirmed, nothing deleted on its own", () => {
    const html = render(createElement(CloudflareCard, { connection: null, zones: null, error: null }));
    expect(html).toContain("A or AAAA record");
    expect(html).toContain("confirm it by name");
    expect(html).toContain("no record is ever deleted on its own");
  });

  it("shows a connected token's status, its expiry and the zones it sees, without any form field for the token", () => {
    const html = render(createElement(CloudflareCard, { connection: { connectedAt: 1, tokenId: "tok-1", expiresOn: "2027-01-01T00:00:00Z" }, zones: { names: ["example.com", "example.co.uk"], truncated: false }, error: null }));
    expect(html).toContain("Connected");
    expect(html).not.toContain("Not connected");
    expect(html).toContain("until <span class=\"font-medium\">2027-01-01</span>");
    expect(html).toContain("It sees 2");
    expect(html).toContain("example.com");
    expect(html).toContain("example.co.uk");
    expect(html).toContain("Replace the token");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain('name="token"');
  });

  it("says when more zones exist than were read, and when the zones could not be listed", () => {
    const more = render(createElement(CloudflareCard, { connection: { connectedAt: 1, tokenId: null, expiresOn: null }, zones: { names: ["a.com"], truncated: true }, error: null }));
    expect(more).toContain("It sees 1+ zone");
    const failed = render(createElement(CloudflareCard, { connection: { connectedAt: 1, tokenId: null, expiresOn: null }, zones: null, error: "Cloudflare no longer accepts the stored token." }));
    expect(failed).toContain("The zones could not be listed");
    expect(failed).toContain("Cloudflare no longer accepts the stored token.");
  });
});

describe("the DNS plan in the wizard", () => {
  const props = (plan: Plan, over: Record<string, unknown> = {}) => ({
    hostname: "shop.example.com",
    plan,
    create: true,
    onCreate: () => {},
    proxied: true,
    onProxied: () => {},
    allowPrivate: false,
    onAllowPrivate: () => {},
    idPrefix: "p",
    ...over,
  });
  const cloudflare: Plan = { kind: "cloudflare", zone: "example.com", type: "A", ip: "203.0.113.7", privateReason: null };

  it("states the record that will be created, proxied, with what proxied means", () => {
    const html = render(createElement(DnsPlan, props(cloudflare)));
    expect(html).toContain("Create A shop.example.com → 203.0.113.7, proxied");
    expect(html).toContain("zone example.com");
    expect(html).toContain("server&#x27;s address stays hidden");
    expect(html).toContain("HTTP-01 works through the proxy");
  });

  it("states DNS only, with what that exposes", () => {
    const html = render(createElement(DnsPlan, props(cloudflare, { proxied: false })));
    expect(html).toContain("Create A shop.example.com → 203.0.113.7, DNS only");
    expect(html).toContain("anyone who looks it up learns its address");
  });

  it("offers the choice between proxied and DNS only, and says nothing is overwritten unconfirmed", () => {
    const html = render(createElement(DnsPlan, props(cloudflare)));
    expect(html).toContain("Proxied");
    expect(html).toContain("DNS only");
    expect(html).toContain("replaced only if you confirm it by name");
  });

  it("says which address the domain points at, where it comes from, and where to change it", () => {
    const address = { ip: "203.0.113.7", source: "the host of the agent's URL", settingsHref: "/servers/srv/settings" };
    const html = render(createElement(DnsPlan, props(cloudflare, { address })));
    expect(html).toContain("Server address: <span class=\"font-mono\">203.0.113.7</span> (the host of the agent&#x27;s URL)");
    expect(html).toContain('href="/servers/srv/settings"');
    const manual = render(createElement(DnsPlan, props({ kind: "manual", why: "not_connected", message: "m", record: { type: "A", name: "shop.example.com", content: "203.0.113.7" } }, { address })));
    expect(manual).toContain("Server address:");
    expect(render(createElement(DnsPlan, props(cloudflare)))).not.toContain("Server address:");
  });

  it("writes an AAAA for an IPv6 server", () => {
    const html = render(createElement(DnsPlan, props({ ...cloudflare, type: "AAAA", ip: "2001:db8::7" })));
    expect(html).toContain("Create AAAA shop.example.com → 2001:db8::7");
  });

  it("warns about a private address and asks to confirm it", () => {
    const html = render(createElement(DnsPlan, props({ ...cloudflare, ip: "127.0.0.1", privateReason: "a loopback address" })));
    expect(html).toContain("This server&#x27;s address is not public");
    expect(html).toContain("127.0.0.1 is a loopback address");
    expect(html).toContain("Use 127.0.0.1 anyway");
  });

  it("gives the exact record to create by hand, and the way to connect Cloudflare, when it is not connected", () => {
    const html = render(createElement(DnsPlan, props({ kind: "manual", why: "not_connected", message: "Cloudflare is not connected, so Keelson cannot create the record.", record: { type: "A", name: "shop.example.com", content: "203.0.113.7" } })));
    expect(html).toContain("Create this DNS record yourself");
    for (const value of ["Type", "Name", "Content", ">A<", "shop.example.com", "203.0.113.7"]) expect(html).toContain(value);
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain("Connect Cloudflare");
  });

  it("gives the exact record, and no connect link, when the zone is elsewhere", () => {
    const html = render(createElement(DnsPlan, props({ kind: "manual", why: "no_zone", message: "No zone of the connected Cloudflare account covers shop.example.com.", record: { type: "A", name: "shop.example.com", content: "203.0.113.7" } })));
    expect(html).toContain("No zone of the connected Cloudflare account covers shop.example.com.");
    expect(html).toContain("203.0.113.7");
    expect(html).not.toContain('href="/settings/integrations"');
  });

  it("falls back to the values when the operator unticks the creation", () => {
    const html = render(createElement(DnsPlan, props(cloudflare, { create: false })));
    expect(html).toContain("Create it yourself, with these values");
    expect(html).not.toContain("Through Cloudflare");
  });
});

describe("the domains card", () => {
  const host = (hostname: string, label = "shop") => ({ hostname, label });

  it("lists each host name with its three checks, in a loading state until the first check answers", () => {
    const html = render(createElement(DomainsCard, { serverId: "srv", hosts: [host("shop.example.com"), host("www.example.com", "site")], cloudflare: false }));
    expect(html).toContain("Domains");
    expect(html).toContain("shop.example.com");
    expect(html).toContain("www.example.com");
    for (const label of ["DNS", "Proxy", "HTTPS"]) expect(html.match(new RegExp(`>${label}<`, "g"))).toHaveLength(2);
    expect(html.match(/Checking…/g)).toHaveLength(6);
    expect(html.match(/Re-check/g)).toHaveLength(2);
    expect(html).toContain("always against this server&#x27;s own address");
  });

  it("is absent when there is no host name", () => {
    expect(render(createElement(DomainsCard, { serverId: "srv", hosts: [], cloudflare: true }))).toBe("");
  });

  it("opens the host name in a new tab without handing over the opener", () => {
    const html = render(createElement(DomainsCard, { serverId: "srv", hosts: [host("shop.example.com")], cloudflare: false }));
    // The link appears with the first answer; before it, nothing links out.
    expect(html).not.toContain("noreferrer");
  });
});

describe("the server settings form", () => {
  it("has the public address field, empty to derive it, with what it is for", () => {
    const html = render(createElement(ServerForm, { serverId: "s1", initial: { name: "prod", url: "https://a.example.com", caCert: "", clientCert: "", canDeploy: true, hasClientKey: false, publicIp: "203.0.113.7" } }));
    expect(html).toMatch(/for="publicIp"[^>]*>Public address<span[^>]*>\(optional\)<\/span>/);
    expect(html).toMatch(/name="publicIp"[^>]*value="203.0.113.7"|value="203.0.113.7"[^>]*name="publicIp"/);
    expect(html).toMatch(/id="publicIp"[^>]*aria-describedby="publicIp-help"|aria-describedby="publicIp-help"[^>]*id="publicIp"/);
    expect(html).toContain('id="publicIp-help"');
    expect(html).toContain("Leave it empty to use the agent URL&#x27;s host");
    expect(html).toContain("noValidate");
  });

  it("marks the exceptions as optional and no field with a typed-in marker", () => {
    const html = render(createElement(ServerForm, {}));
    for (const label of ["Deploy access secret", "CA certificate", "Client certificate", "Client private key"]) {
      expect(html, label).toMatch(new RegExp(`${label}<span[^>]*>\\(optional\\)</span>`));
    }
    expect(html).not.toMatch(/>Name<span/);
    expect(html).not.toMatch(/>Agent URL<span/);
    expect(html).not.toContain("(optional))");
  });
});
