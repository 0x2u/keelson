import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  Conversion,
  FAILURES,
  appSettingsUrl,
  buildManifest,
  defaultAppName,
  installUrl,
  isFailureCode,
  isOrgLogin,
  manifestFormAction,
  publicBase,
  validAppName,
} from "@/lib/github-connect-core";

describe("the public address the flow needs", () => {
  it("accepts https and returns its origin, whatever path or trailing slash was configured", () => {
    expect(publicBase("https://keelson.example.com/", false)).toEqual({ ok: true, origin: "https://keelson.example.com" });
    expect(publicBase("https://keelson.example.com:8443/x", false)).toEqual({ ok: true, origin: "https://keelson.example.com:8443" });
  });

  it("refuses a missing address, a malformed one and plain http, each with a message that names KEELSON_PUBLIC_URL", () => {
    for (const raw of [undefined, "", "keelson.example.com", "http://keelson.example.com", "ftp://x.example.com"]) {
      const out = publicBase(raw, false);
      expect(out.ok, String(raw)).toBe(false);
      if (!out.ok) expect(out.error).toContain("KEELSON_PUBLIC_URL");
    }
  });

  it("allows http only for localhost, and only with insecure cookies (development)", () => {
    expect(publicBase("http://localhost:3000", true)).toEqual({ ok: true, origin: "http://localhost:3000" });
    expect(publicBase("http://127.0.0.1:3000", true)).toEqual({ ok: true, origin: "http://127.0.0.1:3000" });
    expect(publicBase("http://localhost:3000", false).ok).toBe(false);
    expect(publicBase("http://keelson.example.com", true).ok).toBe(false);
  });
});

describe("the manifest", () => {
  it("asks for exactly the permissions and events the builds need, and derives every address from the public one", () => {
    expect(buildManifest("https://keelson.example.com", "Keelson ab12cd")).toEqual({
      name: "Keelson ab12cd",
      url: "https://keelson.example.com",
      hook_attributes: { url: "https://keelson.example.com/api/webhooks/github", active: true },
      redirect_url: "https://keelson.example.com/api/github/app/callback",
      setup_url: "https://keelson.example.com/settings/integrations?github=installed",
      setup_on_update: true,
      public: false,
      default_permissions: { contents: "read", statuses: "write", pull_requests: "read", metadata: "read", actions: "read" },
      default_events: ["push", "pull_request"],
    });
    expect(CALLBACK_PATH).toBe("/api/github/app/callback");
  });

  it("is posted to the account's page or the organization's, with the state encoded", () => {
    expect(manifestFormAction(null, "a-b_c")).toBe("https://github.com/settings/apps/new?state=a-b_c");
    expect(manifestFormAction("acme-corp", "a-b_c")).toBe("https://github.com/organizations/acme-corp/settings/apps/new?state=a-b_c");
    expect(manifestFormAction(null, "a b&c")).toBe("https://github.com/settings/apps/new?state=a%20b%26c");
  });

  it("names the App with a random suffix, and checks a typed name", () => {
    expect(defaultAppName()).toMatch(/^Keelson [0-9a-f]{6}$/);
    expect(defaultAppName()).not.toBe(defaultAppName());
    expect(validAppName("  My App ")).toBe("My App");
    for (const bad of ["", "   ", "x".repeat(35), 'a"b', "a<b", "tab\there"]) expect(validAppName(bad), bad).toBeNull();
  });

  it("accepts organization logins only", () => {
    for (const ok of ["acme", "Acme-Corp", "a1"]) expect(isOrgLogin(ok), ok).toBe(true);
    for (const bad of ["", "-a", "a/b", "a b", "a..b", "x".repeat(40), "a?b=1"]) expect(isOrgLogin(bad), bad).toBe(false);
  });
});

describe("addresses on GitHub", () => {
  it("links the install page and the App's settings page, by owner type", () => {
    expect(installUrl("my-keelson")).toBe("https://github.com/apps/my-keelson/installations/new");
    expect(appSettingsUrl("my-keelson", { login: "me", type: "User" })).toBe("https://github.com/settings/apps/my-keelson");
    expect(appSettingsUrl("my-keelson", { login: "acme", type: "Organization" })).toBe("https://github.com/organizations/acme/settings/apps/my-keelson");
    expect(appSettingsUrl("my-keelson", null)).toBe("https://github.com/apps/my-keelson");
    expect(appSettingsUrl("../x", null)).toBeNull();
  });
});

describe("GitHub's answer", () => {
  const good = { id: 7, slug: "keelson-ab", name: "Keelson ab", pem: "-----BEGIN-----", webhook_secret: "s3cret", owner: { login: "me", type: "User" }, client_id: "Iv1.x", client_secret: "cs" };

  it("keeps what is used and drops client_id and client_secret", () => {
    const parsed = Conversion.parse(good);
    expect(parsed).toEqual({ id: 7, slug: "keelson-ab", name: "Keelson ab", pem: "-----BEGIN-----", webhook_secret: "s3cret", owner: { login: "me", type: "User" } });
    expect(JSON.stringify(parsed)).not.toContain("cs");
  });

  it("refuses an answer without the key, the secret or a sane slug", () => {
    for (const bad of [{ ...good, pem: undefined }, { ...good, webhook_secret: "" }, { ...good, slug: "a/b" }, { ...good, id: "7" }]) expect(Conversion.safeParse(bad).success).toBe(false);
  });

  it("has a fixed sentence for every failure code and recognises only those", () => {
    for (const code of Object.keys(FAILURES)) expect(isFailureCode(code)).toBe(true);
    for (const code of ["constructor", "<script>", "", undefined]) expect(isFailureCode(code)).toBe(false);
  });
});
