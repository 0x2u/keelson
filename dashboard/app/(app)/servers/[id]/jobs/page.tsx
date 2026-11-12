import { redirect } from "next/navigation";
import { serverListHref } from "@/lib/nav-core";

/** The old Jobs tab of a server: the global list of jobs, narrowed to that server. */
export default async function ServerJobsRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(serverListHref("jobs", decodeURIComponent(id)));
}
