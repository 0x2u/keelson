export async function register() {
  // The node:sqlite database and the key file exist only in the Node.js runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { announceFirstRun } = await import("@/lib/auth/first-run");
  announceFirstRun();
  const { deploymentWarnings } = await import("@/lib/deployment-warnings-core");
  for (const line of deploymentWarnings(process.env)) console.warn(`Keelson: ${line}`);
}
