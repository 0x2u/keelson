"use client";

import { RouteError } from "@/components/RouteError";

/** Replaces only the tab's content: the layout above keeps the server header and the tab bar. */
export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} back={{ href: "/servers", label: "Back to servers" }} className="max-w-xl" />;
}
