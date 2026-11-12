import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { SetupSteps } from "@/components/setup/SetupSteps";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { secondFactorEnrolled } from "@/lib/auth/store";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Add a second factor" };

export default async function SecurePage() {
  await requireSession({ allowSetupSession: true });
  if (secondFactorEnrolled()) redirect("/");
  return (
    <AuthShell wide>
      <SetupSteps current={3} />
      <Card>
        <CardHeader>
          <h1 className="leading-none font-semibold">Add a second factor</h1>
          <CardDescription>
            Recommended. This dashboard can deploy to and read the logs of every server you connect, and for now one password is all that protects it. An authenticator app or a passkey adds a second check at sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Button asChild className="w-full">
            <Link href="/settings/security">Set up a second factor</Link>
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link href="/">Skip for now</Link>
          </Button>
          <p className="text-center text-xs text-muted-foreground">You can do it later in Settings &gt; Security; the readiness checklist reminds you.</p>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
