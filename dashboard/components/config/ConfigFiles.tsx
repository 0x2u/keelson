import { InlineLink, TableCard } from "@/components/layout";
import { RelativeTime } from "@/components/relative-time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ConfigFileRow } from "@/lib/project-config-core";

/**
 * The files the server's configuration is made of: the apps file and one file per project that has its own. The editor
 * below shows the apps file; each project file is edited from the Configuration tab of its project.
 */
export function ConfigFiles({ rows }: { rows: ConfigFileRow[] }) {
  return (
    <section aria-label="Configuration files" className="space-y-2" data-testid="config-files">
      <p className="text-sm text-muted-foreground">
        This server&apos;s configuration is made of {rows.length} files. The editor below is the shared file (server-wide settings and what no project file
        holds); a project&apos;s own file is edited from its Configuration tab. Versions and the base hash of every save cover all of them.
      </p>
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Project</TableHead>
              <TableHead className="hidden sm:table-cell">Hash</TableHead>
              <TableHead>Last changed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.path}>
                <TableCell className="font-mono text-xs whitespace-normal break-all">{row.path}</TableCell>
                <TableCell className="whitespace-normal">
                  {row.href ? (
                    <InlineLink href={row.href} aria-label={`Edit ${row.project} in its Configuration tab`}>
                      {row.project}
                    </InlineLink>
                  ) : (
                    <span className="text-muted-foreground">Server-wide</span>
                  )}
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell" title={row.hash}>
                  {row.shortHash}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <RelativeTime at={row.modifiedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>
    </section>
  );
}
