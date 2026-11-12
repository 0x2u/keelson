import { IssuesList } from "@/components/config/IssuesList";
import { Notice } from "@/components/states";
import type { ConfigIssue } from "@/lib/agent-types";
import { deprecationsTitle, MIGRATE_COMMAND, MIGRATE_HELP } from "@/lib/deprecations-core";

/** What the agent reports about spellings of the files that have a new name: where, which one, and how to migrate them. Nothing when there are none. */
export function DeprecationsNotice({ issues }: { issues: ConfigIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div data-testid="deprecations">
      <Notice tone="warning" title={deprecationsTitle(issues.length)}>
        <div className="space-y-3">
          <p>
            {MIGRATE_HELP} <code className="font-mono text-xs">{MIGRATE_COMMAND}</code>
          </p>
          <IssuesList issues={issues} />
        </div>
      </Notice>
    </div>
  );
}
