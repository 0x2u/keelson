import "server-only";
import { AgentError } from "@/lib/agent";
import { actorOf, failure, json, serverRoute, toResponse, type ServerCall } from "@/lib/api-v1";
import { audit } from "@/lib/auth/store";
import { requestBuild } from "@/lib/build-request";
import { deployTargetOf } from "@/lib/deploy-target";

// The three things a token with the deploy scope can do. Each one is asked of the agent exactly as the dashboard's own
// buttons do (a signed request), and each one is in the audit log whatever the outcome, under the token's name.

const BODY_MAX = 4096;
const short = (text: string, n = 200): string => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Records what the call did. `fields` are the facts of this call (the subject, the ref); the outcome is added here. */
function record(call: ServerCall, event: string, fields: string, outcome: string): void {
  try {
    audit(event, `server=${call.server.name} ${fields} outcome=${short(outcome)}`, call.caller.ip, actorOf(call.caller.token));
  } catch (err) {
    // What was asked of the agent stands: a log that cannot be written must not turn it into an error answer.
    console.error("api v1: could not write the audit line:", err);
  }
}

/** Sends the signed request, audits what came of it, and answers 202 with `field` set to the id the agent gave. */
async function perform(call: ServerCall, event: string, fields: string, field: "deployment_id" | "run_id", send: () => Promise<string>): Promise<Response> {
  if (!call.server.canDeploy) {
    record(call, event, fields, "refused: the server has no deploy secret");
    return failure(409, "this server has no deploy secret: it is read-only in this dashboard");
  }
  try {
    const id = await send();
    record(call, event, fields, `accepted ${field}=${id}`);
    return json(202, { [field]: id });
  } catch (err) {
    const why = err instanceof AgentError ? (err.status === 0 ? `unreachable: ${err.message}` : `refused (${err.status}): ${err.message}`) : "failed";
    record(call, event, fields, why);
    return toResponse(err);
  }
}

async function readBody(request: Request): Promise<string | null> {
  const text = await request.text();
  return text.length <= BODY_MAX ? text : null;
}

export function deployFromRequest(request: Request, serverId: string, app: string): Promise<Response> {
  return serverRoute(request, serverId, "deploy", async (call) => {
    const fields = `app=${short(app, 100)}`;
    const reject = (message: string): Response => {
      record(call, "api_deploy", fields, `rejected: ${message}`);
      return failure(400, message);
    };
    const text = await readBody(request);
    if (text === null) return reject("the body is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reject('the body must be JSON: {"tag": "v1.2.3"} or {"digest": "sha256:..."}');
    }
    const tag = typeof body === "object" && body !== null && "tag" in body ? body.tag : undefined;
    const digest = typeof body === "object" && body !== null && "digest" in body ? body.digest : undefined;
    if ((tag === undefined) === (digest === undefined) || (tag !== undefined && typeof tag !== "string") || (digest !== undefined && typeof digest !== "string")) {
      return reject('give exactly one of "tag" and "digest", as a string');
    }
    const ref = (tag ?? digest) as string;
    const target = deployTargetOf(ref);
    if (!target || ("digest" in target) !== (digest !== undefined)) return reject("not a valid tag (v1.2.3, a commit SHA) or digest (sha256:...)");
    return perform(call, "api_deploy", `${fields} ref=${ref}`, "deployment_id", () => call.agent.deploy(app, target));
  });
}

/**
 * Builds a commit of the repository the app is linked to, on the server that builds it (the app's own, or the build server
 * it is linked to), and deploys it. `{"sha": "<40 hex>"}` names the commit; without a body it is the head of the linked
 * branch. The link, and where the app is built, are the operator's in the dashboard: a token cannot change them.
 */
export function buildFromRequest(request: Request, serverId: string, app: string): Promise<Response> {
  return serverRoute(request, serverId, "deploy", async (call) => {
    const fields = `app=${short(app, 100)}`;
    const reject = (status: number, message: string): Response => {
      record(call, "api_build", fields, `rejected: ${message}`);
      return failure(status, message);
    };
    const text = await readBody(request);
    if (text === null) return reject(400, "the body is too large");
    let sha: string | null = null;
    if (text.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return reject(400, 'the body must be empty, or JSON: {"sha": "<40 hex commit>"}');
      }
      const given = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      const unknown = given === null ? ["body"] : Object.keys(given).filter((k) => k !== "sha");
      if (given === null || unknown.length > 0 || ("sha" in given && typeof given.sha !== "string")) return reject(400, 'the body must be empty, or JSON: {"sha": "<40 hex commit>"}');
      sha = typeof given.sha === "string" ? given.sha : null;
    }
    if (!call.server.canDeploy) {
      record(call, "api_build", fields, "refused: the server has no deploy secret");
      return failure(409, "this server has no deploy secret: it is read-only in this dashboard");
    }
    const built = await requestBuild(serverId, app, sha);
    if (!built.ok) {
      record(call, "api_build", fields, `refused: ${built.error}`);
      return failure(built.asked ? 409 : 400, built.error);
    }
    record(call, "api_build", `${fields} ref=${built.sha}`, `accepted deployment_id=${built.deploymentId}`);
    return json(202, { deployment_id: built.deploymentId, server_id: built.serverId, sha: built.sha, repo: built.repo });
  });
}

export function rollbackFromRequest(request: Request, serverId: string, app: string): Promise<Response> {
  return serverRoute(request, serverId, "deploy", (call) => perform(call, "api_rollback", `app=${short(app, 100)}`, "deployment_id", () => call.agent.rollback(app)));
}

export function runJobFromRequest(request: Request, serverId: string, job: string): Promise<Response> {
  return serverRoute(request, serverId, "deploy", (call) => perform(call, "api_job_run", `job=${short(job, 100)}`, "run_id", () => call.agent.runJob(job)));
}
