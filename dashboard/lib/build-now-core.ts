/** Why a deploy from source cannot be used now, or null when it can. The first reason that applies wins. */
export function buildBlock(args: { canDeploy: boolean; githubAppConfigured: boolean; linked: boolean; deploying: boolean; serving?: boolean }): string | null {
  if (!args.canDeploy) return "This server is read-only here: it has no deploy secret in the dashboard.";
  if (!args.githubAppConfigured) return "The GitHub App is not set up: add it in Settings, Integrations. The server downloads the commit with it.";
  if (!args.linked) return "Link this app to its repository first (Source).";
  if (args.deploying) return "A deployment is running. Wait for it to finish.";
  if (args.serving) return "This commit is already serving.";
  return null;
}

/**
 * What the Deploy dialog of an app starts on: its latest commit when the app builds from a linked repository and that can
 * be deployed now, an image version otherwise. A link that asks for a tag (`?deploy=v1.4.2`) is an image version.
 */
export function initialDeployMode(source: { blocked: string | null } | null, initialRef: string): "source" | "image" {
  return source !== null && source.blocked === null && initialRef === "" ? "source" : "image";
}
