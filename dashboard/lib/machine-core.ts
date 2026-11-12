/** What decides whether a server runs apps: how it is reached, and whether one that connects out was installed as a full agent. */
export interface ServerKind {
  transport: "direct" | "relay";
  serves: boolean;
}

/** Where apps run: every direct server, and a server that connects out and serves. One that does not serve (a laptop) has nothing to deploy to. */
export function canRunApps(server: ServerKind): boolean {
  return server.transport === "direct" || server.serves;
}

/** The servers an app can be created on, promoted to or deployed to: every one that can run apps. */
export function runTargets<T extends ServerKind>(servers: readonly T[]): T[] {
  return servers.filter(canRunApps);
}

export type BuildPlatform = "linux/amd64" | "linux/arm64";

/** What servers run unless one says otherwise: the platform to build for when the target's architecture is not known. */
const DEFAULT_PLATFORM: BuildPlatform = "linux/amd64";

/** The platform an image must have to run on a server of this architecture (`/v1/system`'s `arch`). */
export function platformFor(arch: string | undefined): BuildPlatform {
  return arch === "arm64" ? "linux/arm64" : DEFAULT_PLATFORM;
}
