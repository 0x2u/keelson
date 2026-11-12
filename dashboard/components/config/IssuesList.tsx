import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import type { ConfigIssue } from "@/lib/agent-types";
import { issueInFile } from "@/lib/project-config-core";

/**
 * What is wrong with a configuration, one line each: severity, where, why, and a jump to the line when it is known. Errors
 * come first. When the configuration has project files an issue names its file; `file` is the one being edited, and only
 * the lines of that file can be jumped to (the line of another file is shown, not clickable).
 */
export function IssuesList({ issues, onSelectLine, file }: { issues: ConfigIssue[]; onSelectLine?: (line: number) => void; file?: string }) {
  const sorted = [...issues].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
  return (
    <ul className="divide-y rounded-md border bg-card text-sm">
      {sorted.map((issue, i) => {
        const Icon = issue.severity === "error" ? CircleAlertIcon : TriangleAlertIcon;
        const { line } = issue;
        return (
          <li key={`${i}-${issue.path}-${issue.message}`} className="flex items-start gap-2 px-3 py-2">
            <Icon aria-hidden className={issue.severity === "error" ? "mt-0.5 size-4 shrink-0 text-destructive" : "mt-0.5 size-4 shrink-0 text-warning"} />
            <span className="sr-only">{issue.severity === "error" ? "Error:" : "Warning:"}</span>
            <div className="min-w-0 flex-1">
              <span className="mr-2 break-all font-mono text-xs text-muted-foreground">{issue.path}</span>
              <span className="break-words">{issue.message}</span>
            </div>
            {issue.file !== undefined && <span className="shrink-0 break-all font-mono text-xs text-muted-foreground">{issue.file}</span>}
            {line !== undefined &&
              (onSelectLine && issueInFile(issue, file) ? (
                <button
                  type="button"
                  onClick={() => onSelectLine(line)}
                  className="shrink-0 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Go to line ${line}`}
                >
                  line {line}
                </button>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">line {line}</span>
              ))}
          </li>
        );
      })}
    </ul>
  );
}
