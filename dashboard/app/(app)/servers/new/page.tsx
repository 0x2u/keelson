import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { AddServerTabs } from "@/components/servers/AddServerTabs";
import { enrolParam } from "@/lib/enroll-core";

export const metadata: Metadata = { title: "Add server" };

type Param = string | string[] | undefined;
const one = (v: Param) => (typeof v === "string" ? v : undefined);

export default async function NewServerPage({ searchParams }: { searchParams: Promise<Record<string, Param>> }) {
  const q = await searchParams;
  // An import hands over the address of a server that has no agent yet; the installer opens with it filled in.
  const prefill = { name: one(q.name), host: one(q.host), port: one(q.port), user: one(q.user) };
  const enrol = enrolParam(q.enrol);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Servers", href: "/servers" }, { label: "Add server" }]}
        title="Add a server"
        description="Run one command on the server: its agent installs itself and connects out to this dashboard, with nothing to open on the server."
      />
      <AddServerTabs key={`${enrol ?? ""}/${prefill.name}/${prefill.host}/${prefill.port}/${prefill.user}`} prefill={prefill} enrol={enrol} />
    </>
  );
}
