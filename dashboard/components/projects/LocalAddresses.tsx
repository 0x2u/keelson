import { ExternalLinkIcon } from "lucide-react";
import type { LocalAddress } from "@/lib/published-address-core";
import { cn } from "@/lib/utils";

/**
 * The ports an app without a domain publishes on its server, as addresses: a link when a browser can reach the host from
 * here, the plain address (with where it works) when it cannot, so that a published port is never "no address".
 */
export function LocalAddresses({ addresses, serverName, className }: { addresses: LocalAddress[]; serverName: string; className?: string }) {
  return (
    <ul className={cn("space-y-0.5", className)} data-testid="local-addresses">
      {addresses.map((a) => (
        <li key={`${a.loopback}:${a.port}`} className="flex flex-wrap items-baseline gap-x-2">
          {a.url !== null ? (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono text-sm underline-offset-4 hover:underline">
              <span className="truncate">{a.address}</span>
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
              <span className="sr-only">(opens the app)</span>
            </a>
          ) : (
            <span className="font-mono text-sm">{a.address}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {a.loopback && a.url === null ? `on ${serverName} only: reach it there or through an SSH tunnel` : a.url === null ? `port ${a.port} of ${serverName}` : "plain http, no domain"}
          </span>
        </li>
      ))}
    </ul>
  );
}
