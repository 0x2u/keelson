import type { DeployTarget } from "@/lib/agent-types";

const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** What to deploy from the text an operator or a script gives: a digest (sha256:...) or a tag, or null when it is neither. */
export function deployTargetOf(ref: string): DeployTarget | null {
  if (DIGEST.test(ref)) return { digest: ref };
  if (TAG.test(ref)) return { tag: ref };
  return null;
}
