import type { ReactNode } from "react";
import { CodeBlock } from "@/components/servers/install-outcome";
import { INSTALL_DIR, INSTALL_WITH_DOMAIN } from "@/lib/public-url-help-core";

/**
 * What to do when the dashboard has no https address (`KEELSON_PUBLIC_URL`): why a feature needs one, the two ways to
 * give it one (the installer's `--domain`, or the operator's own proxy and `dashboard.env`), and what still works without.
 */
export function PublicUrlHelp({ why, without }: { why: ReactNode; without?: ReactNode }) {
  return (
    <div className="space-y-3 text-sm">
      <p>{why}</p>
      <div className="space-y-1.5">
        <p className="font-medium">With the install script</p>
        <p>
          Point a DNS name at this machine (ports 80 and 443 open), then run the installer again with it. It keeps your data and puts Caddy in front, which gets the certificate:
        </p>
        {/* w-0 min-w-full: the long command scrolls inside its block instead of widening the notice's grid track */}
        <div className="w-0 min-w-full">
          <CodeBlock value={INSTALL_WITH_DOMAIN} label="Copy the command" />
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="font-medium">Or behind your own https proxy</p>
        <p>
          Add <code className="font-mono text-xs">KEELSON_PUBLIC_URL=https://keelson.example.com</code> to <code className="font-mono text-xs">{INSTALL_DIR}/dashboard.env</code>, then run{" "}
          <code className="font-mono text-xs">docker compose up -d</code> in <code className="font-mono text-xs">{INSTALL_DIR}</code>.
        </p>
      </div>
      {without !== undefined && <p className="text-muted-foreground">{without}</p>}
    </div>
  );
}
