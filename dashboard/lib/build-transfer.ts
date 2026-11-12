import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { AgentError, type AgentClient } from "@/lib/agent";
import type { Deployment } from "@/lib/agent-types";

/** What the pipeline asks of the server that builds, and of the server that runs the app. */
export type BuilderAgent = Pick<AgentClient, "deployment" | "exportImageByRef">;
export type TargetAgent = Pick<AgentClient, "importImage" | "deploy" | "deployment">;

export interface TransferJob {
  builder: BuilderAgent;
  /** The repository of the image the build made on the build server (`<image>:<tag>`), and the build already started there. */
  image: string;
  buildDeploymentId: string;
  target: TargetAgent;
  /** The app that runs the image, and the image's tag (the commit). */
  targetApp: string;
  tag: string;
}

export interface TransferDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Where the archive waits between the two servers (default: a private directory under the system's). */
  stage?(): Promise<{ dir: string }>;
  pollMs?: number;
  /** How long a build may run before the pipeline gives up on it (the agent's own timeout is at most an hour). */
  buildTimeoutMs?: number;
  /** How long the archive's journey (export, then import) and the deployment of the image may each take. */
  moveTimeoutMs?: number;
  deployTimeoutMs?: number;
}

const defaults = { pollMs: 3000, buildTimeoutMs: 65 * 60_000, moveTimeoutMs: 30 * 60_000, deployTimeoutMs: 15 * 60_000 };
/** A poll that fails this many times in a row ends the wait: one lost answer must not end a build that is going well. */
const POLL_FAILURES = 5;

export type TransferPhase = "building" | "sending" | "deploying" | "done" | "failed";

export interface TransferState {
  phase: TransferPhase;
  /** Why it failed, in words that say which server and which step. */
  error?: string;
  /** The deployment of the image on the server that runs it, once it started. */
  targetDeploymentId?: string;
}

type Progress = Pick<Deployment, "status" | "error">;

/**
 * Follows a build that runs on one server to the end, sends its image to the server that runs the app, and deploys it
 * there: `run()` never throws and resolves with the final state. `deployment()` answers like an agent's deployment
 * record for the whole journey, so the commit-status reporter that follows a build can follow this too.
 */
export class ImageTransfer {
  private current: TransferState = { phase: "building" };
  private readonly d: Required<Pick<TransferDeps, "pollMs" | "buildTimeoutMs" | "moveTimeoutMs" | "deployTimeoutMs">> & TransferDeps;

  constructor(
    private readonly job: TransferJob,
    deps: TransferDeps,
  ) {
    this.d = { ...defaults, ...deps };
  }

  get state(): TransferState {
    return this.current;
  }

  /** The journey as one deployment: running until the image is deployed (or a step failed). */
  deployment = async (): Promise<Progress> => {
    switch (this.current.phase) {
      case "done":
        return { status: "succeeded" };
      case "failed":
        return { status: "failed", error: this.current.error };
      default:
        return { status: "running" };
    }
  };

  async run(): Promise<TransferState> {
    try {
      const built = await this.waitFor(() => this.job.builder.deployment(this.job.buildDeploymentId), this.d.buildTimeoutMs, "the build");
      if (built.status !== "succeeded") return this.fail(`the build did not succeed${built.error ? `: ${built.error}` : ` (${built.status})`}`);

      this.current = { phase: "sending" };
      await this.move();

      this.current = { phase: "deploying" };
      const id = await this.job.target.deploy(this.job.targetApp, { tag: this.job.tag }, "transfer");
      this.current = { phase: "deploying", targetDeploymentId: id };
      const deployed = await this.waitFor(() => this.job.target.deployment(id), this.d.deployTimeoutMs, "the deployment");
      if (deployed.status !== "succeeded") {
        const why = deployed.status === "rolled_back" ? "the new version failed and the previous one serves again" : (deployed.error ?? deployed.status);
        return this.fail(`the image was sent but its deployment did not succeed: ${why}`, id);
      }
      this.current = { phase: "done", targetDeploymentId: id };
    } catch (err) {
      return this.fail(describe(err), this.current.targetDeploymentId);
    }
    return this.current;
  }

  private fail(error: string, targetDeploymentId?: string): TransferState {
    this.current = { phase: "failed", error, ...(targetDeploymentId ? { targetDeploymentId } : {}) };
    return this.current;
  }

  /** The archive goes to a file first: its hash is in the signed request to the receiving agent, which needs it before the first byte. */
  private async move(): Promise<void> {
    const { dir } = await (this.d.stage ?? defaultStage)();
    try {
      const file = path.join(dir, "image.tar");
      const signal = AbortSignal.timeout(this.d.moveTimeoutMs);
      let res;
      try {
        res = await this.job.builder.exportImageByRef({ image: this.job.image, tag: this.job.tag }, signal);
      } catch (err) {
        throw new Error(`the build server could not give the image: ${describe(err)}`);
      }
      if (!res.body) throw new Error("the build server answered without an archive");
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(file, { mode: 0o600 }),
        { signal },
      );
      try {
        await this.job.target.importImage(this.job.targetApp, this.job.tag, { stream: createReadStream(file), sha256: hash.digest("hex") }, signal);
      } catch (err) {
        throw new Error(`the server that runs the app refused the image: ${describe(err)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async waitFor(poll: () => Promise<Progress>, timeoutMs: number, what: string): Promise<Progress> {
    const start = this.d.now();
    let failures = 0;
    for (;;) {
      try {
        const p = await poll();
        failures = 0;
        if (p.status !== "running") return p;
      } catch (err) {
        if (++failures >= POLL_FAILURES) throw new Error(`could not follow ${what}: ${describe(err)}`);
      }
      if (this.d.now() - start > timeoutMs) throw new Error(`${what} did not end in time`);
      await this.d.sleep(this.d.pollMs);
    }
  }
}

async function defaultStage(): Promise<{ dir: string }> {
  return { dir: await mkdtemp(path.join(tmpdir(), "keelson-image-")) };
}

function describe(err: unknown): string {
  if (err instanceof AgentError) return err.message;
  return err instanceof Error ? err.message : "unexpected error";
}
