"use client";

import { useEffect, useState, useTransition } from "react";
import { enrolServerAction } from "@/app/server-enrol-actions";
import { TextField } from "@/components/forms/fields";
import { CodeBlock, InstallSuccess } from "@/components/servers/install-outcome";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ENROL_COMMAND, parseEnrolment } from "@/lib/enroll-core";
import type { EnrolResult } from "@/lib/enroll";

/** The host the string names, to suggest a name; null while the string is not (yet) valid. */
function hostOf(text: string): string | null {
  try {
    return parseEnrolment(text).host;
  } catch {
    return null;
  }
}

/**
 * Adds a server from the string `keelson-agent enroll-code` prints. A string that arrives in the link only fills the field:
 * nothing is sent until the operator presses the button.
 */
export function EnrolServer({ initial = "" }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const [name, setName] = useState("");
  const [result, setResult] = useState<EnrolResult | null>(null);
  const [pending, start] = useTransition();

  const host = hostOf(text);

  // The code does not stay in the address bar, the history, a Referer or the path a server action posts to.
  useEffect(() => {
    if (initial !== "") window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [initial]);

  function enrol() {
    setResult(null);
    start(async () => {
      try {
        const r = await enrolServerAction(text, name);
        setResult(r);
        if (r.ok) setText("");
      } catch {
        setResult({ ok: false, message: "The request failed. Check that you are still signed in and try again." });
      }
    });
  }

  if (result?.ok) {
    return <InstallSuccess serverId={result.serverId} notes={result.deployable ? [] : ["This agent has no deploy secret: the server is read-only until you set one."]} />;
  }
  const failed = result && !result.ok ? result : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrol with a code</CardTitle>
        <CardDescription>
          On the server, as root, run the command below. It prints one line, valid for 15 minutes and for one use. Paste it here: the dashboard checks
          the agent&apos;s certificate against the line, then collects the credentials itself. Nothing to copy but that line.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CodeBlock value={ENROL_COMMAND} label="Copy the command" />
        <div className="space-y-2">
          <Label htmlFor="enrol-string">Enrolment string</Label>
          <Textarea
            id="enrol-string"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs break-all"
            placeholder="kse1.…"
            aria-describedby="enrol-help"
            aria-invalid={failed?.field === "string" || undefined}
          />
          <p id="enrol-help" className="text-xs text-muted-foreground">
            {initial !== "" && text === initial ? "Filled from the link: check it, then press Enrol. " : ""}
            The line holds a one-time code and is not saved.
          </p>
        </div>
        <TextField
          id="enrol-name"
          label="Name"
          value={name}
          onChange={setName}
          placeholder={host ?? "Defaults to the server's address"}
          error={failed?.field === "name" ? failed.message : undefined}
        />
        {failed && failed.field !== "name" && (
          <div className="grid gap-2">
            <Notice title="Not enrolled">{failed.message}</Notice>
            <div>
              <StepUpAction error={failed.message} />
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={enrol} loading={pending} disabled={text.trim() === ""}>
          Enrol
        </Button>
      </CardFooter>
    </Card>
  );
}
