"use client";

import { CircleCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import type { InstallStage } from "@/lib/ssh-install";
import { CopyButton } from "@/components/copy-button";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/** A command or snippet on one scrolling line (long commands scroll inside the block, never the page). */
export function CodeBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-1 rounded-md border bg-muted px-3 py-2">
      <pre className="min-w-0 flex-1 overflow-x-auto py-0.5 font-mono text-xs leading-relaxed">
        <code>{value}</code>
      </pre>
      <CopyButton value={value} label={label} />
    </div>
  );
}

const NGINX_SETTING = "proxy: {";

/** One note from the installer. The nginx note carries a setting to paste into the apps file: show it as code. */
function Note({ note }: { note: string }) {
  const at = note.indexOf(NGINX_SETTING);
  if (at < 0) return <li>{note}</li>;
  const prose = note.slice(0, at).trim();
  const snippet = note.slice(at).trim();
  return (
    <li className="space-y-2">
      <p>{prose}</p>
      <CodeBlock value={snippet} label="Copy the nginx setting" />
    </li>
  );
}

/** The server is registered: what the installer wants the operator to know, and the way to the server. */
export function InstallSuccess({ serverId, notes }: { serverId: string; notes: string[] }) {
  const router = useRouter();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CircleCheckIcon aria-hidden className="size-6 text-success" />
          <CardTitle role="status">Server added</CardTitle>
        </div>
        <CardDescription>
          The agent is installed, answers over mutual TLS, and is saved here. The secrets it uses are stored encrypted and are not shown again.
        </CardDescription>
      </CardHeader>
      {notes.length > 0 && (
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">Worth knowing</p>
          <ul className="list-disc space-y-3 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/60">
            {notes.map((note) => (
              <Note key={note} note={note} />
            ))}
          </ul>
        </CardContent>
      )}
      <CardFooter>
        <Button type="button" onClick={() => router.push(`/servers/${serverId}`)}>
          Open the server
        </Button>
      </CardFooter>
    </Card>
  );
}

/** What went wrong at a given stage, and what to do about it. */
function stageHelp(stage: InstallStage | undefined, agentPort: string): ReactNode {
  switch (stage) {
    case "hostkey":
      return "The server's host key is no longer the one you confirmed. Do not retry yet: check that you are talking to your own server, and that it was not reinstalled or replaced. Then start over to confirm its key again.";
    case "auth":
      return "Nothing was installed. Go back to correct the user, the key or password, or the key's passphrase.";
    case "sudo":
      return "This user needs sudo to install the agent, and sudo asked for a password. Go back and enter the sudo password, or connect as root.";
    case "prerequisites":
      return "The server is missing something the agent needs, named above. Install it (Docker, for example), then try again.";
    case "connect":
      return "The dashboard could not reach the server over SSH. Check the address and the SSH port, and that no firewall blocks this dashboard.";
    case "upload":
    case "install":
      return "The installer stopped part-way. Trying again is safe: it can be run again on the same server.";
    case "verify":
      return (
        <>
          The agent is installed but this dashboard cannot reach it. Most often the agent&apos;s port ({agentPort || "7443"}) is closed to this
          dashboard&apos;s address. Open it in the server&apos;s firewall, then try again: the installer can be run again safely.
        </>
      );
    default:
      return null;
  }
}

/** A failed install or import: the message, then help for the stage it failed at. The caller supplies the buttons. */
export function InstallFailure({
  message,
  stage,
  agentPort,
  title = "The server was not added",
  children,
}: {
  message: string;
  stage?: InstallStage;
  agentPort: string;
  title?: string;
  children?: ReactNode;
}) {
  const help = stageHelp(stage, agentPort);
  return (
    <Notice title={title} action={children ? <div className="flex flex-wrap gap-2 pt-1">{children}</div> : undefined}>
      <span className="block break-words">{message}</span>
      {help && <span className="mt-2 block">{help}</span>}
    </Notice>
  );
}
