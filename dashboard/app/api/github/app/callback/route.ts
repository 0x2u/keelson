import { handleGithubAppCallback } from "@/lib/github-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where GitHub sends the operator after creating the App from the manifest. Reachable without the proxy's session
 * redirect (the cookie does not accompany a navigation from github.com), but the handler itself requires the session.
 */
export async function GET(request: Request) {
  return handleGithubAppCallback(request);
}
