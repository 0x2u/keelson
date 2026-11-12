import type { SshTarget } from "@/lib/ssh-install-core";

/** The SSH login part of what an SSH form submits. */
export interface LoginValues {
  username: string;
  authKind: "key" | "password";
  privateKey: string;
  passphrase: string;
  password: string;
  sudoPassword: string;
}

export type LoginErrors = Partial<Record<"privateKey" | "password", string>>;

/** The checks that need no network: a key that looks like a key, a password that is not empty. */
export function checkLogin(values: LoginValues, errors: LoginErrors): void {
  if (values.authKind === "key" && !/BEGIN [A-Z ]*PRIVATE KEY/.test(values.privateKey)) errors.privateKey = "Paste a private key (the whole file).";
  if (values.authKind === "password" && values.password === "") errors.password = "Enter the password.";
}

export function toSshTarget(values: LoginValues, host: string, port: number): SshTarget {
  return {
    host,
    port,
    username: values.username.trim(),
    auth:
      values.authKind === "key"
        ? { kind: "key", privateKey: values.privateKey, passphrase: values.passphrase || undefined }
        : { kind: "password", password: values.password },
    sudoPassword: values.sudoPassword || undefined,
  };
}
