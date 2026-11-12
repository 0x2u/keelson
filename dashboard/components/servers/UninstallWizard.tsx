"use client";

import { CircleCheckIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteServerAction } from "@/app/actions";
import { hostFingerprintAction, type FieldErrors, type InstallValues } from "@/app/server-install-actions";
import { previewUninstallAction, uninstallAgentAction, type UninstallPreview, type UninstallResult } from "@/app/server-uninstall-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CheckboxField, FieldShell, SegmentedControl } from "@/components/forms/fields";
import { HostKeyConfirm } from "@/components/servers/HostKeyConfirm";
import { SshLoginFields } from "@/components/servers/SshLoginFields";
import { Notice } from "@/components/states";
import { toastActionError } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toastCopy } from "@/lib/toast-core";
import type { UninstallReport } from "@/lib/ssh-install-core";

type Step = "connect" | "confirm" | "review" | "done";
type Preview = Extract<UninstallPreview, { ok: true }>;

const EMPTY: InstallValues = {
  host: "",
  port: "22",
  username: "root",
  authKind: "key",
  privateKey: "",
  passphrase: "",
  password: "",
  sudoPassword: "",
  name: "",
  agentPort: "7443",
  nginx: false,
  openFirewall: true,
};

function Lines({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((line) => (
        <li key={line} className="break-words">
          {line}
        </li>
      ))}
    </ul>
  );
}

