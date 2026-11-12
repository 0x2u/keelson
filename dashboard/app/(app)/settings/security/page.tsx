import Link from "next/link";
import type { Metadata } from "next";
import { PasskeysSection } from "@/components/security/PasskeysSection";
import { RecoveryCodesSection } from "@/components/security/RecoveryCodesSection";
import { SessionsSection } from "@/components/security/SessionsSection";
import { TotpSection } from "@/components/security/TotpSection";
import { PageHeader } from "@/components/page-header";
import { activityHref } from "@/lib/redirects-core";
import { listLiveSessions, listPasskeys, recoveryCodesLeft, secondFactorEnrolled, totpEnabled } from "@/lib/auth/store";
import { passkeysAvailable } from "@/lib/auth/webauthn";
import { Notice } from "@/components/states";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const query = await searchParams;
  const required = query.required === "1";
  const current = await currentSession();
  const passkeys = listPasskeys().map(({ id, name, createdAt, lastUsedAt, transports }) => ({ id, name, createdAt, lastUsedAt, transports }));
  const sessions = listLiveSessions().map(({ id, createdAt, lastSeenAt, ip, userAgent, method }) => ({ id, createdAt, lastSeenAt, ip, userAgent, method }));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Security" }]}
        title="Security"
        description="Protect access to this dashboard. It can deploy to and read logs from every server, so a second factor, recovery codes and a watch on active sessions matter."
      />
      {required && (
        <div className="mb-6 max-w-5xl">
          <Notice tone="warning" title={secondFactorEnrolled() ? "Sign in again to continue" : "A second factor is required"}>
            {secondFactorEnrolled()
              ? "Your second factor is set up. Sign out and sign in again with it to unlock the rest of the dashboard."
              : "This dashboard is configured to refuse sessions without a second factor. Set up an authenticator or a passkey below, then sign in again."}
          </Notice>
        </div>
      )}
      <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
        <TotpSection enabled={totpEnabled()} />
        <PasskeysSection available={passkeysAvailable()} passkeys={passkeys} />
        {secondFactorEnrolled() && <RecoveryCodesSection left={recoveryCodesLeft()} />}
        <SessionsSection sessions={sessions} currentId={current?.id ?? null} />
        <p className="text-sm text-muted-foreground">
          <Link href={activityHref({ kind: "security" })} className="font-medium text-foreground underline-offset-4 hover:underline">
            See the security events in Activity
          </Link>
        </p>
      </div>
    </>
  );
}
