"use client";

import { ChevronRightIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { applyNotificationsDefaultAction } from "@/app/notifications-actions";
import { DiffView } from "@/components/config/DiffView";
import { IssuesList } from "@/components/config/IssuesList";
import { FieldShell } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StepUpAction } from "@/components/unlock";
import { isStepUpError } from "@/lib/gate-core";
import type { ApplyOutcome, ApplyResult } from "@/lib/notifications-apply-core";
import { channelLabel, DIFFERENCE_LABEL, webhookUrlProblem, type NotificationsTemplate } from "@/lib/notifications-core";
import { planApply, planCounts, type NotificationsRow, type PlanItem } from "@/lib/notifications-fleet-core";

type Variant = "success" | "warning" | "danger" | "muted";

/** What the report says about one server's outcome: a badge, and the detail that explains it. */
function describeOutcome(o: ApplyOutcome): { variant: Variant; label: string; detail?: string } {
  switch (o.status) {
    case "applied":
      return { variant: "success", label: "Applied", detail: o.version === undefined ? undefined : `Saved as version ${o.version} of its configuration.` };
    case "unchanged":
      return { variant: "muted", label: "Already followed it", detail: "Nothing was written." };
    case "conflict":
      return { variant: "warning", label: "Changed since you looked", detail: "Its file was changed after this page was loaded, so nothing was written. Reload and apply again to this server." };
    case "refused":
      return {
        variant: "danger",
        label: o.kind === "invalid" ? "Refused by the agent" : o.kind === "busy" ? "Agent busy" : o.kind === "needs_acknowledgement" ? "Needs confirmation" : "Failed",
        detail:
          o.kind === "needs_acknowledgement"
            ? "The agent asks you to confirm warnings, which a batch does not do. Open this server's form to review them."
            : o.kind === "busy"
              ? (o.message ?? "The agent is applying another change. Try again in a moment.")
              : o.issues.length === 0
                ? o.message
                : undefined,
      };
    case "needs-url":
      return { variant: "warning", label: "Needs a URL", detail: `It has no webhook ${o.slot}: type its URL and apply again.` };
    case "read-only":
      return { variant: "muted", label: "Read-only", detail: o.reason };
    case "unreachable":
      return { variant: "danger", label: "Unreachable", detail: o.reason };
  }
}

/** A server that needs a URL is waiting for the operator, not broken: only an unreachable or read-only one is red. */
const planBadge = (item: PlanItem): Variant => (item.kind === "change" ? "warning" : item.kind === "same" ? "muted" : item.why === "needs-url" ? "warning" : "danger");

function PlanRow({ item }: { item: PlanItem }) {
  const [open, setOpen] = useState(false);
  const label = item.kind === "change" ? `Will change: ${item.changes.map((c) => DIFFERENCE_LABEL[c]).join(", ")}` : item.kind === "same" ? "Already follows it" : item.detail;
  return (
    <li className="space-y-2 px-3 py-2" data-server={item.id} data-plan={item.kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {item.kind === "change" ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 items-center gap-1 rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRightIcon aria-hidden className={open ? "size-4 shrink-0 rotate-90 transition-transform" : "size-4 shrink-0 transition-transform"} />
            <span className="truncate">{item.name}</span>
          </button>
        ) : (
          <span className="min-w-0 truncate font-medium">{item.name}</span>
        )}
        <Badge variant={planBadge(item)} className="max-w-full">
          <span className="truncate">{label}</span>
        </Badge>
      </div>
      {open && item.kind === "change" && <DiffView before={item.before} after={item.after} identical="Nothing differs in what is written." />}
    </li>
  );
}

/**
 * The last look before the default goes to the chosen servers: what would change on each (a diff of its notifications section),
 * the webhook URLs the channels need (typed once; write-only: held in this page until the request, sent to the agents that get
 * them, never stored, shown again or logged), and then what became of every server. Each save is the agent's own, signed and
 * versioned; a server whose file moved since the page loaded is reported, not forced.
 */
