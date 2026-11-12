import { redirect } from "next/navigation";
import { serverListHref } from "@/lib/nav-core";

/** The old Databases tab of a server: the global list of databases, narrowed to that server. */
export default async function ServerDatabasesRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(serverListHref("databases", decodeURIComponent(id)));
}
