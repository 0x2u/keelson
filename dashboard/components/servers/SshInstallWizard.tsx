"use client";

import { CheckIcon, CircleCheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { hostFingerprintAction, installOverSshAction, upgradeAgentOverSshAction, type FieldErrors, type InstallResult, type InstallValues } from "@/app/server-install-actions";
import { CheckboxField, TextField } from "@/components/forms/fields";
import { HostKeyConfirm } from "@/components/servers/HostKeyConfirm";
import { InstallFailure, InstallSuccess } from "@/components/servers/install-outcome";
import { SshLoginFields } from "@/components/servers/SshLoginFields";
import { WhatThisDoes } from "@/components/servers/WhatThisDoes";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type Step = "connect" | "confirm" | "install";

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

const STEPS: { id: Step; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "confirm", label: "Confirm" },
  { id: "install", label: "Install" },
];

// What happens during the install, in order. The bar below estimates which one is running; none is ever shown done
// before the server answers.
const STAGES = ["Checking the server", "Uploading the agent", "Installing and starting it", "Connecting to it"];
const STAGE_SECONDS = 7;

function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s.id} aria-current={i === current ? "step" : undefined} className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-full border text-xs font-medium",
              i < current && "border-success/40 bg-success/10 text-success",
              i === current && "border-foreground bg-foreground text-background",
              i > current && "text-muted-foreground",
            )}
          >
            {i < current ? <CheckIcon aria-hidden className="size-3.5" /> : i + 1}
          </span>
          <span className={cn(i === current ? "font-medium" : "text-muted-foreground")}>{s.label}</span>
          {i < STEPS.length - 1 && <span aria-hidden className="mx-1 hidden h-px w-6 bg-border sm:block" />}
        </li>
      ))}
    </ol>
  );
}

function UpgradeNotes() {
  return (
    <div className="rounded-lg border bg-muted/40 p-4 text-sm">
      <p className="font-medium">What this does</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        <li>Uploads the agent this dashboard carries and checks its checksum on the server.</li>
        <li>Replaces the installed agent and restarts it. Apps keep running: the containers are not touched.</li>
        <li>Keeps the agent&apos;s address, port, secrets, certificate authority, apps file, jobs and nginx setting.</li>
        <li>If the new version does not start, the previous one is put back.</li>
        <li>Issues a new client certificate for this dashboard and stores it.</li>
      </ul>
    </div>
  );
}

