import { redirect } from "next/navigation";
import { serverActivityHref } from "@/lib/redirects-core";

/** The audit log of a server is part of Activity (the changes of that server). */
export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(serverActivityHref(id));
}
