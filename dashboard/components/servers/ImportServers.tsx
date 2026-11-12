"use client";

import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon, TerminalIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { importServersAction, type ImportOutcome, type ImportStatus } from "@/app/server-import-actions";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { isStepUpError } from "@/lib/gate-core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const EXAMPLE = `{
  "servers": [
    { "name": "local", "url": "http://127.0.0.1:7070", "token": "…at least 32 characters…" },
    { "name": "vps", "ssh": { "host": "203.0.113.7", "port": 22, "user": "debian" } }
  ]
}`;

const MARK: Record<ImportStatus, { icon: typeof CircleCheckIcon; tone: string; label: string }> = {
  added: { icon: CircleCheckIcon, tone: "text-success", label: "Added" },
  added_unreachable: { icon: CircleAlertIcon, tone: "text-warning", label: "Added, not answering" },
  exists: { icon: CircleMinusIcon, tone: "text-muted-foreground", label: "Already there" },
  invalid: { icon: CircleAlertIcon, tone: "text-destructive", label: "Refused" },
  unreachable: { icon: CircleAlertIcon, tone: "text-destructive", label: "Not added" },
  install: { icon: TerminalIcon, tone: "text-info", label: "Needs an agent" },
};

/** Registers several servers from a JSON file (see lib/server-import-core.ts for the format). */
export function ImportServers() {
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  async function load(file: File | undefined) {
    if (!file) return;
    setOutcome(null);
    setProblem(null);
    setText(await file.text());
  }

  function submit() {
    setOutcome(null);
    setProblem(null);
    start(async () => {
      try {
        setOutcome(await importServersAction(text, keep));
      } catch {
        setProblem("The import failed. Check that you are still signed in and try again.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import servers from a file</CardTitle>
        <CardDescription>
          A JSON list of servers. An agent that already runs is checked and registered; an address without an agent is sent to the installer. A
          name that exists is never overwritten. The file holds tokens: keep it out of version control.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="import-text">File content</Label>
          <Textarea
            id="import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={EXAMPLE}
            aria-describedby="import-help"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input ref={input} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} onChange={(e) => void load(e.target.files?.[0])} />
            <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
              Choose a file…
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="size-4 accent-primary" />
              Keep agents that do not answer yet
            </label>
          </div>
          <p id="import-help" className="text-xs text-muted-foreground">
            Per server: <code className="font-mono">name</code>, <code className="font-mono">url</code>, <code className="font-mono">token</code>, and optionally{" "}
            <code className="font-mono">deploy_secret</code>, <code className="font-mono">ca_cert</code>, <code className="font-mono">client_cert</code>,{" "}
            <code className="font-mono">client_key</code>; or <code className="font-mono">name</code> with{" "}
            <code className="font-mono">ssh: {"{ host, port, user }"}</code>.
          </p>
        </div>

        {problem && (
          <div className="grid gap-2">
            <Notice title="Not imported">{problem}</Notice>
            <div>
              <StepUpAction error={problem} />
            </div>
          </div>
        )}
        {outcome && !outcome.ok && (
          <Notice title={isStepUpError(outcome.error) ? "Unlock changes first" : "That file cannot be read"} action={<StepUpAction error={outcome.error} />}>
            {outcome.error}
          </Notice>
        )}
        {outcome?.ok && (
          <ul className="divide-y rounded-md border" aria-label="Import result">
            {outcome.rows.map((r, i) => {
              const m = MARK[r.status];
              return (
                <li key={`${r.name}-${i}`} className="flex items-start gap-3 p-3 text-sm">
                  <m.icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${m.tone}`} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {r.name} <span className="font-normal text-muted-foreground">· {m.label}</span>
                    </p>
                    {r.message && <p className="text-muted-foreground">{r.message}</p>}
                    {r.status === "unreachable" && (
                      <p className="text-muted-foreground">Start the agent and import again, or tick “Keep agents that do not answer yet” to register it anyway.</p>
                    )}
                  </div>
                  {r.installHref && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={r.installHref}>Install</Link>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={submit} loading={pending} disabled={text.trim() === ""}>
          Import
        </Button>
      </CardFooter>
    </Card>
  );
}
