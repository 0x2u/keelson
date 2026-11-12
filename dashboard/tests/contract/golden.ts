import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// contract/agent holds what a real agent answered (scripts/capture-contract.sh writes it; CI fails when the agent would now
// answer differently). The tests of this folder read it with the dashboard's own code.

const DIR = path.resolve(import.meta.dirname, "../../../contract/agent");

/** The answers there are, by the name of the file without its extension. */
export const goldenNames = (): string[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();

/** One answer, parsed afresh: a test may change what it gets. */
export const golden = <T>(name: string): T => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as T;
