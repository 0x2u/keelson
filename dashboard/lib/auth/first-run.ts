import "server-only";
import { issueSetupToken } from "@/lib/auth/setup";
import { deriveKey, publicUrl, setupRequired } from "@/lib/env";

/**
 * What the dashboard does when it starts (called from instrumentation.ts). The master key is made now, not at the first
 * request, so a missing or unreadable key fails the start instead of the first page. While no admin password exists, a new
 * setup token is issued and printed: the container log is the one place only the operator can read, so seeing the token proves
 * control of the machine. The line starts with a fixed prefix that install scripts look for; an earlier token is void.
 */
export function announceFirstRun(log: (line: string) => void = console.log): void {
  deriveKey("encryption");
  if (!setupRequired()) return;
  const base = publicUrl()?.origin ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const token = issueSetupToken();
  log(`Keelson setup: open ${base}/setup in your browser to finish the installation.`);
  log(`Keelson setup token: ${token}`);
}
