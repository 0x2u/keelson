import type { Metadata } from "next";
import { headers } from "next/headers";
import { PageHeader } from "@/components/page-header";
import { ApiTokensSection } from "@/components/security/ApiTokensSection";
import { listApiTokensWithStatus } from "@/lib/api-tokens";
import { publicUrl, secureCookies, trustProxy } from "@/lib/env";
import { dashboardOrigin } from "@/lib/github-webhook-core";
import { listServers } from "@/lib/servers";

export const metadata: Metadata = { title: "API tokens" };

export default async function ApiTokensPage() {
  const h = await headers();
  const origin = dashboardOrigin({
    publicUrl: publicUrl(),
    host: h.get("host"),
    forwardedHost: h.get("x-forwarded-host"),
    forwardedProto: h.get("x-forwarded-proto"),
    trustProxy: trustProxy(),
    secure: secureCookies(),
  });
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "API tokens" }]}
        title="API tokens"
        description="Access for machines: the REST API under /api/v1 and the MCP server. Each token has a scope, an expiry and can be limited to some servers."
      />
      <div className="grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
        <ApiTokensSection tokens={listApiTokensWithStatus()} servers={listServers().map((s) => ({ id: s.id, name: s.name }))} origin={origin} />
      </div>
    </>
  );
}
