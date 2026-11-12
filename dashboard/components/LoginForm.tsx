"use client";

import { useActionState, useState } from "react";
import { login, type LoginState } from "@/app/actions";
import { PasskeyLoginButton } from "@/components/PasskeyLoginButton";
import { PasswordField } from "@/components/PasswordField";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function LoginForm({ showPasskey }: { showPasskey: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);

  return (
    <div className="grid gap-4">
      <form
        action={action}
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          // No native "required" bubble: an empty password is reported next to the field instead of being sent.
          if (password === "") {
            event.preventDefault();
            setMissing(true);
          }
        }}
      >
        <PasswordField
          id="password"
          name="password"
          label="Password"
          error={missing && password === "" ? "Enter your password" : state.error}
          value={password}
          onChange={(next) => {
            setPassword(next);
            setMissing(false);
          }}
          autoComplete="current-password"
          autoFocus
        />
        <Button type="submit" loading={pending} className="w-full">
          Sign in
        </Button>
      </form>
      {showPasskey && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            or
            <Separator className="flex-1" />
          </div>
          <PasskeyLoginButton />
        </>
      )}
    </div>
  );
}
