"use client";

import { useActionState, useState } from "react";
import { completeSetupAction, type SetupState } from "@/app/setup/actions";
import { TextField } from "@/components/forms/fields";
import { PasswordField } from "@/components/PasswordField";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-rules";
import { INSTALL_DIR, SETUP_TOKEN_COMMAND } from "@/lib/public-url-help-core";
import { setupErrors } from "@/lib/setup-core";

export function SetupForm() {
  const [state, action, pending] = useActionState<SetupState, FormData>(completeSetupAction, {});
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  // What the server said stands until that field is edited again.
  const [edited, setEdited] = useState<Partial<Record<"token" | "password" | "confirm", boolean>>>({});

  const local = setupErrors({ token, password, confirm });
  // A field's own problem shows once the field has been typed in, or on every field after a send that was held back.
  const tokenError = (submitted ? local.token : undefined) ?? (edited.token ? undefined : state.errors?.token);
  const passwordError = (submitted || password !== "" ? local.password : undefined) ?? (edited.password ? undefined : state.errors?.password);
  const confirmError = (submitted || confirm !== "" ? local.confirm : undefined) ?? (edited.confirm ? undefined : state.errors?.confirm);

  return (
    <form
      action={(form) => {
        setEdited({});
        action(form);
      }}
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        // No native "required" bubbles: every problem is listed next to its field, and nothing is sent until there is none.
        if (Object.keys(local).length > 0) {
          event.preventDefault();
          setSubmitted(true);
        }
      }}
    >
      {state.error && <Notice title="Setup not possible">{state.error}</Notice>}
      <TextField
        id="token"
        name="token"
        label="Setup token"
        help={
          <>
            Printed in the container log each time the dashboard starts: the line that begins <span className="font-mono">Keelson setup token</span>. On the server, run{" "}
            <span className="font-mono break-all">{SETUP_TOKEN_COMMAND}</span> (in the folder the installer used, <span className="font-mono">{INSTALL_DIR}</span> by default).
          </>
        }
        error={tokenError}
        value={token}
        onChange={(next) => {
          setToken(next);
          setEdited((e) => ({ ...e, token: true }));
        }}
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        mono
      />
      <PasswordField
        id="password"
        name="password"
        label="Admin password"
        help={`At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words are easier to remember than a short mix of symbols, and stronger.`}
        error={passwordError}
        value={password}
        onChange={(next) => {
          setPassword(next);
          setEdited((e) => ({ ...e, password: true }));
        }}
        autoComplete="new-password"
      />
      <PasswordField
        id="confirm"
        name="confirm"
        label="Repeat the password"
        error={confirmError}
        value={confirm}
        onChange={(next) => {
          setConfirm(next);
          setEdited((e) => ({ ...e, confirm: true }));
        }}
        autoComplete="new-password"
      />
      <Button type="submit" loading={pending} className="w-full">
        Set up Keelson
      </Button>
    </form>
  );
}
