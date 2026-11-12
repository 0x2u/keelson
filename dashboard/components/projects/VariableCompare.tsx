import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { TableCard } from "@/components/layout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { comparisonSummary, variablesHref, type EnvironmentComparison } from "@/lib/project-variables-core";
import { variableCell, type VariableState } from "@/lib/projects-core";
import { cn } from "@/lib/utils";

export const STATE_LABEL: Record<VariableState, { label: string; variant: "success" | "warning" | "danger" | "info" | "muted" }> = {
  same: { label: "Same", variant: "muted" },
  different: { label: "Different", variant: "warning" },
  "only-a": { label: "Only here", variant: "info" },
  "only-b": { label: "Only there", variant: "info" },
  secret: { label: "Value hidden", variant: "muted" },
};

/** The `env:` of two environments side by side: a variable set in one and missing in the other is the usual surprise. Collapsed until asked for. */
export function VariableCompare({ project, comparison, open, keep }: { project: string; comparison: EnvironmentComparison; open: boolean; keep?: { env?: string; app?: string } }) {
  const { a, b, rows, pairs, errorA, errorB } = comparison;
  return (
    <TableCard data-testid="variable-compare">
      <details className="group" open={open}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="leading-none font-semibold">Compare environments</span>
            <span className="text-sm text-muted-foreground">
              <span className="capitalize">{a.name}</span> and <span className="capitalize">{b.name}</span>
            </span>
          </span>
          <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-4 pb-4">
          <p className="px-4 text-sm text-muted-foreground">
            The <code className="font-mono text-xs">env</code> of the two apps. The agent hides every value (they are often secrets), so this compares which variables exist: a variable set in
            one environment and missing in the other is the usual surprise. What an <code className="font-mono text-xs">env_file</code> holds stays on the server.
          </p>
          {pairs.length > 1 && (
            <nav aria-label="Environments to compare" className="flex flex-wrap gap-2 px-4 text-sm">
              {pairs.map(({ x, y }) => {
                const current = x === a.name && y === b.name;
                return (
                  <Link
                    key={`${x}-${y}`}
                    href={variablesHref(project, { ...keep, a: x, b: y })}
                    scroll={false}
                    aria-current={current ? "true" : undefined}
                    className={cn("rounded-md px-2.5 py-1", current ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}
                  >
                    {x} ↔ {y}
                  </Link>
                );
              })}
            </nav>
          )}
          {(errorA || errorB) && (
            <div className="px-4 pb-4">
              <Notice tone="warning" title="A configuration could not be read">
                {errorA ? `${a.name}: ${errorA}. ` : ""}
                {errorB ? `${b.name}: ${errorB}.` : ""}
              </Notice>
            </div>
          )}
          {rows.length === 0 && !errorA && !errorB ? (
            <p className="px-4 text-sm text-muted-foreground">Neither app sets variables in its configuration.</p>
          ) : (
            rows.length > 0 && (
              <>
                <p className="px-4 pb-3 text-sm text-muted-foreground">{comparisonSummary(comparison)}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variable</TableHead>
                      <TableHead>{a.name}</TableHead>
                      <TableHead>{b.name}</TableHead>
                      <TableHead className="text-right">State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="font-mono text-xs">{r.key}</TableCell>
                        <TableCell className={cn("max-w-48 truncate font-mono text-xs", r.a === undefined && "text-muted-foreground")}>{variableCell(r.a)}</TableCell>
                        <TableCell className={cn("max-w-48 truncate font-mono text-xs", r.b === undefined && "text-muted-foreground")}>{variableCell(r.b)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={STATE_LABEL[r.state].variant}>{STATE_LABEL[r.state].label}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )
          )}
        </div>
      </details>
    </TableCard>
  );
}
