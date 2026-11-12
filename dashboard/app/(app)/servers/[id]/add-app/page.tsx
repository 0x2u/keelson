import { redirect } from "next/navigation";
import { newProjectHref } from "@/lib/nav-core";

/** The old address of "Add app from GitHub" on a server: "New project" with that server given, and the repository when it was. */
export default async function ServerAddAppRedirect({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  redirect(newProjectHref({ ...query, server: id }));
}
