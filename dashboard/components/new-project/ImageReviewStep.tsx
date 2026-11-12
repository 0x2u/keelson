"use client";

import { ReviewPanel } from "@/components/new-project/ReviewStep";
import { Notice } from "@/components/states";
import type { ImageReview } from "@/lib/new-project-image-core";
import type { ProjectVar } from "@/lib/new-project-core";
import type { ReviewLine } from "@/lib/new-project-wizard-core";

/** How the app is exposed, as the review says it. */
function exposedAs(review: ImageReview): string {
  switch (review.exposure.kind) {
    case "domain":
      return `https://${review.exposure.domain}`;
    case "local":
      return review.exposure.open
        ? `port ${review.exposure.hostPort} of the server, on every interface (plain http: anyone who can reach the server can open it)`
        : `127.0.0.1:${review.exposure.hostPort} on the server only`;
    default:
      return "nothing: it publishes no port and has no domain";
  }
}

/**
 * Everything that will be written and done, before the button: names, never a value. The same panel as the repository's
 * review, with the lines of an image: no build, no repository, and the first deployment of the version typed.
 */
export function ImageReviewStep({
  serverName,
  review,
  variables,
  envSupported,
  dns,
  errorCount,
}: {
  serverName: string;
  /** The form as it will be sent; null while it still has problems. */
  review: ImageReview | null;
  /** Names and flags only. */
  variables: Pick<ProjectVar, "key" | "build">[];
  envSupported: boolean;
  /** What happens to the domain's DNS, in words; null without a domain. */
  dns: string | null;
  errorCount: number;
}) {
  if (review === null) {
    return (
      <Notice title="The form is not complete">
        {errorCount} field{errorCount === 1 ? "" : "s"} need attention. Go back to the step that has them: nothing is lost.
      </Notice>
    );
  }
  const lines: ReviewLine[] = [
    { label: "Server", value: serverName },
    { label: "App", value: review.name },
    { label: "Image", value: review.repository },
    { label: "First deployment", value: review.version },
    { label: "Container port", value: review.port === null ? "none: it publishes nothing" : String(review.port) },
    { label: "Exposed as", value: exposedAs(review) },
    ...(review.healthPath !== "" ? [{ label: "Health path", value: review.healthPath }] : []),
    { label: "Restarts", value: "with the server, unless you stop it" },
  ];
  return (
    <ReviewPanel
      lines={lines}
      variables={variables}
      envSupported={envSupported}
      plan={[
        { label: "Write the app into the server's configuration", note: null },
        { label: "Set the variables on the server", note: variables.length === 0 || !envSupported ? " (nothing to set)" : ` (${variables.length})` },
        { label: "Point the domain at the server", note: dns === null ? " (no domain)" : <span className="block text-muted-foreground">{dns}</span> },
        { label: "Start the first deployment", note: <span className="block text-muted-foreground">Deploys {review.version}, the same as the Deploy button. This page then says how to open the app.</span> },
      ]}
    />
  );
}
