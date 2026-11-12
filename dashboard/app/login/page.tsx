import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { LoginForm } from "@/components/LoginForm";
import { listPasskeys } from "@/lib/auth/store";
import { passkeysAvailable } from "@/lib/auth/webauthn";
import { setupRequired } from "@/lib/env";
import { hasSession } from "@/lib/session";
import { Notice } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { LOST_PASSWORD_DOCS_URL } from "@/lib/public-url-help-core";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Nobody can sign in before there is a password: the proxy already sends every page to the setup, this keeps the page honest on its own.
  if (setupRequired()) redirect("/setup");
  // A signed cookie is not enough: the session may have been revoked or expired. Only a live one skips the form.
  if (await hasSession()) redirect("/");
  const showPasskey = passkeysAvailable() && listPasskeys().length > 0;
  const { reason } = await searchParams;
  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <h1 className="leading-none font-semibold">Sign in</h1>
          <CardDescription>Enter the admin password to operate your servers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {reason === "attempts" ? (
            <Notice tone="warning" title="That sign-in was cancelled">
              Five wrong verification codes were entered. Enter your password to start again.
            </Notice>
          ) : null}
          <LoginForm showPasskey={showPasskey} />
          <p className="text-xs text-muted-foreground">
            Lost the password?{" "}
            <a href={LOST_PASSWORD_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              It is reset from the server
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
