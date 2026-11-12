// Prints a fresh master key for KEELSON_DASHBOARD_KEY.
import { randomBytes } from "node:crypto";

console.log(`KEELSON_DASHBOARD_KEY=${randomBytes(32).toString("hex")}`);
