import { GitCommitHorizontalIcon } from "lucide-react";
import { DeployCommitButton } from "@/components/repository/DeployCommitButton";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, Notice } from "@/components/states";
import { CiBadge, StatusBadge } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AppSource } from "@/lib/app-source";
import { deployBlock, githubUrl } from "@/lib/app-source-core";
import { buildBlock } from "@/lib/build-now-core";
import { commitCi, commitDeployment } from "@/lib/github-core";
import { COMMIT_DEPLOYMENTS } from "@/lib/status";

type Linked = Extract<AppSource, { kind: "linked" }>;

/** The latest commits of the linked branch with their CI result and what happened to them on the server, each with its Deploy button. Shared by the project's Source tab and a builder's own Source page. */
export function CommitsCard({ serverId, app, source, build, canDeploy }: { serverId: string; app: string; source: Linked; build: boolean; canDeploy: boolean }) {
  const { link, commits, runs, serving, deployments, deploying } = source;
  const githubApp = source.context.githubApp;
  // It builds where it runs (a build: block) or on another server that the dashboard sends the image from.
  const builds = build || link.buildOn != null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Commits</CardTitle>
        <CardDescription>The latest commits on {link.branch}, with their CI result and what happened to them on this server.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {commits.error !== undefined ? (
          <div className="px-6">
            <Notice title="Could not load the commits">{commits.error}</Notice>
          </div>
        ) : commits.data?.length === 0 ? (
          <EmptyState icon={GitCommitHorizontalIcon} title="No commits">
            GitHub returned no commits for {link.branch}.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Commit</TableHead>
                  <TableHead>CI</TableHead>
                  <TableHead>On this server</TableHead>
                  <TableHead className="pr-6 text-right">
                    <span className="sr-only">Deploy</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commits.data?.map((c) => {
                  const ci = runs.data ? commitCi(c.sha, runs.data) : null;
                  const state = commitDeployment(c.sha, serving, deployments);
                  const url = githubUrl(c.url);
                  return (
                    <TableRow key={c.sha}>
                      <TableCell className="max-w-md pl-6">
                        <div className="truncate font-medium">{c.message}</div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer noopener" className="font-mono underline-offset-4 hover:underline">
                              {c.sha.slice(0, 7)}
                            </a>
                          ) : (
                            <span className="font-mono">{c.sha.slice(0, 7)}</span>
                          )}
                          <span>{c.author}</span>
                          {c.date && <RelativeTime at={c.date} />}
                        </div>
                      </TableCell>
                      <TableCell>{ci ? <CiBadge state={ci} /> : <span className="text-muted-foreground">No run</span>}</TableCell>
                      <TableCell>{state ? <StatusBadge view={COMMIT_DEPLOYMENTS[state]} /> : <span className="text-muted-foreground">Not deployed</span>}</TableCell>
                      <TableCell className="pr-6 text-right">
                        <DeployCommitButton
                          serverId={serverId}
                          app={app}
                          sha={c.sha}
                          message={c.message}
                          blocked={builds ? buildBlock({ canDeploy, githubAppConfigured: githubApp !== null, linked: true, deploying, serving: state === "serving" }) : deployBlock({ canDeploy, deploying, serving: state === "serving", ci })}
                          builds={builds ? { warning: source.context.where.buildWarning } : null}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The latest workflow runs of the linked branch. */
export function RunsCard({ source }: { source: Linked }) {
  const { link, runs } = source;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workflow runs</CardTitle>
        <CardDescription>The latest runs of this repository&apos;s workflows on {link.branch}.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {runs.error !== undefined ? (
          <div className="px-6">
            <Notice title="Could not load the workflow runs">{runs.error}</Notice>
          </div>
        ) : runs.data?.length === 0 ? (
          <EmptyState title="No workflow runs">This branch has no GitHub Actions run yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Workflow</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="hidden sm:table-cell">Commit</TableHead>
                  <TableHead className="hidden md:table-cell">Event</TableHead>
                  <TableHead className="pr-6">Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data?.map((r) => {
                  const url = githubUrl(r.url);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="pl-6">
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer noopener" className="font-medium underline-offset-4 hover:underline">
                            {r.name} #{r.number}
                          </a>
                        ) : (
                          <span className="font-medium">
                            {r.name} #{r.number}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <CiBadge state={r.state} />
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">{r.sha.slice(0, 7)}</TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{r.event}</TableCell>
                      <TableCell className="pr-6 text-muted-foreground">
                        <RelativeTime at={r.startedAt} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
