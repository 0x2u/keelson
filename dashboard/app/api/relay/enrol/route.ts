import { audit, isLoginBlocked, loginBlockedForMs, recordLoginFailure } from "@/lib/auth/store";
import { requestIp } from "@/lib/client-ip";
import { enrolRelayMachine } from "@/lib/relay";
import { parseEnrolRequest, readBounded } from "@/lib/relay-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;

/** A machine redeems the code the operator copied from the dashboard and hands over the secrets it generated. */
export async function POST(request: Request): Promise<Response> {
  // Failures share the sign-in throttle's mechanism under their own key: guessing codes cannot lock the operator out.
  const key = `relay:${requestIp(request)}`;
  if (isLoginBlocked(key)) {
    const seconds = Math.max(1, Math.ceil(loginBlockedForMs(key) / 1000));
    return Response.json({ error: "too many failed attempts" }, { status: 429, headers: { "Retry-After": String(seconds) } });
  }
  const raw = await readBounded(request, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = raw === null ? undefined : JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    body = undefined;
  }
  const enrol = parseEnrolRequest(body);
  if (!enrol) return Response.json({ error: "malformed enrolment" }, { status: 400 });

  const machine = enrolRelayMachine(enrol);
  if (!machine) {
    recordLoginFailure(key);
    return Response.json({ error: "invalid or expired code" }, { status: 401 });
  }
  const detail = `${machine.name} (${enrol.os}/${enrol.arch})`;
  if (enrol.serves) audit("relay_enrol_server", detail, requestIp(request));
  else audit("relay_enrol", detail, requestIp(request));
  return Response.json({ credential: machine.credential, server_id: machine.serverId, name: machine.name });
}
