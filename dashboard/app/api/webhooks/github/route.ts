import { handleGithubWebhook } from "@/lib/github-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GitHub's `workflow_run` webhook: public (no session), authenticated by the HMAC signature of its body. */
export async function POST(request: Request) {
  return handleGithubWebhook(request);
}
