import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { SecondFactorForm } from "@/components/SecondFactorForm";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { listPasskeys } from "@/lib/auth/store";
import { passkeysAvailable } from "@/lib/auth/webauthn";
import { hasPendingLogin } from "@/lib/session";

export const metadata: Metadata = { title: "Two-step verification" };

export default async function VerifyPage() {
  if (!(await hasPendingLogin())) redirect("/login");
  const showPasskey = passkeysAvailable() && listPasskeys().length > 0;

  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <h1 className="leading-none font-semibold">Two-step verification</h1>
          <CardDescription>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</CardDescription>
        </CardHeader>
        <CardContent>
          <SecondFactorForm showPasskey={showPasskey} />
        </CardContent>
      </Card>
    </AuthShell>
  );
}
