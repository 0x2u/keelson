#!/usr/bin/env node
import { main } from "./cli.ts";

const code = await main(process.argv.slice(2), process.env, {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
if (code !== "serve") process.exitCode = code;
