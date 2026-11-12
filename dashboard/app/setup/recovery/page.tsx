import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { Notice } from "@/components/states";
import { RecoveryForm } from "@/components/setup/RecoveryForm";
import { SetupSteps } from "@/components/setup/SetupSteps";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { recoveryStepOf } from "@/lib/auth/setup";
import { keySource } from "@/lib/env";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = { title: "Save your recovery file" };

export default async function RecoveryPage() {
  // Only the session that finished the setup, and only until it closes this step: after that the key is never shown again.
  const session = await currentSession();
  if (!session) redirect("/login");
  const step = recoveryStepOf(session.id);
  if (!step) redirect("/");
  const fromFile = keySource() === "file";

  return (
    <AuthShell wide>
      <SetupSteps current={2} />
      <Card>
        <CardHeader>
          <h1 className="leading-none font-semibold">{fromFile ? "Save your recovery file" : "Keep your master key"}</h1>
          <CardDescription>
            {fromFile
              ? "Keelson made a master key to encrypt the credentials it stores for your servers. The recovery file holds that key."
              : "Keelson encrypts the credentials it stores for your servers with a master key."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {fromFile ? (
            <Notice tone="warning" title="Shown once">
              Keep the file apart from this dashboard&apos;s data volume, for instance in a password manager. If the key is lost, the stored server credentials cannot be read again and you add your servers again. After you leave this screen the key is never displayed.
            </Notice>
          ) : (
            <Notice tone="info" title="The key is in the environment">
              This dashboard was started with <span className="font-mono">KEELSON_DASHBOARD_KEY</span>, so it keeps no copy and there is no file to download. Keep that value somewhere safe: without it the stored server credentials cannot be read.
            </Notice>
          )}
          <RecoveryForm fromFile={fromFile} downloaded={step.downloaded} />
        </CardContent>
      </Card>
    </AuthShell>
  );
}
