"use client";

import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ICONS } from "@/lib/icons";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

async function postJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body: fall through to the generic message below.
  }
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : "The server could not complete the passkey sign-in.";
    throw new Error(message);
  }
  return data;
}

export function PasskeyLoginButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setError(null);
    if (!browserSupportsWebAuthn()) {
      setError("This browser does not support passkeys. Use your password instead.");
      return;
    }
    setPending(true);
    try {
      const optionsJSON = (await postJson("/api/auth/passkey/login/options")) as PublicKeyCredentialRequestOptionsJSON;
      const response = await startAuthentication({ optionsJSON });
      await postJson("/api/auth/passkey/login/verify", { response });
      // The session cookie is already set: go to the app and re-render with it.
      router.replace("/");
      router.refresh();
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        // Cancelled or timed out: not an error, just return to idle.
      } else if (err instanceof Error && err.message) {
        setError(err.message);
      } else {
        setError("Passkey sign-in failed. Try again or use your password.");
      }
    }
    setPending(false);
  }

  return (
    <div className="grid gap-2">
      <Button type="button" variant="outline" className="w-full" onClick={signIn} loading={pending}>
        <ICONS.secret />
        {pending ? "Waiting for your passkey…" : "Sign in with a passkey"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
