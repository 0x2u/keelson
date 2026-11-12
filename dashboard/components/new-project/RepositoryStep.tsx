"use client";

import { CheckIcon, LockIcon, SearchIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PickableRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** The repositories the GitHub App can reach, searchable; a click selects one (nothing is selected to begin with). */
export function RepositoryStep({ repos, selected, onSelect }: { repos: PickableRepo[]; selected: string; onSelect: (repo: PickableRepo) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? repos : repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" className="pl-9" autoComplete="off" />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{repos.length === 0 ? "The GitHub App is not installed on any repository yet." : "No repository matches."}</p>
      ) : (
        <ul role="radiogroup" aria-label="Repository" className="divide-y rounded-md border bg-card">
          {shown.map((r) => {
            const on = r.fullName === selected;
            return (
              <li key={r.fullName}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  id={`${id}-${r.fullName}`}
                  onClick={() => onSelect(r)}
                  className={cn("flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", on && "bg-accent")}
                >
                  <span className="font-medium">{r.fullName}</span>
                  {r.private && (
                    <Badge variant="muted">
                      <LockIcon aria-hidden />
                      Private
                    </Badge>
                  )}
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <ICONS.source aria-hidden className="size-3.5" />
                    {r.defaultBranch}
                    {on && <CheckIcon aria-hidden className="size-4 text-foreground" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