function UpgradeSuccess({ serverId, version }: { serverId: string; version: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CircleCheckIcon aria-hidden className="size-6 text-success" />
          <CardTitle role="status">Agent updated</CardTitle>
        </div>
        <CardDescription>
          The agent now runs version <span className="font-mono">{version}</span> and answers over mutual TLS. Its apps and jobs were not interrupted.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button asChild>
          <Link href={`/servers/${serverId}`}>Open the server</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

export interface UpgradeTarget {
  serverId: string;
  /** The address the dashboard reaches the server by, offered as the SSH address. */
  host: string;
}

/** What an import file already says about a server that has no agent yet. */
export interface InstallPrefill {
  name?: string;
  host?: string;
  port?: string;
  user?: string;
}

export function SshInstallWizard({ upgrade, prefill }: { upgrade?: UpgradeTarget; prefill?: InstallPrefill }) {
  const [values, setValues] = useState<InstallValues>({
    ...EMPTY,
    host: upgrade?.host ?? prefill?.host ?? "",
    port: prefill?.port ?? EMPTY.port,
    username: prefill?.user ?? EMPTY.username,
    name: prefill?.name ?? EMPTY.name,
  });
  const [upgraded, setUpgraded] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("connect");
  const [fingerprint, setFingerprint] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<InstallResult | null>(null);
  const [pending, start] = useTransition();
  const [seconds, setSeconds] = useState(0);

  const set = <K extends keyof InstallValues>(key: K, value: InstallValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  // The progress estimate advances while the install request is out.
  const installing = pending && step === "install";
  useEffect(() => {
    if (!installing) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [installing]);

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

  function install(force = false) {
    setStep("install");
    setResult(null);
    setSeconds(0);
    start(async () => {
      if (upgrade) {
        const r = await upgradeAgentOverSshAction(upgrade.serverId, values, fingerprint, { force });
        if (r.ok) {
          setUpgraded(r.version);
          setValues((v) => ({ ...v, privateKey: "", passphrase: "", password: "", sudoPassword: "" }));
        } else {
          setResult(r);
        }
        return;
      }
      const r = await installOverSshAction(values, fingerprint);
      setResult(r);
      // The login is spent: nothing secret stays in memory once the server is registered.
      if (r.ok) setValues((v) => ({ ...v, privateKey: "", passphrase: "", password: "", sudoPassword: "" }));
    });
  }

  function backToForm() {
    if (result && !result.ok && result.errors) setErrors(result.errors);
    setStep("connect");
    setResult(null);
    setProblem(null);
  }

  function startOver() {
    setFingerprint("");
    backToForm();
  }

  const failed = result && !result.ok ? result : null;
  if (upgraded !== null && upgrade) return <UpgradeSuccess serverId={upgrade.serverId} version={upgraded} />;
  if (result?.ok) return <InstallSuccess serverId={result.serverId} notes={result.notes} />;

  return (
    <Card>
      <CardHeader className="gap-3">
        <Stepper step={step} />
        <div>
          <CardTitle>
            {step === "connect" && (upgrade ? "Log in to update the agent" : "Connect to the server")}
            {step === "confirm" && "Is this your server?"}
            {step === "install" && (failed ? (upgrade ? "The update did not finish" : "The install did not finish") : upgrade ? "Updating the agent" : "Installing the agent")}
          </CardTitle>
          <CardDescription>
            {step === "connect" && (upgrade ? "Keelson logs in over SSH once, replaces the agent, and forgets the login. Its settings, apps and secrets are kept." : "Keelson logs in over SSH once, installs the agent, and forgets the login.")}
            {step === "confirm" && "Nothing has been sent to the server yet: only its public host key was read."}
            {step === "install" && !result && "This takes about half a minute."}
          </CardDescription>
        </div>
      </CardHeader>

      {step === "connect" && (
        <>
          <CardContent className="space-y-6">
            {problem && <Notice title="Could not reach the server">{problem}</Notice>}
            <SshLoginFields values={values} errors={errors} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} purpose={upgrade ? "this update" : "this install"} />

            {!upgrade && (
              <>
                <TextField id="server-name" label="Name" value={values.name} onChange={(v) => set("name", v)} error={errors.name} placeholder={values.host || "my-server"} help="How this server is called here. Defaults to the address." />

                <Collapsible>
                  <CollapsibleTrigger className="text-sm font-medium underline-offset-4 hover:underline">Advanced options</CollapsibleTrigger>
                  <CollapsibleContent className="mt-4 space-y-4">
                    <TextField id="agent-port" label="Agent port" inputMode="numeric" value={values.agentPort} onChange={(v) => set("agentPort", v)} error={errors.agentPort} help="Where the agent listens for this dashboard (mutual TLS)." className="max-w-40" />
                    <CheckboxField
                      id="opt-nginx"
                      label="Prepare for nginx on this server"
                      checked={values.nginx}
                      onChange={(v) => set("nginx", v)}
                      help="Lets the agent switch traffic through nginx with no downtime: a directory for the upstream file and the right to test and reload nginx, nothing else."
                    />
                    <CheckboxField
                      id="opt-firewall"
                      label="Open the agent port in the firewall (ufw) for this dashboard"
                      checked={values.openFirewall}
                      onChange={(v) => set("openFirewall", v)}
                      help="Only this dashboard's address, only that port, and only if ufw is active."
                    />
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}

            {upgrade ? <UpgradeNotes /> : <WhatThisDoes ssh />}
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
            <HostKeyConfirm host={values.host} port={values.port} fingerprint={fingerprint} />
          </CardContent>
          <CardFooter className="justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setStep("connect")}>
              Back
            </Button>
            <Button type="button" onClick={() => install()}>
              <ICONS.security />
              {upgrade ? "This is my server, update the agent" : "This is my server, install the agent"}
            </Button>
          </CardFooter>
        </>
      )}

      {step === "install" && (
        <>
          <CardContent>
            {!result && (
              <ol className="space-y-3" aria-live="polite">
                {STAGES.map((label, i) => {
                  const active = Math.min(Math.floor(seconds / STAGE_SECONDS), STAGES.length - 1) === i;
                  const upcoming = Math.min(Math.floor(seconds / STAGE_SECONDS), STAGES.length - 1) < i;
                  return (
                    <li key={label} className={cn("flex items-center gap-3 text-sm", upcoming && "text-muted-foreground")}>
                      {active ? <LoaderCircleIcon aria-hidden className="size-4 animate-spin" /> : <CircleIcon aria-hidden className={cn("size-4", upcoming ? "text-muted-foreground/40" : "text-muted-foreground")} />}
                      <span>{label}</span>
                    </li>
                  );
                })}
              </ol>
            )}
            {failed && (
              <InstallFailure message={failed.message} stage={failed.stage} agentPort={values.agentPort}>
                {failed.stage === "hostkey" ? (
                  <Button type="button" size="sm" variant="outline" onClick={startOver}>
                    Start over
                  </Button>
                ) : (
                  <>
                    <Button type="button" size="sm" variant="outline" onClick={backToForm}>
                      Back
                    </Button>
                    {failed.busy && failed.busy.length > 0 && (
                      <>
                        <ul className="list-disc pl-5 text-sm">
                          {failed.busy.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                        <Button type="button" size="sm" variant="destructive" onClick={() => install(true)}>
                          Update anyway
                        </Button>
                      </>
                    )}
                    {!failed.busy && (failed.stage === "install" || failed.stage === "upload" || failed.stage === "verify" || failed.stage === "connect") && (
                      <Button type="button" size="sm" onClick={() => install()}>
                        Try again
                      </Button>
                    )}
                  </>
                )}
              </InstallFailure>
            )}
          </CardContent>
        </>
      )}
    </Card>
  );
}
