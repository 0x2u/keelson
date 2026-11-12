import { redirect } from "next/navigation";
import { appsTabHref } from "@/lib/redirects-core";

/** The hub's Apps tab was called Services: an old link or bookmark lands on its new address. */
export default async function ServicesRedirect({ params }: { params: Promise<{ project: string }> }) {
  redirect(appsTabHref(decodeURIComponent((await params).project)));
}
