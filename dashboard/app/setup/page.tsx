import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { SetupForm } from "@/components/setup/SetupForm";
import { SetupSteps } from "@/components/setup/SetupSteps";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { setupRequired } from "@/lib/env";

export const metadata: Metadata = { title: "Set up Keelson" };

export default function SetupPage() {
  // The setup answers only while no admin password exists; after that this address is just another way to the sign-in.
  if (!setupRequired()) redirect("/login");
  return (
    <AuthShell wide>
      <SetupSteps current={1} />
      <Card>
        <CardHeader>
          <h1 className="leading-none font-semibold">Set up Keelson</h1>
          <CardDescription>
            Choose the admin password for this dashboard. The setup token proves you control the machine it runs on: it is in the container log and in the installer&apos;s output.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </AuthShell>
  );
}
