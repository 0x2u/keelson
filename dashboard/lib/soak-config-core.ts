import type { AppConfig } from "@/lib/agent-types";

/** The most pages a soak requests, as the agent allows. */
export const MAX_VERIFY = 10;

/** One verify entry as a line of the form: "/products/1", or "/moved 301" when the page must answer that status. */
export function verifyLine(v: { path: string; status?: number }): string {
  return v.status ? v.path + " " + v.status : v.path;
}

/** The lines of the form as the agent's `verify` list; the lines are validated first (see verifyError). */
export function verifyFromLines(lines: string[]): NonNullable<AppConfig["verify"]> {
  return lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const [path, status] = l.split(/\s+/);
      return status ? { path, status: Number(status) } : { path };
    });
}

/** What is wrong with the lines, in the agent's own terms; undefined when they are fine. */
export function verifyError(lines: string[]): string | undefined {
  const entries = lines.map((l) => l.trim()).filter((l) => l !== "");
  if (entries.length > MAX_VERIFY) return `At most ${MAX_VERIFY} pages: each one is requested every few seconds for the whole soak.`;
  for (const l of entries) {
    const parts = l.split(/\s+/);
    if (parts.length > 2) return `"${l}": a page, then optionally the status it must answer, for example /moved 301.`;
    const [path, status] = parts;
    if (!path.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(path)) return `"${path}" must start with / and contain no spaces.`;
    if (status !== undefined && !(/^\d{3}$/.test(status) && Number(status) >= 100 && Number(status) <= 599)) return `"${status}" is not an HTTP status code.`;
  }
  return undefined;
}
