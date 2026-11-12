import { InfoIcon } from "lucide-react";

/** What installing the agent changes on the server, said plainly before anything is sent. */
export function WhatThisDoes({ ssh }: { ssh?: boolean }) {
  return (
    <section aria-labelledby="what-this-does" className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
      <h3 id="what-this-does" className="flex items-center gap-2 font-medium">
        <InfoIcon aria-hidden className="size-4 text-info" />
        What this does
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground marker:text-muted-foreground/60">
        <li>Installs the Keelson agent binary and runs it as a systemd service.</li>
        <li>
          Creates an unprivileged <code className="font-mono text-xs">keelson</code> account that belongs to the docker group. Docker access is
          root-equivalent on the host, so treat anyone who controls this dashboard as having root on the server.
        </li>
        <li>Creates TLS certificates for mutual TLS between this dashboard and the agent.</li>
        <li>Optionally opens the agent port in the firewall for this dashboard&apos;s address, and optionally prepares nginx.</li>
      </ul>
      <p className="text-muted-foreground">
        To remove it later, run <code className="font-mono text-xs">sudo keelson-agent uninstall --purge</code> on the server.
        {ssh && " The SSH credentials are used for this one install and are never stored."}
      </p>
    </section>
  );
}
