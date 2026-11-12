import { describe, expect, it, vi } from "vitest";

// The wizard validates the form in the browser, where Next replaces `path` with its own stand-in. That stand-in resolves
// against a fake working directory, and `relative(".", "Dockerfile")` comes back as "ockerfile". These tests run the same
// code on that stand-in, which the Node tests (real `path`) cannot.
vi.mock("node:path", async () => {
  // @ts-expect-error -- Next ships its compiled `path` stand-in without types
  const browserPath = (await import("next/dist/compiled/path-browserify")).default;
  return { default: browserPath, ...browserPath };
});

const { dockerfileInContext, validateReview } = await import("@/lib/repo-detect-core");
const { chooseFramework, initialInput } = await import("@/lib/new-project-wizard-core");

describe("the Dockerfile's path in the browser's `path`", () => {
  it("is the whole file name for a Dockerfile at the root of the context", () => {
    expect(dockerfileInContext("Dockerfile", ".")).toBe("Dockerfile");
    expect(dockerfileInContext("Dockerfile.keelson", ".")).toBe("Dockerfile.keelson");
    expect(dockerfileInContext("docker/Dockerfile", ".")).toBe("docker/Dockerfile");
    expect(dockerfileInContext("./Dockerfile.prod", "./")).toBe("Dockerfile.prod");
  });

  it("is relative to a context directory, and null outside it", () => {
    expect(dockerfileInContext("api/Dockerfile", "api")).toBe("Dockerfile");
    expect(dockerfileInContext("api/build/Dockerfile.prod", "api")).toBe("build/Dockerfile.prod");
    expect(dockerfileInContext("web/Dockerfile", "api")).toBeNull();
    expect(dockerfileInContext("apix/Dockerfile", "api")).toBeNull();
    expect(dockerfileInContext("../Dockerfile", ".")).toBeNull();
  });

  it("reaches the review of the form with its real name", () => {
    const input = { ...chooseFramework(initialInput({ name: "shop", branch: "main", hostPort: 8101, domains: false }), "dockerfile"), dockerfile: "Dockerfile.keelson", context: ".", port: "3000" };
    const out = validateReview(input, { existingNames: [], usedDomains: [], usedHostPorts: [], proxy: "none", previewApps: [] });
    expect(out.ok && out.review.dockerfile).toBe("Dockerfile.keelson");
  });
});
