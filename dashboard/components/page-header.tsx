import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ShellOwner } from "@/components/shell/shell-owner";
import { projectOfCrumbs } from "@/lib/nav-core";

export interface Crumb {
  label: string;
  href?: string;
}

/** Title block of a page: breadcrumb, title with an optional status, description, and the page's actions. */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  status,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const owner = projectOfCrumbs(breadcrumbs);
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        {owner !== null && <ShellOwner project={owner} />}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              {breadcrumbs.map((c, i) => (
                <li key={`${i}-${c.label}`} className="flex items-center gap-1">
                  {i > 0 && <ChevronRightIcon aria-hidden className="size-3.5" />}
                  {c.href ? (
                    <Link href={c.href} className="rounded-sm hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none">
                      {c.label}
                    </Link>
                  ) : (
                    <span>{c.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate font-display text-[1.75rem] leading-tight font-semibold tracking-tight">{title}</h1>
          {status}
        </div>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
