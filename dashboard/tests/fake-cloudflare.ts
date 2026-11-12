/**
 * A Cloudflare API that lives in memory, for tests and for a development dashboard: the endpoints Keelson uses (token
 * verify, zones, DNS records) with Cloudflare's envelope, pagination, permission errors and rate limit. It imports nothing,
 * so a plain Node script can serve it over HTTP and a fetch shim can send api.cloudflare.com to it.
 */

export interface FakeRecord {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The Authorization header as received. */
  auth: string | null;
  body: unknown;
}

export interface FakeAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export class FakeCloudflare {
  /** The one token that is accepted. */
  token = "cf-test-token-0123456789abcdef";
  zones: { id: string; name: string }[] = [];
  records: FakeRecord[] = [];
  calls: FakeCall[] = [];
  /** What the token may do; a call it may not do is a 403 like Cloudflare's. */
  can = { zonesRead: true, dnsRead: true, dnsEdit: true };
  /** GET /user/tokens/verify knows the token (a user token); false answers 401, like an account-owned token does. */
  userVerify = true;
  /** The token's status for verify. */
  status = "active";
  /** The zones endpoint's page size (Cloudflare's own maximum is 50). */
  maxPerPage = 50;
  /** When set, every call answers 429 with this Retry-After. */
  rateLimit: number | null = null;
  /** When set, every call answers with this status and no useful body. */
  broken: number | null = null;
  private next = 1;

  addZone(name: string): string {
    const id = `zone-${this.zones.length + 1}`;
    this.zones.push({ id, name });
    return id;
  }

  addRecord(zoneName: string, r: { type: string; name: string; content: string; proxied?: boolean }): FakeRecord {
    const zone = this.zones.find((z) => z.name === zoneName);
    if (!zone) throw new Error(`no zone ${zoneName}`);
    const rec: FakeRecord = { id: `rec-${this.next++}`, zone_id: zone.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied ?? false, ttl: 1 };
    this.records.push(rec);
    return rec;
  }

  recordsNamed(name: string): FakeRecord[] {
    return this.records.filter((r) => r.name === name);
  }

  /** The writes made so far (POST, PUT, DELETE). */
  get writes(): FakeCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  private fail(status: number, code: number, message: string, headers: Record<string, string> = {}): FakeAnswer {
    return { status, headers, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
  }

  private ok(result: unknown, info?: object): FakeAnswer {
    return { status: 200, headers: {}, body: { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) } };
  }

  /** Answers one request the way api.cloudflare.com/client/v4 would. `path` is relative to /client/v4. */
  handle(method: string, path: string, query: Record<string, string>, auth: string | null, body: unknown): FakeAnswer {
    this.calls.push({ method, path, query, auth, body });
    if (this.broken !== null) return { status: this.broken, headers: {}, body: "<html>bad gateway</html>" };
    if (auth !== `Bearer ${this.token}`) return this.fail(401, 1000, "Invalid API Token");
    if (this.rateLimit !== null) return this.fail(429, 971, "Rate limited", { "retry-after": String(this.rateLimit) });

    if (method === "GET" && path === "/user/tokens/verify") {
      if (!this.userVerify) return this.fail(401, 1000, "Invalid API Token");
      return this.ok({ id: "tok-0001", status: this.status, expires_on: "2027-01-01T00:00:00Z" });
    }
    if (method === "GET" && path === "/zones") {
      if (!this.can.zonesRead) return this.fail(403, 9109, "Unauthorized to access requested resource");
      const perPage = Math.min(Number(query.per_page ?? 20), this.maxPerPage);
      const page = Number(query.page ?? 1);
      const slice = this.zones.slice((page - 1) * perPage, page * perPage);
      return this.ok(slice.map((z) => ({ id: z.id, name: z.name, status: "active" })), { page, per_page: perPage, count: slice.length, total_count: this.zones.length, total_pages: Math.max(1, Math.ceil(this.zones.length / perPage)) });
    }
    const m = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    if (!m) return this.fail(404, 7003, "No route for that URI");
    const zone = this.zones.find((z) => z.id === m[1]);
    if (!zone) return this.fail(404, 7003, "Could not route to /zones/x, perhaps your object identifier is invalid?");
    const isWrite = method !== "GET";
    if (isWrite ? !this.can.dnsEdit : !this.can.dnsRead) return this.fail(403, 10000, "Authentication error");

    if (method === "GET" && m[2] === undefined) {
      let found = this.records.filter((r) => r.zone_id === zone.id);
      if (query.name) found = found.filter((r) => r.name === query.name);
      if (query.type) found = found.filter((r) => r.type === query.type);
      return this.ok(found, { page: 1, per_page: 100, count: found.length, total_count: found.length, total_pages: 1 });
    }
    if (method === "POST" && m[2] === undefined) return this.write(zone.id, undefined, body);
    const existing = this.records.find((r) => r.id === m[2] && r.zone_id === zone.id);
    if (!existing) return this.fail(404, 81044, "Record does not exist.");
    if (method === "PUT" || method === "PATCH") return this.write(zone.id, existing, body);
    if (method === "DELETE") {
      this.records = this.records.filter((r) => r !== existing);
      return this.ok({ id: existing.id });
    }
    return this.fail(405, 7003, "Method not allowed");
  }

  private write(zoneId: string, existing: FakeRecord | undefined, body: unknown): FakeAnswer {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof b.type !== "string" || typeof b.name !== "string" || typeof b.content !== "string") return this.fail(400, 9005, "Content for A record is invalid.");
    const clash = this.records.some((r) => r !== existing && r.zone_id === zoneId && r.name === b.name && r.type === b.type && r.content === b.content);
    if (clash) return this.fail(400, 81058, "An identical record already exists.");
    const others = this.records.filter((r) => r !== existing && r.zone_id === zoneId && r.name === b.name);
    if (others.some((r) => r.type === "CNAME") || (b.type === "CNAME" && others.length > 0)) return this.fail(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
    if (existing) {
      Object.assign(existing, { type: b.type, name: b.name, content: b.content, proxied: b.proxied === true, ttl: Number(b.ttl ?? 1) });
      return this.ok(existing);
    }
    const rec: FakeRecord = { id: `rec-${this.next++}`, zone_id: zoneId, type: b.type, name: b.name, content: b.content, proxied: b.proxied === true, ttl: Number(b.ttl ?? 1) };
    this.records.push(rec);
    return this.ok(rec);
  }

  /** A fetch that answers for https://api.cloudflare.com/client/v4/ and refuses to talk to anything else. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith("/client/v4/")) throw new Error(`unexpected request to ${url.origin}`);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const answer = this.handle(init?.method ?? "GET", url.pathname.slice("/client/v4".length), Object.fromEntries(url.searchParams), headers.get("authorization"), raw === undefined ? undefined : JSON.parse(raw));
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", ...answer.headers } });
  };
}