/** The containers an uninstall leaves running: said before and after, because it is what the operator cares about. */
function ContainersNotice({ containers, past }: { containers: string[]; past: boolean }) {
  if (containers.length === 0) return null;
  return (
    <Notice tone="info" title={`${containers.length} container${containers.length === 1 ? "" : "s"} of your apps ${past ? "keep" : "will keep"} running`}>
      <span className="block">The agent only manages them: they are not stopped or removed, and the sites they serve stay up. Nothing deploys or restarts them any more.</span>
      <ul className="mt-2 space-y-0.5 font-mono text-xs">
        {containers.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </Notice>
  );
}

function Outcome({ report, forget, stillAnswering, serverId, serverName }: { report: UninstallReport; forget: boolean; stillAnswering: boolean; serverId: string; serverName: string }) {
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CircleCheckIcon aria-hidden className="size-6 text-success" />
          <CardTitle role="status">{report.installed ? "The agent was removed" : "There was no agent on this server"}</CardTitle>
        </div>
        <CardDescription>
          {forget
            ? `Last step: remove ${serverName} from this dashboard, which has nothing left to talk to.`
            : "The server is still registered here and will show as unreachable. Remove it from its settings when you are done."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {stillAnswering && (
          <Notice tone="warning" title="Something still answers at the agent's address">
            The agent was removed, but a program still replies on that address. Check what listens on the agent&apos;s port, for example with <code className="font-mono text-xs">ss -ltnp</code>.
          </Notice>
        )}
        {report.problems.length > 0 && (
          <Notice title="Some steps failed">
            The agent is stopped and removed, but: <span className="mt-1 block">{report.problems.join(" · ")}</span>
          </Notice>
        )}
        <ContainersNotice containers={report.containers} past />
        {report.removed.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Removed</p>
            <Lines items={report.removed} empty="" />
          </div>
        )}
        {report.kept.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Left in place</p>
            <Lines items={report.kept} empty="" />
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {forget ? (
          <Button
            type="button"
            loading={pending}
            onClick={() =>
              start(async () => {
                const refused = await deleteServerAction(serverId);
                if (refused?.error) {
                  toastActionError(toastCopy.failed("removed", serverName), refused.error);
                  return;
                }
                toast.success(toastCopy.removed(serverName));
              })
            }
          >
            Remove {serverName} from the dashboard
          </Button>
        ) : (
          <Button asChild>
            <Link href={`/servers/${serverId}/settings`}>Open the server&apos;s settings</Link>
          </Button>
        )}
        {forget && (
          <Button asChild variant="outline">
            <Link href={`/servers/${serverId}/settings`}>Keep it for now</Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/**
 * Removes the agent from a server over SSH: log in once, confirm the host key, see what would be removed and what would stay,
 * choose, confirm by typing the server's name. The login is used for these calls only and never stored.
 */
export function UninstallWizard({ serverId, serverName, host }: { serverId: string; serverName: string; host: string }) {
  const [values, setValues] = useState<InstallValues>({ ...EMPTY, host });
  const [step, setStep] = useState<Step>("connect");
  const [fingerprint, setFingerprint] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [purge, setPurge] = useState(false);
  const [purgeOperatorFiles, setPurgeOperatorFiles] = useState(false);
  const [forget, setForget] = useState(true);
  const [force, setForce] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [done, setDone] = useState<Extract<UninstallResult, { ok: true }> | null>(null);
  const [pending, start] = useTransition();

  const forgetLogin = () => setValues((v) => ({ ...v, privateKey: "", passphrase: "", password: "", sudoPassword: "" }));

  function check() {
    setProblem(null);
    const local: FieldErrors = {};
    if (values.host.trim() === "") local.host = "Enter the server's address.";
    if (values.authKind === "key" && values.privateKey.trim() === "") local.privateKey = "Paste a private key.";
    if (values.authKind === "password" && values.password === "") local.password = "Enter the password.";
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    start(async () => {
      const r = await hostFingerprintAction(values.host, values.port);
      if (!r.ok) {
        setErrors(r.errors ?? {});
        setProblem(r.message);
        return;
      }
      setFingerprint(r.fingerprint);
      setStep("confirm");
    });
  }

  function look() {
    setProblem(null);
    start(async () => {
      const r = await previewUninstallAction(serverId, values, fingerprint);
      if (!r.ok) {
        setErrors(r.errors ?? {});
        setProblem(r.message);
        setStep(r.errors || r.stage === "auth" || r.stage === "connect" || r.stage === "sudo" || r.stage === "hostkey" ? "connect" : "confirm");
        return;
      }
      setPreview(r);
      setBusy(r.busy);
      setStep("review");
    });
  }

  function remove() {
    setProblem(null);
    setRemoveError(null);
    start(async () => {
      const r = await uninstallAgentAction(serverId, values, fingerprint, { purge, force, purgeOperatorFiles: purge && purgeOperatorFiles });
      if (!r.ok) {
        // The confirmation is open: the failure is shown inside it.
        setRemoveError(r.message);
        setBusy(r.busy ?? []);
        return;
      }
      forgetLogin();
      setRemoveOpen(false);
      setDone(r);
      setStep("done");
    });
  }

  if (step === "done" && done) return <Outcome report={done.report} forget={forget} stillAnswering={done.stillAnswering} serverId={serverId} serverName={serverName} />;

  const report = preview ? (purge ? preview.purge : preview.keep) : null;
  const canRemove = busy.length === 0 || force;

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle>
          {step === "connect" && "Log in to remove the agent"}
          {step === "confirm" && "Is this your server?"}
          {step === "review" && "What will happen"}
        </CardTitle>
        <CardDescription>
          {step === "connect" && "Keelson logs in over SSH once, removes the agent, and forgets the login. Your apps' containers are not touched."}
          {step === "confirm" && "Nothing has been sent to the server yet: only its public host key was read."}
          {step === "review" && "Nothing has been changed yet."}
        </CardDescription>
      </CardHeader>

      {step === "connect" && (
        <>
          <CardContent className="space-y-6">
            {problem && <Notice title="Could not reach the server">{problem}</Notice>}
            <SshLoginFields values={values} errors={errors} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} purpose="this uninstall" />
          </CardContent>
          <CardFooter className="justify-end">
            <Button type="button" onClick={check} loading={pending}>
              <ICONS.secret />
              Check the server
            </Button>
          </CardFooter>
        </>
      )}

      {step === "confirm" && (
        <>
          <CardContent className="space-y-4">
            {problem && <Notice title="Could not look at the server">{problem}</Notice>}
            <HostKeyConfirm host={values.host} port={values.port} fingerprint={fingerprint} />
          </CardContent>
          <CardFooter className="justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setStep("connect")} disabled={pending}>
              Back
            </Button>
            <Button type="button" onClick={look} loading={pending}>
              <ICONS.security />
              This is my server, show what would be removed
            </Button>
          </CardFooter>
        </>
      )}

      {step === "review" && preview && report && (
        <>
          <CardContent className="space-y-6">
            {problem && <Notice title={busy.length > 0 ? "The agent is busy" : "The agent was not removed"}>{problem}</Notice>}
            {!report.installed ? (
              <Notice tone="info" title="No agent found on this server">
                Nothing of Keelson&apos;s is installed there (or it was removed already). You can still remove the server from this dashboard.
              </Notice>
            ) : (
              <>
                <ContainersNotice containers={report.containers} past={false} />
                {!preview.agentReachable && report.service && (
                  <Notice tone="warning" title="The agent does not answer">
                    This dashboard cannot ask it whether a deployment is running. If one was started a moment ago, removing the agent now would interrupt it.
                  </Notice>
                )}
                {busy.length > 0 && (
                  <Notice tone="warning" title="The agent is busy right now">
                    {busy.join(", ")}. Stopping the agent would interrupt {busy.length === 1 ? "it" : "them"}: a deployment can be left half done. Wait for it to finish.
                    <div className="mt-3">
                      <CheckboxField id="force" label="Uninstall anyway" checked={force} onChange={setForce} />
                    </div>
                  </Notice>
                )}

                <FieldShell id="uninstall-mode" label="How much to remove" group>
                  <SegmentedControl
                    label="How much to remove"
                    value={purge ? "all" : "agent"}
                    options={[
                      { value: "agent", label: "The agent only" },
                      { value: "all", label: "Everything Keelson installed" },
                    ]}
                    onChange={(v) => setPurge(v === "all")}
                  />
                </FieldShell>
                <p className="text-sm text-muted-foreground">
                  {purge
                    ? "Also deletes the apps file, secrets, certificates, history, the firewall rule and the account. A new install starts from nothing."
                    : "Keeps the apps file, secrets, certificates and history, so that installing the agent again picks up where this one stopped."}
                </p>
                {purge && (
                  <CheckboxField
                    id="purge-operator-files"
                    label="Also delete the files I added to /etc/keelson (listed under Stays: database passwords, tokens)"
                    checked={purgeOperatorFiles}
                    onChange={setPurgeOperatorFiles}
                  />
                )}

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Will be removed</p>
                    <Lines items={report.removed} empty="Nothing." />
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Stays</p>
                    <Lines items={report.kept} empty="Nothing is left behind." />
                  </div>
                </div>

                <CheckboxField
                  id="forget"
                  label="Then remove this server from the dashboard"
                  checked={forget}
                  onChange={setForget}
                  help="Without the agent there is nothing for the dashboard to talk to. It is the last step, after you have read what was done."
                />
              </>
            )}
          </CardContent>
          <CardFooter className="justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setStep("confirm")} disabled={pending}>
              Back
            </Button>
            {report.installed ? (
              <ConfirmDialog
                open={removeOpen}
                onOpenChange={(next) => {
                  if (next) setRemoveError(null);
                  setRemoveOpen(next);
                }}
                trigger={
                  <Button type="button" variant="destructive" disabled={!canRemove || pending}>
                    <ICONS.remove />
                    Remove the agent
                  </Button>
                }
                title={`Remove the agent from ${serverName}?`}
                description={
                  purge
                    ? "Stops the agent and deletes everything Keelson installed on the server: the apps file, secrets, certificates, history, the firewall rule and the account. A new install starts from nothing. Your apps' containers are not touched."
                    : "Stops and removes the agent. The apps file, secrets, certificates and history stay, so installing the agent again picks up where this one stopped. Your apps' containers are not touched."
                }
                confirmLabel="Remove the agent"
                destructive
                typeToConfirm={serverName}
                pending={pending}
                error={removeError}
                onConfirm={remove}
              />
            ) : (
              <Button asChild variant="outline">
                <Link href={`/servers/${serverId}/settings`}>Back to the settings</Link>
              </Button>
            )}
          </CardFooter>
        </>
      )}
    </Card>
  );
}
