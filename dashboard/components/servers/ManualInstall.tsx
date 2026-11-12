"use client";

import { DownloadIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { importBundleAction, type InstallResult } from "@/app/server-install-actions";
import { CheckboxField, FieldShell, SegmentedControl, TextField, describeField } from "@/components/forms/fields";
import { CodeBlock, InstallFailure, InstallSuccess } from "@/components/servers/install-outcome";
import { WhatThisDoes } from "@/components/servers/WhatThisDoes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const PORT = "7443";

/** For servers the dashboard has no SSH access to: the operator runs the installer and pastes what it prints. */
export function ManualInstall() {
  const [arch, setArch] = useState("amd64");
  const [host, setHost] = useState("");
  const [nginx, setNginx] = useState(false);
  const [bundle, setBundle] = useState("");
  const [name, setName] = useState("");
  const [result, setResult] = useState<InstallResult | null>(null);
  const [pending, start] = useTransition();

  const file = `keelson-agent-linux-${arch}`;
  const target = host.trim() || "SERVER_ADDRESS";
  const copyCommand = `scp ${file} USER@${target}:`;
  const installCommand = `chmod +x ${file} && sudo ./${file} install --host ${target}${nginx ? " --nginx" : ""} > bundle.json`;

  function add() {
    setResult(null);
    start(async () => {
      const r = await importBundleAction(bundle, name);
      setResult(r);
      if (r.ok) setBundle("");
    });
  }

  if (result?.ok) return <InstallSuccess serverId={result.serverId} notes={result.notes} />;
  const failed = result && !result.ok ? result : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Install the agent yourself</CardTitle>
        <CardDescription>For a server this dashboard cannot reach over SSH. You run one command there and paste what it prints.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">1. Download the agent</h3>
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              label="Server architecture"
              value={arch}
              options={[
                { value: "amd64", label: "x86_64 (amd64)" },
                { value: "arm64", label: "arm64" },
              ]}
              onChange={setArch}
            />
            <Button asChild variant="outline" size="sm">
              <a href={`/api/agent-binary/${arch}`} download={file}>
                <DownloadIcon /> Download {file}
              </a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the exact version of the agent this dashboard installs by itself. <code className="font-mono">uname -m</code> on the server says which one you need
            (x86_64 or aarch64).
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">2. Copy it to the server and install it</h3>
          <TextField id="manual-host" label="Server address" value={host} onChange={setHost} placeholder="203.0.113.10 or server.example.com" help="The address this dashboard will use to reach the agent. It fills the commands below." className="max-w-md" mono />
          <CheckboxField id="manual-nginx" label="Prepare for nginx on this server" checked={nginx} onChange={setNginx} help="Adds a directory for the upstream file and the right to test and reload nginx, nothing else." />
          <CodeBlock value={copyCommand} label="Copy the scp command" />
          <CodeBlock value={installCommand} label="Copy the install command" />
          <p className="text-xs text-muted-foreground">
            The installer prints the connection bundle (JSON) on its standard output, which the command above saves in <code className="font-mono">bundle.json</code>. Its progress
            goes to your terminal.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">3. Open the agent&apos;s port</h3>
          <p className="text-sm text-muted-foreground">
            If the server has a firewall, allow this dashboard&apos;s address to reach TCP port <code className="font-mono">{PORT}</code>, for example{" "}
            <code className="font-mono">sudo ufw allow from DASHBOARD_IP to any port {PORT} proto tcp</code>. Only a client with the certificate in the bundle is accepted.
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">4. Paste the bundle</h3>
          {failed && (
            <InstallFailure message={failed.message} stage={failed.stage} agentPort={PORT} title="The server was not added" />
          )}
          <FieldShell
            id="bundle"
            label="Contents of bundle.json"
            help={
              <>
                It holds the agent&apos;s secrets and a client key. It is saved here encrypted and never shown again. Delete the file on the server afterwards:{" "}
                <code className="font-mono">shred -u bundle.json</code>.
              </>
            }
          >
            <Textarea
              value={bundle}
              onChange={(e) => setBundle(e.target.value)}
              rows={8}
              autoComplete="off"
              spellCheck={false}
              placeholder='{ "version": 1, "name": "…", "url": "https://…", … }'
              className="font-mono text-xs"
              {...describeField("bundle", true, undefined)}
            />
          </FieldShell>
          <TextField id="manual-name" label="Name" value={name} onChange={setName} placeholder="Defaults to the name in the bundle" error={failed?.errors?.name} className="max-w-md" />
        </section>

        <WhatThisDoes />
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="button" onClick={add} loading={pending} disabled={bundle.trim() === ""}>
          Add the server
        </Button>
      </CardFooter>
    </Card>
  );
}
