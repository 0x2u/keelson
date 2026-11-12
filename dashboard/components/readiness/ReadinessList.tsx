import Link from "next/link";
import { InlineLink, PageSection, TableCard } from "@/components/layout";
import { ProveKeyDialog } from "@/components/readiness/ProveKeyDialog";
import { TestAlertDialog } from "@/components/readiness/TestAlertDialog";
import { TestRestoreAction } from "@/components/readiness/TestRestoreAction";
import { ReadinessBadge, StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { READINESS_GROUPS, readinessHref, readinessSummary, type ReadinessItem } from "@/lib/readiness-core";
import { getServer } from "@/lib/servers";
import { READINESS } from "@/lib/status";

/** The button that fixes an item from where it is shown: a dialog that runs the check, or the link to the page that fixes it. */
function Action({ item }: { item: ReadinessItem }) {
  const canDeploy = item.server ? (getServer(item.server.id)?.canDeploy ?? false) : false;
  const serverId = item.server?.id ?? "";
  switch (item.fix) {
    case "test-restore":
      return <TestRestoreAction serverId={serverId} name={item.subject} canDeploy={canDeploy} label={item.state === "ok" ? "Test again" : "Test restore"} />;
    case "prove-key":
      return <ProveKeyDialog serverId={serverId} name={item.subject} canDeploy={canDeploy} label={item.state === "ok" ? "Prove again" : "Prove the key"} />;
    case "test-alert":
      return <TestAlertDialog serverId={serverId} serverName={item.server?.name ?? serverId} canDeploy={canDeploy} label={item.state === "ok" ? "Test again" : "Send a test alert"} />;
    case undefined:
      return item.action ? (
        <Button asChild variant="outline" size="xs">
          <Link href={item.action.href}>{item.action.label}</Link>
        </Button>
      ) : null;
  }
}

/** One check: what it is, the thing it is about, where it stands and why, and the way to fix it. */
export function ReadinessRow({ item, showServer }: { item: ReadinessItem; showServer: boolean }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4" data-check={item.check} data-state={item.state} data-subject={item.subject}>
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{item.title}</span>
          <ReadinessBadge state={item.state} />
          {item.subject !== "" && item.scope === "project" && <span className="font-mono text-xs text-muted-foreground">{item.subject}</span>}
          {showServer && item.server && <span className="text-xs text-muted-foreground">{item.server.name}</span>}
        </p>
        <p className="text-sm break-words text-muted-foreground">{item.detail}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Action item={item} />
      </div>
    </li>
  );
}

/** The line over a checklist: how many checks pass, with the dot of the worst state. */
export function ReadinessHeadline({ items }: { items: ReadinessItem[] }) {
  const summary = readinessSummary(items);
  const worst = summary.worst === null ? READINESS.ok : READINESS[summary.worst.state];
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="readiness-headline">
      <StatusDot tone={worst.tone} />
      <strong className="font-semibold">{summary.text}</strong>
      {summary.worst && (
        <span className="text-muted-foreground">
          · next: <InlineLink href={summary.worst.action?.href ?? readinessHref(summary.worst)}>{summary.worst.title}</InlineLink>
        </span>
      )}
    </p>
  );
}

/** The checklist grouped as Data, Alerts, Deploys and Access; a group with nothing in it is left out. */
export function ReadinessGroups({ items, showServer = false }: { items: ReadinessItem[]; showServer?: boolean }) {
  return (
    <div className="space-y-6" data-testid="readiness">
      {READINESS_GROUPS.map((group) => {
        const mine = items.filter((i) => i.group === group.id);
        if (mine.length === 0) return null;
        const { passing, total } = readinessSummary(mine);
        return (
          <PageSection
            key={group.id}
            id={`readiness-${group.id}`}
            title={group.label}
            action={total > 0 ? <span className="text-xs text-muted-foreground tabular">{passing} of {total} pass</span> : undefined}
          >
            <TableCard>
              <ul className="divide-y" data-group={group.id}>
                {mine.map((item) => (
                  <ReadinessRow key={item.id} item={item} showServer={showServer} />
                ))}
              </ul>
            </TableCard>
          </PageSection>
        );
      })}
    </div>
  );
}
