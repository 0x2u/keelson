"use client";

import { diffLines } from "diff";
import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type LineKind = "same" | "add" | "del";

interface LineRow {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

type Row = LineRow | { kind: "skip"; count: number };

interface Diff {
  rows: Row[];
  added: number;
  removed: number;
}

/** Unchanged lines kept on each side of a change. */
const CONTEXT = 3;

function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Line by line changes from `before` to `after`, with long unchanged runs folded into one skip row. */
function computeDiff(before: string, after: string): Diff {
  const flat: LineRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    for (const text of linesOf(part.value)) {
      if (part.added) {
        flat.push({ kind: "add", oldNo: null, newNo: newNo++, text });
        added++;
      } else if (part.removed) {
        flat.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
        removed++;
      } else {
        flat.push({ kind: "same", oldNo: oldNo++, newNo: newNo++, text });
      }
    }
  }

  const near = new Array<boolean>(flat.length).fill(false);
  flat.forEach((row, i) => {
    if (row.kind === "same") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(flat.length - 1, i + CONTEXT); j++) near[j] = true;
  });

  const rows: Row[] = [];
  let hidden: LineRow[] = [];
  const flush = () => {
    // Folding one or two lines would take more room than showing them.
    if (hidden.length > 2) rows.push({ kind: "skip", count: hidden.length });
    else rows.push(...hidden);
    hidden = [];
  };
  flat.forEach((row, i) => {
    if (near[i]) {
      flush();
      rows.push(row);
    } else {
      hidden.push(row);
    }
  });
  flush();
  return { rows, added, removed };
}

const ROW_STYLE: Record<LineKind, string> = {
  same: "",
  add: "bg-success/10",
  del: "bg-destructive/10",
};

const MARKER: Record<LineKind, { symbol: string; label: string; className: string }> = {
  same: { symbol: "", label: "", className: "" },
  add: { symbol: "+", label: "Added: ", className: "text-success" },
  del: { symbol: "\u2212", label: "Removed: ", className: "text-destructive" },
};

/**
 * A unified diff of two texts: added and removed lines with line numbers in the gutter and a +/- marker (colour is
 * never the only signal), long unchanged stretches folded.
 */
export function DiffView({
  before,
  after,
  identical = "No changes.",
  className,
}: {
  before: string;
  after: string;
  /** Shown when the texts are the same. */
  identical?: ReactNode;
  className?: string;
}) {
  const { rows, added, removed } = useMemo(() => computeDiff(before, after), [before, after]);

  if (added === 0 && removed === 0) return <p className="text-sm text-muted-foreground">{identical}</p>;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="text-success">{added} added</span>, <span className="text-destructive">{removed} removed</span>
      </p>
      <div className={cn("max-h-[50vh] overflow-auto rounded-md border bg-card", className)}>
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <caption className="sr-only">Changed lines</caption>
          <tbody>
            {rows.map((row, i) =>
              row.kind === "skip" ? (
                <tr key={i}>
                  <td colSpan={4} className="bg-muted/60 px-3 py-1 text-center text-muted-foreground">
                    … {row.count} unchanged {row.count === 1 ? "line" : "lines"}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={ROW_STYLE[row.kind]}>
                  <td className="w-10 min-w-10 select-none px-2 text-right align-top text-muted-foreground tabular-nums">{row.oldNo}</td>
                  <td className="w-10 min-w-10 select-none border-r px-2 text-right align-top text-muted-foreground tabular-nums">{row.newNo}</td>
                  <td className={cn("w-5 select-none px-1 text-center align-top", MARKER[row.kind].className)}>
                    <span aria-hidden>{MARKER[row.kind].symbol}</span>
                  </td>
                  <td className="whitespace-pre-wrap break-all px-2 align-top">
                    <span className="sr-only">{MARKER[row.kind].label}</span>
                    {row.text}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
