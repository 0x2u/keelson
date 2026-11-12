import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { CheckboxField, SegmentedControl } from "@/components/forms/fields";
import { CopyButton } from "@/components/copy-button";
import { Notice } from "@/components/states";
import type { DnsPlan as Plan } from "@/lib/dns-record-core";

export const PROXIED_HELP: Record<"proxied" | "dns", string> = {
  proxied: "Cloudflare answers for the name: the server's address stays hidden, and Caddy still gets its certificate (HTTP-01 works through the proxy).",
  dns: "The name leads straight to the server, so anyone who looks it up learns its address.",
};

/** The exact values of a record to create by hand. */
export function ManualRecord({ record }: { record: { type: string; name: string; content: string } }) {
  const rows: [string, string][] = [
    ["Type", record.type],
    ["Name", record.name],
    ["Content", record.content],
  ];
  return (
    <dl className="grid gap-1 rounded-md border bg-background p-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-center gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all font-mono text-xs">{value}</dd>
          <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
        </div>
      ))}
    </dl>
  );
}

export interface DnsPlanProps {
  hostname: string;
  plan: Plan;
  /** Keelson creates the record (only offered when the plan is `cloudflare`). */
  create: boolean;
  onCreate: (value: boolean) => void;
  proxied: boolean;
  onProxied: (value: boolean) => void;
  allowPrivate: boolean;
  onAllowPrivate: (value: boolean) => void;
  /** Ids must be unique on the page. */
  idPrefix: string;
  /** Where the server's address comes from, and where to change it. */
  address?: { ip: string; source: string; settingsHref: string };
}

/** The address the domain will point at, where it comes from, and the way to change it. */
function AddressLine({ address }: { address: NonNullable<DnsPlanProps["address"]> }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="dns-plan-address">
      Server address: <span className="font-mono">{address.ip}</span> ({address.source}).{" "}
      <Link href={address.settingsHref} className="font-medium text-foreground underline-offset-4 hover:underline">
        Change it in the server&apos;s settings
      </Link>
      .
    </p>
  );
}

/**
 * What will happen to the domain's DNS when the app is added: created at Cloudflare (with the choice between proxied and DNS
 * only), or the exact record to create by hand when Cloudflare is not connected or does not hold the zone.
 */
export function DnsPlan({ hostname, plan, create, onCreate, proxied, onProxied, allowPrivate, onAllowPrivate, idPrefix, address }: DnsPlanProps) {
  if (plan.kind === "manual") {
    return (
      <div className="grid gap-3 rounded-lg border bg-muted/40 p-3" data-testid="dns-plan-manual">
        <p className="text-sm font-medium">Create this DNS record yourself</p>
        <p className="text-sm text-muted-foreground">{plan.message}</p>
        {plan.record && <ManualRecord record={plan.record} />}
        {plan.record && address && <AddressLine address={address} />}
        {plan.why === "not_connected" && (
          <p className="text-sm text-muted-foreground">
            Connect Cloudflare and Keelson creates it for you, and checks that it works.{" "}
            <Link href="/settings/integrations" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
              Connect Cloudflare <ExternalLinkIcon aria-hidden className="size-3" />
            </Link>
          </p>
        )}
        <p className="text-xs text-muted-foreground">Caddy gets the certificate by itself once the name leads to this server. The app&apos;s page shows when each step works.</p>
      </div>
    );
  }
  const line = `${plan.type} ${hostname} → ${plan.ip}, ${proxied ? "proxied" : "DNS only"}`;
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/40 p-3" data-testid="dns-plan-cloudflare">
      <CheckboxField
        id={`${idPrefix}-dns-create`}
        label={`Create the DNS record at Cloudflare (zone ${plan.zone})`}
        help="Nothing is overwritten: a record that already exists with another value is reported and replaced only if you confirm it by name."
        checked={create}
        onChange={onCreate}
      />
      {create ? (
        <>
          <p className="break-words font-mono text-xs" data-testid="dns-plan-line">
            Create {line}
          </p>
          {address && <AddressLine address={address} />}
          <div className="grid gap-1">
            <SegmentedControl
              label="Through Cloudflare"
              value={proxied ? "proxied" : "dns"}
              onChange={(v) => onProxied(v === "proxied")}
              options={[
                { value: "proxied", label: "Proxied" },
                { value: "dns", label: "DNS only" },
              ]}
            />
            <p className="text-xs text-muted-foreground">{PROXIED_HELP[proxied ? "proxied" : "dns"]}</p>
          </div>
          {plan.privateReason && (
            <Notice tone="warning" title="This server's address is not public">
              {plan.ip} is {plan.privateReason}: a public DNS record pointing at it would not reach the server from the internet. Set the server&apos;s public address in its settings, or
              confirm it for a private network or split-horizon setup.
              <div className="mt-2">
                <CheckboxField id={`${idPrefix}-dns-private`} label={`Use ${plan.ip} anyway`} checked={allowPrivate} onChange={onAllowPrivate} />
              </div>
            </Notice>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Create it yourself, with these values:</p>
          <ManualRecord record={{ type: plan.type, name: hostname, content: plan.ip }} />
        </>
      )}
    </div>
  );
}
