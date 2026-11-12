import { publicUrl, secureCookies, trustProxy } from "@/lib/env";
import { dashboardOrigin } from "@/lib/github-webhook-core";
import { installRefusal, installScript, originProblem } from "@/lib/install-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/**
 * The script a server runs to connect itself to this dashboard (`curl -fsSL <dashboard>/install | sudo sh -s -- --code CODE`).
 * Public: a server has no session yet, and the script holds no secret; the code is an argument the operator gives it. The
 * dashboard's address is baked in with the rule that applies to the code's own line (https, or plain http to this machine);
 * when this dashboard cannot say where it is, the answer is a script that only says so, so piping it into sh fails visibly.
 */
export function GET(request: Request): Response {
  const origin = dashboardOrigin({
    publicUrl: publicUrl(),
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    trustProxy: trustProxy(),
    secure: secureCookies(),
  });
  if (origin === null) return new Response(installRefusal("this dashboard cannot tell which address a server should connect to. Set KEELSON_PUBLIC_URL."), { status: 500, headers: HEADERS });
  const problem = originProblem(origin);
  if (problem !== null) return new Response(installRefusal(problem), { status: 500, headers: HEADERS });
  return new Response(installScript(origin), { headers: HEADERS });
}
