import { RelativeTime } from "@/components/relative-time";
import { CiBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { servingSentence, servingState } from "@/lib/app-source-core";
import type { Commit, Comparison, WorkflowRun } from "@/lib/github-core";

/** What serves compared with the head of the linked branch, and the latest CI run on it. */
export function SourceSummary({
  branch,
  serving,
  servingSha,
  servingCommit,
  behind,
  latestRun,
}: {
  branch: string;
  serving: string | null;
  servingSha: string | null;
  servingCommit?: Pick<Commit, "message">;
  behind: Pick<Comparison, "aheadBy"> | null | undefined;
  latestRun: WorkflowRun | undefined;
}) {
  const state = servingState(serving, servingSha, behind ? behind.aheadBy : null);
  const sentence = servingSentence(state, branch);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Serving commit</CardDescription>
          <CardTitle className="min-w-0 text-base">
            {servingSha !== null ? <span className="font-mono text-sm">{servingSha.slice(0, 7)}</span> : <span className="text-muted-foreground">Not a commit</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {state.kind === "nothing" ? (
            "Nothing is running."
          ) : state.kind === "untagged" ? (
            "The running image is not tagged with a commit SHA, so it cannot be matched to the repository."
          ) : (
            <>
              {servingCommit ? <span className="text-foreground">{servingCommit.message}. </span> : null}
              {sentence}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Latest CI run on {branch}</CardDescription>
          <CardTitle>{latestRun ? <CiBadge state={latestRun.state} /> : <Badge variant="muted">None</Badge>}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {latestRun ? (
            <>
              {latestRun.name} #{latestRun.number} · <RelativeTime at={latestRun.startedAt} />
            </>
          ) : (
            "No workflow run found on this branch."
          )}
        </CardContent>
      </Card>
    </div>
  );
}
