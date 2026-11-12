"use client";

import { RouteError } from "@/components/RouteError";

/** Replaces only the tab's content: the layout above keeps the project header and the tab bar. */
export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} back={{ href: "/projects", label: "Back to projects" }} className="max-w-xl" />;
}
