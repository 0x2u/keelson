import { describe, expect, it } from "vitest";
import { RELAY_PREFIX, connectLine, encodeConnection, parseConnection, parseEnrolRequest, parseRelayFeatures, parseRelayHeaders, readBounded } from "@/lib/relay-core";

describe("connection strings", () => {
  it("round-trips the dashboard's address and the code", () => {
    const s = encodeConnection("https://keelson.example.com", "abc_-123");
    expect(s.startsWith(RELAY_PREFIX)).toBe(true);
    expect(s).toMatch(/^ksr1\.[A-Za-z0-9_-]+$/); // pasteable into a shell without quoting
    expect(parseConnection(s)).toEqual({ url: "https://keelson.example.com", code: "abc_-123" });
    expect(parseConnection(`  ${s}\n`)).toEqual({ url: "https://keelson.example.com", code: "abc_-123" });
  });

  it("is the JSON the agent expects", () => {
    expect(JSON.parse(Buffer.from(encodeConnection("http://x", "c").slice(RELAY_PREFIX.length), "base64url").toString())).toEqual({ u: "http://x", c: "c" });
  });

  it.each(["", "ksr1.", "ksr2.e30", "ksr1.!!!", `ksr1.${Buffer.from("[]").toString("base64url")}`, `ksr1.${Buffer.from('{"u":"x"}').toString("base64url")}`, `ksr1.${Buffer.from('{"u":"","c":"x"}').toString("base64url")}`])(
    "rejects %j",
    (s) => expect(parseConnection(s)).toBeNull(),
  );
});

describe("the connect command", () => {
  it("fetches the binary by code for the machine's own platform and then connects with the connection string", () => {
    const line = connectLine("CODE", "https://keelson.example.com");
    expect(line).toBe(
      `curl -fsSL "https://keelson.example.com/api/relay/binary?os=$(uname -s | tr A-Z a-z)&arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')&code=CODE" -o keelson-agent && chmod +x keelson-agent && ./keelson-agent connect ${encodeConnection("https://keelson.example.com", "CODE")}`,
    );
  });
});

describe("the enrolment body", () => {
  const good = { code: "c", name: "marc-mac", token: "a".repeat(32), deploy_secret: "b".repeat(32), version: "v", os: "darwin", arch: "arm64", hostname: "h" };

  it("is read into the fields the dashboard uses; an agent that does not say it serves is a build machine", () => {
    expect(parseEnrolRequest(good)).toEqual({ code: "c", name: "marc-mac", token: good.token, deploySecret: good.deploy_secret, version: "v", os: "darwin", arch: "arm64", hostname: "h", serves: false });
  });

  it("says whether the agent serves apps, and only as a boolean", () => {
    expect(parseEnrolRequest({ ...good, serves: true })?.serves).toBe(true);
    expect(parseEnrolRequest({ ...good, serves: false })?.serves).toBe(false);
    for (const serves of ["true", 1, 0, null, {}, []]) expect(parseEnrolRequest({ ...good, serves }), JSON.stringify(serves)).toBeNull();
  });

  it("lets the informational fields be absent", () => {
    expect(parseEnrolRequest({ code: "c", name: "n", token: good.token, deploy_secret: good.deploy_secret })).toMatchObject({ version: "", os: "", arch: "", hostname: "" });
  });

  it.each([
    ["not an object", null],
    ["a name with a slash", { ...good, name: "a/b" }],
    ["a name starting with a dash", { ...good, name: "-a" }],
    ["a name over 60 characters", { ...good, name: "a".repeat(61) }],
    ["no code", { ...good, code: "" }],
    ["a token under 32 characters", { ...good, token: "a".repeat(31) }],
    ["a deploy secret under 32 characters", { ...good, deploy_secret: "b".repeat(31) }],
    ["the same token and deploy secret", { ...good, deploy_secret: good.token }],
    ["a number for the os", { ...good, os: 3 }],
    ["a line break in the hostname (it would forge an audit line)", { ...good, hostname: "mac\nrelay_enrol x" }],
    ["a control character in the arch", { ...good, arch: "arm64\u0000" }],
  ])("refuses %s", (_what, body) => expect(parseEnrolRequest(body)).toBeNull());

  it("trims the name", () => {
    expect(parseEnrolRequest({ ...good, name: "  marc  " })?.name).toBe("marc");
  });
});

describe("the headers of an answer", () => {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

  it("are read from base64 JSON, without what would break the Response's own framing", () => {
    const h = parseRelayHeaders(encode({ "Content-Type": "text/plain", "X-A": "1", "Content-Length": "99", "Transfer-Encoding": "chunked", "Set-Cookie": "a=b", "bad name": "x", n: 5 }))!;
    expect([...h.entries()]).toEqual([
      ["content-type", "text/plain"],
      ["x-a", "1"],
    ]);
  });

  it("are empty when the machine sent none, and refused when they are not an object", () => {
    expect([...parseRelayHeaders(null)!]).toEqual([]);
    expect(parseRelayHeaders("%%%")).toBeNull();
    expect(parseRelayHeaders(encode([1]))).toBeNull();
    expect(parseRelayHeaders(encode("x"))).toBeNull();
  });
});

describe("the features a machine announces", () => {
  it("are a comma-separated list of names, whatever else is in it is dropped, and unknown names are kept", () => {
    expect([...parseRelayFeatures("request-stream, future-thing,, Not A Name,UPPER,x".concat(",", "a".repeat(33)))]).toEqual(["request-stream", "future-thing", "x"]);
  });

  it("are none for a machine that says nothing", () => {
    expect(parseRelayFeatures(null).size).toBe(0);
    expect(parseRelayFeatures("").size).toBe(0);
  });
});

describe("reading a bounded body", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://x/", { method: "POST", body, headers });

  it("returns what fits, and null for what does not, by the declared length or by counting", async () => {
    expect(Buffer.from((await readBounded(post("hello"), 5))!).toString()).toBe("hello");
    expect(await readBounded(post("hello!"), 5)).toBeNull();
    // A body that lies about its size (no Content-Length) is stopped as it streams in.
    const streamed = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(4));
      },
    });
    expect(await readBounded(new Request("http://x/", { method: "POST", body: streamed, duplex: "half" } as RequestInit), 10)).toBeNull();
  });

  it("returns an empty body for none", async () => {
    expect((await readBounded(new Request("http://x/", { method: "POST" }), 5))!.byteLength).toBe(0);
  });
});
