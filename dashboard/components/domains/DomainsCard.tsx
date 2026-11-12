"use client";

import { ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { checkDomainAction, ensureDnsAction, type DnsActionResult } from "@/app/domain-actions";
import { CheckboxField, SegmentedControl } from "@/components/forms/fields";
import { PROXIED_HELP } from "@/components/domains/DnsPlan";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StepUpAction } from "@/components/unlock";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { POLL_LIMIT_MS, checks, pollDelay, type Check, type DomainStatus, type HostEntry } from "@/lib/domain-status-core";
import { domainCheckStatus } from "@/lib/status";

const CHECKS = [
  { key: "dns", label: "DNS", question: "Does the name lead to the server?" },
  { key: "proxy", label: "Proxy", question: "Does the proxy route the name?" },
  { key: "https", label: "HTTPS", question: "Does the server answer with a valid certificate?" },
] as const;

function CheckLine({ label, question, check }: { label: string; question: string; check: Check | null }) {
  return (
    <li className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3" data-check={label.toLowerCase()} data-state={check?.state ?? "loading"}>
      <div className="flex items-center gap-2">
        <span className="w-11 text-sm font-medium" title={question}>
          {label}
        </span>
        {check ? <StatusBadge view={check.warn ? { tone: "warning", label: "Expires soon" } : domainCheckStatus(check.state)} /> : <LoaderCircleIcon aria-label="Checking" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
      </div>
      <div className="min-w-0 text-sm">
        <p className="break-words">{check ? check.detail : "Checking…"}</p>
        {check?.next && <p className="break-words text-muted-foreground">{check.next}</p>}
      </div>
    </li>
  );
}

/** Creates the record at Cloudflare from the domain's row: the choice, and the confirmations the action asks for by name. */
function DnsDialog({ serverId, hostname, open, onOpenChange, onDone }: { serverId: string; hostname: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const id = useId();
  const [proxied, setProxied] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [answer, setAnswer] = useState<DnsActionResult | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    try {
      const out = await ensureDnsAction(serverId, hostname, {
        proxied,
        ...(allowPrivate ? { allowPrivate: true } : {}),
        ...(answer?.result.kind === "conflict" && confirmed ? { confirmReplace: answer.result.confirm } : {}),
      });
      if (out.result.kind === "created" || out.result.kind === "replaced" || out.result.kind === "exists") {
        toast.success(out.message);
        onOpenChange(false);
        setAnswer(null);
        setConfirmed(false);
        onDone();
        return;
      }
      setAnswer(out);
    } finally {
      setPending(false);
    }
  }

  const result = answer?.result;
  const blocked = result?.kind === "conflict" && !confirmed;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create the DNS record at Cloudflare</DialogTitle>
          <DialogDescription>
            Points <span className="font-mono">{hostname}</span> at this server. A record that already exists is never overwritten without your confirmation.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <SegmentedControl
            label="Through Cloudflare"
            value={proxied ? "proxied" : "dns"}
            onChange={(v) => setProxied(v === "proxied")}
            options={[
              { value: "proxied", label: "Proxied" },
              { value: "dns", label: "DNS only" },
            ]}
          />
          <p className="text-xs text-muted-foreground">{PROXIED_HELP[proxied ? "proxied" : "dns"]}</p>
          {result && result.kind !== "created" && result.kind !== "replaced" && result.kind !== "exists" && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive">
                {answer?.message}
              </p>
              <StepUpAction error={answer?.message} />
            </div>
          )}
          {result?.kind === "conflict" && <CheckboxField id={`${id}-replace`} label={`Replace ${result.confirm} with the new record`} checked={confirmed} onChange={setConfirmed} />}
          {result?.kind === "private" && <CheckboxField id={`${id}-private`} label={`Use ${result.ip} anyway (a private network or split-horizon DNS)`} checked={allowPrivate} onChange={setAllowPrivate} />}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={submit} loading={pending} disabled={blocked || (result?.kind === "private" && !allowPrivate)}>
            {result?.kind === "conflict" ? "Replace the record" : "Create the record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One host name with its three live checks. It checks when it appears, again every few seconds while a check is pending
 * (the wait grows, and it stops after ten minutes or when nothing is pending), and on demand.
 */
function DomainRow({ serverId, entry, cloudflare }: { serverId: string; entry: HostEntry; cloudflare: boolean }) {
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A check is asked for by raising `request` and answered by setting `answered` to it: the page checks when it appears,
  // when the poll timer fires and when Re-check is pressed, and never calls setState from an effect's own body.
  const [request, setRequest] = useState(0);
  const [answered, setAnswered] = useState(-1);
  // `epoch` starts a polling run (the page appearing, or Re-check); `stopped` is set when ten minutes of it passed.
  const [epoch, setEpoch] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [dialog, setDialog] = useState(false);
  const since = useRef(0);
  const hostname = entry.hostname;
  const checking = answered < request;

  useEffect(() => {
    let live = true;
    checkDomainAction(serverId, hostname)
      .then((out) => {
        if (!live) return;
        if (out.ok) {
          setStatus(out.status);
          setError(null);
        } else {
          setError(out.error);
        }
      })
      .catch(() => live && setError("The check could not be run: is the dashboard reachable?"))
      .finally(() => live && setAnswered(request));
    return () => {
      live = false;
    };
  }, [request, serverId, hostname]);

  useEffect(() => {
    since.current = Date.now();
    const timer = setTimeout(() => setStopped(true), POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [epoch]);

  useEffect(() => {
    if (checking) return;
    const delay = pollDelay(Date.now() - since.current, status);
    if (delay === null) return;
    const timer = setTimeout(() => setRequest((r) => r + 1), delay);
    return () => clearTimeout(timer);
  }, [checking, status]);

  const recheck = () => {
    setStopped(false);
    setEpoch((e) => e + 1);
    setRequest((r) => r + 1);
  };
  const offerDns = cloudflare && status !== null && status.expected !== null && (status.dns.state === "pending" || status.dns.state === "failed");

  return (
    <li className="grid gap-3 py-4 first:pt-0 last:pb-0" data-domain={hostname}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ICONS.domain aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="break-all font-mono text-sm font-medium">{hostname}</span>
          <span className="text-xs text-muted-foreground">{entry.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {offerDns && (
            <Button type="button" variant="outline" size="sm" onClick={() => setDialog(true)}>
              Create the DNS record
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={recheck} loading={checking}>
            <RefreshCwIcon />
            Re-check
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="grid gap-3">
        {CHECKS.map((c) => (
          <CheckLine key={c.key} label={c.label} question={c.question} check={status ? status[c.key] : null} />
        ))}
      </ul>
      {status?.cloudflare === "error" && <p className="text-xs text-muted-foreground">Cloudflare could not be read: {status.cloudflareError}</p>}
      {status?.cloudflare === "off" && status.dns.state !== "ok" && (
        <p className="text-xs text-muted-foreground">
          <Link href="/settings/integrations" className="font-medium text-foreground underline-offset-4 hover:underline">
            Connect Cloudflare
          </Link>{" "}
          to have the record created and compared for you.
        </p>
      )}
      {stopped && status !== null && checks(status).some((c) => c.state === "pending") && <p className="text-xs text-muted-foreground">Automatic checks stopped after ten minutes. Press Re-check to look again.</p>}
      {status && (
        <p className="text-xs text-muted-foreground">
          Checked <RelativeTime at={status.checkedAt} />
          {status.expected && (
            <>
              {" "}
              · server address <span className="font-mono">{status.expected.ip}</span>
            </>
          )}
          {" · "}
          <a href={`https://${hostname}/`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
            Open <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </p>
      )}
      {cloudflare && <DnsDialog serverId={serverId} hostname={hostname} open={dialog} onOpenChange={setDialog} onDone={recheck} />}
    </li>
  );
}

/** The domains an app or the whole proxy serves, each with its live DNS, proxy and HTTPS checks. */
export function DomainsCard({ serverId, hosts, cloudflare, title = "Domains" }: { serverId: string; hosts: HostEntry[]; cloudflare: boolean; title?: string }) {
  if (hosts.length === 0) return null;
  return (
    <Card data-testid="domains-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          Is each name working? The name must lead to this server, the proxy must route it, and the server must answer with a certificate a browser accepts. Only the names the agent
          declares are checked, always against this server&apos;s own address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {hosts.map((h) => (
            <DomainRow key={h.hostname} serverId={serverId} entry={h} cloudflare={cloudflare} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
