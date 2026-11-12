/** "some_code.like-this" as "Some code like this": the fallback for a code nobody named here. */
export function humanise(code: string): string {
  const text = code.replace(/[._-]+/g, " ").trim();
  return text === "" ? code : text.charAt(0).toUpperCase() + text.slice(1);
}

const TRIGGERS: Record<string, string> = {
  api: "Dashboard or API",
  cli: "Command line",
  build: "Deployed from source",
  transfer: "Built on another server",
  preview: "Pull request preview",
  promotion: "Promote",
  rollback: "Roll back",
  webhook: "GitHub webhook",
  schedule: "Schedule",
  manual: "Run now",
};

/**
 * What started a deployment (or a job run), in words. A deployment whose image was built on another server says where
 * when the builder is known.
 */
export function triggerLabel(trigger: string, builtOn?: string | null): string {
  if (trigger === "transfer" && builtOn) return `Deployed from source (built on ${builtOn})`;
  return TRIGGERS[trigger] ?? humanise(trigger);
}

/** The verb for what a deployment did, the same in the UI, the notifications and the docs: Deploy, Roll back, Promote. */
export function deployVerb(trigger: string): "Deploy" | "Roll back" | "Promote" {
  return trigger === "rollback" ? "Roll back" : trigger === "promotion" ? "Promote" : "Deploy";
}

/** The noun for what a deployment did, for "<noun> of web failed": Deploy, Rollback, Promotion. */
export function deployNoun(trigger: string): "Deploy" | "Rollback" | "Promotion" {
  return trigger === "rollback" ? "Rollback" : trigger === "promotion" ? "Promotion" : "Deploy";
}

/** How a deployment that did not work ended, for "<noun> of web <ending>": the restore only exists for a deploy, so a roll back that failed just failed. */
export function deployEnding(trigger: string, status: string): string {
  if (status === "rolled_back") return "was rolled back";
  return status === "rollback_failed" && trigger !== "rollback" ? "failed and the previous version could not be restored" : "failed";
}
