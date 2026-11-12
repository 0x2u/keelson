// Prints KEELSON_ADMIN_PASSWORD_HASH for a password read without echo from the
// terminal, or from stdin when piped. The password never appears in argv.
import { hashPassword } from "../lib/password.ts";
import { MIN_PASSWORD_LENGTH } from "../lib/password-rules.ts";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

let password: string;
if (process.stdin.isTTY) {
  password = await readHidden("Password: ");
  if (password !== (await readHidden("Again: "))) {
    console.error("The two passwords differ.");
    process.exit(1);
  }
} else {
  password = await readStdin();
}

if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}
console.log(`KEELSON_ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
