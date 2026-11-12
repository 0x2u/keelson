import { redirect } from "next/navigation";
import { newProjectHref } from "@/lib/nav-core";

/** The old address of "Add app from GitHub": it is "New project" now, and keeps what it was given. */
export default async function AddAppRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(newProjectHref(await searchParams));
}