export function ApplyDialog({ template, rows, onClose }: { template: NotificationsTemplate; rows: NotificationsRow[]; /** `ran`: the batch was applied (whatever became of each server), so the choice of servers is spent. */ onClose: (ran: boolean) => void }) {
  const router = useRouter();
  const base = useId();
  const [urls, setUrls] = useState<string[]>(() => template.webhooks.map(() => ""));
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [report, setReport] = useState<Extract<ApplyResult, { ok: true }> | null>(null);

  const plan = useMemo(() => planApply(template, rows, urls.map((u) => u.trim() !== "")), [template, rows, urls]);
  const counts = planCounts(plan);
  const urlProblems = urls.map((u) => webhookUrlProblem(u));
  const names = new Map(rows.map((r) => [r.id, r.name]));

  async function apply() {
    setPending(true);
    setRefusal(null);
    try {
      const result = await applyNotificationsDefaultAction(
        rows.map((r) => ({ id: r.id, baseHash: r.hash ?? "" })),
        urls.map((u) => u.trim()),
      );
      if (result.ok) {
        setReport(result);
        setUrls(urls.map(() => ""));
        router.refresh();
      } else {
        setRefusal(result.message);
      }
    } catch {
      setRefusal("The request failed before the dashboard answered. Check the connection: some servers may have been changed, so reload the page to see where each one stands.");
    } finally {
      setPending(false);
    }
  }

  function close(next: boolean) {
    if (!next && !pending) onClose(report !== null);
  }

  const applied = report?.results.filter((r) => r.outcome.status === "applied").length ?? 0;
  const settled = report === null ? null : report.results.length;

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="apply-dialog">
        <DialogHeader>
          <DialogTitle>{report === null ? `Apply the default to ${rows.length} ${rows.length === 1 ? "server" : "servers"}` : "Result"}</DialogTitle>
          <DialogDescription>
            {report === null
              ? "Each server's file is changed through its own agent, which validates it and keeps the previous version. A server that fails does not stop the others."
              : `${applied} of ${settled} applied.`}
          </DialogDescription>
        </DialogHeader>

        {report === null ? (
          <div className="space-y-5">
            {refusal !== null && (
              <Notice title="Nothing was written">
                <div className="space-y-2">
                  <p>{refusal}</p>
                  {isStepUpError(refusal) && <StepUpAction error={refusal} />}
                </div>
              </Notice>
            )}

            {template.webhooks.length > 0 && (
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Webhook URLs</p>
                  <p className="text-xs text-muted-foreground">
                    Secrets: held by this page until you apply, sent to the agents and never shown again. Leave a URL empty to keep the one each server already has; a server with none at
                    that position is not applied to.
                  </p>
                </div>
                {template.webhooks.map((slot, i) => (
                  <FieldShell
                    key={i}
                    id={`${base}-url-${i}`}
                    label={`Webhook ${i + 1} URL`}
                    optional
                    help={slot.secretFile ? <>Signed with the file <span className="font-mono">{slot.secretFile}</span> on each server.</> : "Not signed."}
                    error={urlProblems[i]}
                  >
                    <Input
                      id={`${base}-url-${i}`}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={urls[i]}
                      aria-invalid={urlProblems[i] ? true : undefined}
                      aria-describedby={`${base}-url-${i}-help${urlProblems[i] ? ` ${base}-url-${i}-error` : ""}`}
                      onChange={(e) => setUrls(urls.map((u, j) => (j === i ? e.target.value : u)))}
                      placeholder="https://hooks.example.com/…"
                    />
                  </FieldShell>
                ))}
              </div>
            )}

            {(template.telegram !== null || template.webhooks.some((w) => w.secretFile !== "")) && (
              <p className="text-xs text-muted-foreground">
                The bot token and the signing secrets are files on each server: this never reads or writes them. They must already exist at the paths of the default.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="apply-counts">
              <Badge variant="warning">{counts.change} will change</Badge>
              <Badge variant="muted">{counts.same} already follow it</Badge>
              {counts.blocked > 0 && <Badge variant="danger">{counts.blocked} cannot be applied</Badge>}
              <span className="text-xs text-muted-foreground">The default expects {channelLabel({ telegram: template.telegram !== null, webhooks: template.webhooks.length, heartbeat: false })}.</span>
            </div>

            <ul className="divide-y rounded-lg border text-sm" data-testid="apply-plan">
              {plan.map((item) => (
                <PlanRow key={item.id} item={item} />
              ))}
            </ul>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border text-sm" data-testid="apply-report">
            {report.results.map(({ id, outcome }) => {
              const d = describeOutcome(outcome);
              const issues = outcome.status === "refused" ? outcome.issues : outcome.status === "applied" ? outcome.warnings : [];
              return (
                <li key={id} className="space-y-2 px-3 py-2" data-server={id} data-outcome={outcome.status}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 truncate font-medium">{names.get(id) ?? id}</span>
                    <Badge variant={d.variant}>{d.label}</Badge>
                  </div>
                  {d.detail && <p className="text-xs text-muted-foreground">{d.detail}</p>}
                  {issues.length > 0 && <IssuesList issues={issues} />}
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          {report === null ? (
            <>
              <Button type="button" variant="outline" disabled={pending} onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="button" loading={pending} disabled={urlProblems.some((p) => p !== undefined)} onClick={() => void apply()}>
                Apply the default to {rows.length} {rows.length === 1 ? "server" : "servers"}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => close(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
