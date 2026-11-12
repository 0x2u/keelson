"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { verifySecondFactor, type LoginState } from "@/app/actions";
import { TextField } from "@/components/forms/fields";
import { PasskeyLoginButton } from "@/components/PasskeyLoginButton";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function SecondFactorForm({ showPasskey }: { showPasskey: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(verifySecondFactor, {});
  const [code, setCode] = useState("");
  const [missing, setMissing] = useState(false);

  return (
    <div className="grid gap-4">
      <form
        action={action}
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          if (code.trim() === "") {
            event.preventDefault();
            setMissing(true);
          }
        }}
      >
        <TextField
          id="code"
          name="code"
          label="Verification code"
          help="This step stays valid for 5 minutes. After that, sign in again."
          error={missing && code.trim() === "" ? "Enter a verification code or a recovery code" : state.error}
          value={code}
          onChange={(next) => {
            setCode(next);
            setMissing(false);
          }}
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus
          mono
          inputClassName="h-11 text-lg tracking-wide"
        />
        <Button type="submit" loading={pending} className="w-full">
          Verify
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
      <Link href="/login" className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}
