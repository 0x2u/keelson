"use client";

import { CopyButton } from "@/components/copy-button";

/** The server's SSH host key fingerprint, for the operator to compare with the server's own before any login is sent. */
export function HostKeyConfirm({ host, port, fingerprint }: { host: string; port: string; fingerprint: string }) {
  return (
    <>
      <p className="text-sm">
        <span className="text-muted-foreground">Server</span> <span className="font-mono">{host}</span>
        {port !== "22" && <span className="font-mono">:{port}</span>}
      </p>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">SSH host key fingerprint</p>
        <div className="flex items-center gap-1 rounded-md border bg-muted px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-sm">{fingerprint}</code>
          <CopyButton value={fingerprint} label="Copy the fingerprint" />
        </div>
      </div>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Compare it with the server&apos;s own: run <code className="font-mono text-xs">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on it, or
          look in your provider&apos;s console. If they match, you are talking to your server and not to someone in between.
        </p>
        <p>If you cannot check, this is the same trust as the first time you run ssh to a new machine.</p>
      </div>
    </>
  );
}
