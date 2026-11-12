import { ContainerBadge } from "@/components/status";
import { ImageRef } from "@/components/image-ref";
import { InlineLink, TableCard } from "@/components/layout";
import { EmptyState, Notice } from "@/components/states";
import { ICONS } from "@/lib/icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Container } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { healthFromStatus, publishedPorts } from "@/lib/format";


/**
 * Every container of a server. State and published ports stay visible on a phone, below the name, so nothing needs a
 * sideways scroll to tell whether a container is up and where it listens.
 */
export function ContainersCard({ serverId, containers }: { serverId: string; containers: Loaded<Container[]> }) {
  if (containers.error !== undefined) {
    return (
      <Notice title="Containers could not be listed">
        {containers.error}. Check that the agent is running and that Docker answers on the server.{" "}
        <InlineLink href={`/servers/${serverId}/settings`}>Open settings</InlineLink>
      </Notice>
    );
  }
  const list = containers.data;
  return (
    <TableCard title="Containers">
        {list.length === 0 ? (
          <EmptyState icon={ICONS.container} title="No containers yet">
            Containers started by deployments, or by anything else on this Docker host, are listed here.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Image</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden lg:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Ports</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((c) => {
                const ports = publishedPorts(c.ports);
                const app = c.labels["keelson.app"];
                return (
                  <TableRow key={c.id}>
                    <TableCell className="w-full max-w-0 md:w-auto md:max-w-none">
                      <InlineLink href={`/servers/${serverId}/containers/${encodeURIComponent(c.name)}`} className="block truncate md:inline">
                        {c.name}
                      </InlineLink>
                      {app && <span className="ml-2 hidden text-xs text-muted-foreground md:inline">{app}</span>}
                      <p className="truncate font-mono text-xs text-muted-foreground md:hidden" data-testid="container-ports-compact">
                        {ports || "no published port"}
                        {app && <span className="font-sans"> · {app}</span>}
                      </p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <ImageRef value={c.image} className="max-w-64" />
                    </TableCell>
                    <TableCell>
                      <ContainerBadge state={c.state} health={healthFromStatus(c.status)} />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{c.status}</TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">{ports || "–"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
    </TableCard>
  );
}
