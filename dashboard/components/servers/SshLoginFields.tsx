"use client";

import type { InstallValues, FieldErrors } from "@/app/server-install-actions";
import { FieldShell, SegmentedControl, TextField, describeField } from "@/components/forms/fields";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Login = Pick<InstallValues, "host" | "port" | "username" | "authKind" | "privateKey" | "passphrase" | "password" | "sudoPassword">;

/**
 * Where to log in and how: address, port, user, then a key or a password, and a sudo password for a user that is not root. Shared
 * by every flow that logs in over SSH once and keeps nothing; `purpose` completes "… is used for ___ and never stored".
 */
export function SshLoginFields({
  values,
  errors,
  onChange,
  purpose,
}: {
  values: Login;
  errors: FieldErrors;
  /** Receives the field that changed. */
  onChange: (patch: Partial<Login>) => void;
  purpose: string;
}) {
  const isRoot = values.username.trim() === "root";
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_7rem_10rem]">
        <TextField id="ssh-host" label="Address" required value={values.host} onChange={(v) => onChange({ host: v })} error={errors.host} placeholder="203.0.113.10 or server.example.com" help="What you type after ssh." />
        <TextField id="ssh-port" label="SSH port" inputMode="numeric" value={values.port} onChange={(v) => onChange({ port: v })} error={errors.port} />
        <TextField id="ssh-user" label="User" value={values.username} onChange={(v) => onChange({ username: v })} error={errors.username} help={isRoot ? undefined : "Needs sudo."} />
      </div>

      <FieldShell id="auth-kind" label="Sign in with" group>
        <SegmentedControl
          label="Authentication"
          value={values.authKind}
          options={[
            { value: "key", label: "SSH key" },
            { value: "password", label: "Password" },
          ]}
          onChange={(v) => onChange({ authKind: v === "password" ? "password" : "key" })}
        />
      </FieldShell>

      {values.authKind === "key" ? (
        <div className="space-y-4">
          <FieldShell
            id="ssh-key"
            label="Private key"
            required
            error={errors.privateKey}
            help={`The whole private key file, for example ~/.ssh/id_ed25519. It is used for ${purpose} and never stored.`}
          >
            <Textarea
              value={values.privateKey}
              onChange={(e) => onChange({ privateKey: e.target.value })}
              rows={6}
              autoComplete="off"
              spellCheck={false}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
              className="font-mono text-xs"
              {...describeField("ssh-key", true, errors.privateKey)}
            />
          </FieldShell>
          <FieldShell id="ssh-passphrase" label="Key passphrase" help="Only if the key is protected by one.">
            <Input id="ssh-passphrase" type="password" autoComplete="new-password" value={values.passphrase} onChange={(e) => onChange({ passphrase: e.target.value })} />
          </FieldShell>
        </div>
      ) : (
        <FieldShell id="ssh-password" label="Password" required error={errors.password} help={`Used for ${purpose} and never stored.`}>
          <Input type="password" autoComplete="new-password" value={values.password} onChange={(e) => onChange({ password: e.target.value })} {...describeField("ssh-password", true, errors.password)} />
        </FieldShell>
      )}

      {!isRoot && (
        <FieldShell id="sudo-password" label="sudo password" help="Only if sudo asks for one. Not stored.">
          <Input id="sudo-password" type="password" autoComplete="new-password" value={values.sudoPassword} onChange={(e) => onChange({ sudoPassword: e.target.value })} />
        </FieldShell>
      )}
    </>
  );
}
