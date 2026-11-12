/**
 * What is wrong, or quietly lost, in the way the dashboard was started, from its environment alone. Each line says what the
 * operator gives up, because none of these stops the dashboard from working: it just works worse (or less safely) than it
 * looks. Pure, so the rules are tested without starting anything. No warning for the defaults of deploy/compose.yaml
 * (plain http on the loopback address) or for development.
 */
export function deploymentWarnings(env: Record<string, string | undefined>): string[] {
  if (env.NODE_ENV !== "production") return [];
  const out: string[] = [];
  const publicUrl = (env.KEELSON_PUBLIC_URL ?? "").trim();
  const https = /^https:\/\//i.test(publicUrl);
  const insecureCookies = env.KEELSON_INSECURE_COOKIES === "true";
  const trustProxy = env.KEELSON_TRUST_PROXY === "true" || (env.KEELSON_CLIENT_IP_HEADER ?? "").trim() !== "";

  if (https && !trustProxy) {
    out.push(
      "KEELSON_PUBLIC_URL is https but KEELSON_TRUST_PROXY is not true: the client address is not known, so every visitor shares one sign-in throttle (five wrong passwords from anyone lock you out for 15 minutes) and KEELSON_ALLOWED_IPS cannot work. Set KEELSON_TRUST_PROXY=true when a reverse proxy that overwrites X-Forwarded-For is in front (or KEELSON_CLIENT_IP_HEADER).",
    );
  }
  if (publicUrl === "" && !insecureCookies) {
    out.push(
      "KEELSON_PUBLIC_URL is not set: passkeys are unavailable and the command that connects a server cannot name this dashboard. Set it to the address the dashboard is served at (https://keelson.example.com).",
    );
  }
  return out;
}
