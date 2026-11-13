import "server-only";
import { chmodSync, closeSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { dashboardVersion } from "@/lib/agent-binaries";
import { updateCheckEnabled } from "@/lib/env";
import { buildRequest, MARKER_FILE, parseMarker, REQUEST_FILE, STATUS_FILE, updatePayload, type UpdatePayload } from "@/lib/updater-core";

// The directory shared with the host (see lib/updater-core.ts). The files in it are written by the host as root and are read
// here as untrusted: a cap on how much is read, and everything else is the core's checking.

/** The shared directory: KEELSON_RUN_DIR, or /run/keelson where the compose file mounts it. */
export function runDir(): string {
  return process.env.KEELSON_RUN_DIR?.trim() || "/run/keelson";
}

/** Every file of the protocol is a few hundred bytes; a bigger one is not one of them. */
const READ_MAX = 8192;

function readText(name: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path.join(runDir(), name), "r");
    const buffer = Buffer.alloc(READ_MAX);
    const n = readSync(fd, buffer, 0, READ_MAX, 0);
    return n === READ_MAX ? null : buffer.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The one-click update is available: the host side is installed, and the update check is not turned off (with it off nothing of this feature shows). */
export function updaterAvailable(): boolean {
  return updateCheckEnabled() && parseMarker(readText(MARKER_FILE));
}

/** What the status route answers: availability, the version this dashboard runs, the host's status and whether a request waits. */
export function updaterState(now: number = Date.now()): UpdatePayload {
  return updatePayload({ updater: updaterAvailable(), version: dashboardVersion(), statusText: readText(STATUS_FILE), requestText: readText(REQUEST_FILE), now });
}

/**
 * Writes the request file for the host: a temporary file in the same directory, then a rename, so the host never reads a
 * half-written one. World-readable (the host runs as root and reads it; it holds nothing secret).
 */
export function writeUpdateRequest(version: string, now: Date): void {
  const dir = runDir();
  const tmp = path.join(dir, `.${REQUEST_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, buildRequest(version, now), { mode: 0o644, flag: "wx" });
    chmodSync(tmp, 0o644); // the process umask must not narrow it: the host reads it as another user
    renameSync(tmp, path.join(dir, REQUEST_FILE));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
