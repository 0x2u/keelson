import { ICONS } from "@/lib/icons";
import { Fragment, type ReactNode } from "react";
import { RelativeTime } from "@/components/relative-time";
import type { DeploymentView, RefView } from "@/lib/project-view-core";
import { cn } from "@/lib/utils";

/**
 * A version the way a person names it: the commit's message (else its short hash or its tag), and under it where it came
 * from: the branch, the hash, and, when the deployment is known, when and how it was deployed.
 */
export function VersionSentence({ version, deployment, className, large }: { version: RefView; deployment: DeploymentView | null; className?: string; large?: boolean }) {
  const parts: ReactNode[] = [];
  if (version.branch !== null) {
    parts.push(
      <span key="branch" className="inline-flex items-center gap-1">
        <ICONS.source aria-hidden className="size-3" />
        {version.branch}
      </span>,
    );
  }
  // Without a message the hash is the title already.
  if (version.sha !== null && version.message !== null) {
    parts.push(
      <span key="sha" className="font-mono">
        {version.sha}
      </span>,
    );
  }
  if (deployment) {
    parts.push(<RelativeTime key="when" at={deployment.startedAt} />, <span key="how">{deployment.trigger}</span>);
  }
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <p className={cn("truncate font-medium", large ? "text-base" : "text-sm", version.message === null && "font-mono")} title={version.message ?? version.version}>
        {version.message ?? version.version}
      </p>
      {parts.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {parts.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden>·</span>}
              {part}
            </Fragment>
          ))}
        </p>
      )}
    </div>
  );
}
