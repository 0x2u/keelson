import { createHash, createHmac } from "node:crypto";

/**
 * Signs a request for the agent: the hex HMAC-SHA256, keyed with the deploy
 * secret, of
 *
 *   <unix timestamp> \n <METHOD> \n <request URI with query> \n <hex sha256 of body>
 *
 * This must stay byte-for-byte identical to Sign in agent/internal/api/signed.go.
 */
export function sign(secret: string, timestamp: number, method: string, requestUri: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${timestamp}\n${method}\n${requestUri}\n${bodyHash}`).digest("hex");
}
