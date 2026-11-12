"use client";

import { CopyIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useId, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { createApiTokenAction, revokeApiTokenAction, type ApiTokenState, type CreatedToken } from "@/app/api-token-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldShell, TextField, describeField } from "@/components/forms/fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, NAME_MAX, type ApiScope, type TokenStatus } from "@/lib/api-tokens-core";
import { mcpConfig } from "@/lib/mcp-config";
import { toastCopy } from "@/lib/toast-core";

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scope: ApiScope;
  servers: string[] | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  revokedAt: number | null;
  /** Worked out on the server: the clock of a render is not a stable input. */
  status: TokenStatus;
}

export interface ServerOption {
  id: string;
  name: string;
}

const STATUS = {
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "muted" },
  revoked: { label: "Revoked", tone: "danger" },
} as const;

const SCOPE_HELP: Record<ApiScope, string> = {
  read: "Read: everything the dashboard shows (servers, apps, deployments, logs, jobs, databases, previews, proxy), and nothing it changes.",
  deploy: "Deploy: read, plus deploying an app, rolling it back and running a job. It cannot edit configuration, restore a database or manage secrets.",
};

export function ApiTokensSection({ tokens, servers, origin }: { tokens: ApiTokenView[]; servers: ServerOption[]; origin: string | null }) {
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const names = new Map(servers.map((s) => [s.id, s.name]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>API tokens</CardTitle>
        <CardDescription>
          Let a script, a CI job or an AI assistant (through the MCP server) read this dashboard, and optionally deploy. A token is shown once, expires, and can
          be limited to some servers. It can never manage tokens, change configuration, restore a database or read a secret.
        </CardDescription>
        <CardAction>
          <CreateTokenDialog servers={servers} onCreated={setCreated} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {tokens.length === 0 ? (
          <div className="rounded-md border border-dashed">
            <EmptyState icon={ICONS.secret} title="No API token yet">
              Create one to call the REST API under <code className="font-mono text-xs">/api/v1</code> or to connect the MCP server.
            </EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Servers</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => {
                const status = STATUS[t.status];
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{t.prefix}…</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.scope === "deploy" ? "warning" : "info"}>{t.scope}</Badge>
                    </TableCell>
                    <TableCell className="max-w-48 text-muted-foreground">
                      {t.servers === null ? "All servers" : t.servers.map((id) => names.get(id) ?? "removed server").join(", ")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <RelativeTime at={t.createdAt} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {t.revokedAt === null ? (
                        <RelativeTime at={t.expiresAt} future={t.status === "active"} />
                      ) : (
                        // Revoking ends the token now: its expiry is then that moment, which is not "expires just now".
                        <>
                          Revoked <RelativeTime at={t.revokedAt} />
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.lastUsedAt === null ? (
                        "Never"
                      ) : (
                        <>
                          <RelativeTime at={t.lastUsedAt} />
                          {t.lastUsedIp && t.lastUsedIp !== "local" && <span className="block font-mono text-xs">{t.lastUsedIp}</span>}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.tone}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{t.revokedAt === null && <RevokeButton token={t} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <TokenCreatedDialog created={created} origin={origin} onDone={() => setCreated(null)} />
    </Card>
  );
}

function RevokeButton({ token }: { token: ApiTokenView }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function revoke() {
    setError(null);
    start(async () => {
      try {
        await revokeApiTokenAction(token.id);
        setOpen(false);
        toast.success(toastCopy.revoked(`token ${token.name}`));
      } catch {
        setError("Reload the page and try again.");
      }
    });
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
      trigger={
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" aria-label={`Revoke token ${token.name}`}>
          Revoke
        </Button>
      }
      title={<>Revoke &ldquo;{token.name}&rdquo;?</>}
      description="Every call made with this token fails from now on. This cannot be undone: create a new token to restore access."
      confirmLabel="Revoke token"
      destructive
      typeToConfirm={token.name}
      pending={pending}
      error={error}
      onConfirm={revoke}
    />
  );
}

function CreateTokenDialog({ servers, onCreated }: { servers: ServerOption[]; onCreated: (c: CreatedToken) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <ICONS.add /> Create a token
      </Button>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <CreateForm
            servers={servers}
            onCreated={(c) => {
              setOpen(false);
              onCreated(c);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ servers, onCreated }: { servers: ServerOption[]; onCreated: (c: CreatedToken) => void }) {
  const id = useId();
  // Every field is controlled and the form is submitted by hand: a form action would reset the fields when it returns,
  // and a refused password must not cost what was typed.
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>("read");
  const [limited, setLimited] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [days, setDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [password, setPassword] = useState("");
  const [state, setState] = useState<ApiTokenState>({});
  const [pending, start] = useTransition();
  const [local, setLocal] = useState<{ name?: string; days?: string; password?: string }>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // All the missing fields are reported at once, next to each field.
    const problems: { name?: string; days?: string; password?: string } = {};
    if (name.trim() === "") problems.name = "Enter a name";
    const parsed = Number(days);
    if (days.trim() === "" || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_EXPIRY_DAYS) {
      problems.days = `Enter a whole number of days between 1 and ${MAX_EXPIRY_DAYS}`;
    }
    if (password === "") problems.password = "Enter your password";
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    const form = new FormData(event.currentTarget);
    start(async () => {
      const next = await createApiTokenAction({}, form);
      setState(next);
      setPassword("");
      if (next.created) onCreated(next.created);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Create an API token</DialogTitle>
        <DialogDescription>The token is shown once, right after you confirm with your password.</DialogDescription>
      </DialogHeader>

      <TextField
        id={`${id}-name`}
        name="name"
        label="Name"
        error={local.name}
        value={name}
        onChange={setName}
        maxLength={NAME_MAX}
        placeholder="ci, claude-desktop…"
        autoFocus
      />

      <FieldShell id={`${id}-scope`} label="Scope" group>
        {(["read", "deploy"] as const).map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="scope" value={value} checked={scope === value} onChange={() => setScope(value)} className="mt-1 size-4 accent-primary" />
            <span>
              <span className="font-medium capitalize">{value}</span>
              <span className="block text-muted-foreground">{SCOPE_HELP[value]}</span>
            </span>
          </label>
        ))}
        {scope === "deploy" && (
          <p role="note" className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-warning">
            Anyone holding this token can deploy to, roll back and run jobs on the servers below. Give it only to something you trust, and keep it short-lived.
          </p>
        )}
      </FieldShell>

      <FieldShell id={`${id}-servers`} label="Servers" group>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="limit" value="all" checked={!limited} onChange={() => setLimited(false)} className="size-4 accent-primary" />
          All servers (including ones added later)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="limit" value="some" checked={limited} onChange={() => setLimited(true)} className="size-4 accent-primary" />
          Only these
        </label>
        {limited && (
          <ul className="ml-6 grid gap-1">
            {servers.length === 0 && <li className="text-sm text-muted-foreground">No server yet.</li>}
            {servers.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="server"
                    value={s.id}
                    checked={chosen.includes(s.id)}
                    onChange={(event) => setChosen(event.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))}
                    className="size-4 accent-primary"
                  />
                  {s.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </FieldShell>

      <TextField
        id={`${id}-days`}
        name="days"
        type="number"
        min={1}
        max={MAX_EXPIRY_DAYS}
        step={1}
        label="Expires after (days)"
        help={`Between 1 and ${MAX_EXPIRY_DAYS}. A token cannot be extended: create a new one.`}
        error={local.days}
        value={days}
        onChange={setDays}
        inputClassName="w-32"
      />

      <TextField
        id={`${id}-password`}
        name="password"
        type="password"
        label="Current password"
        error={local.password ?? state.error}
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" loading={pending}>
          Create token
        </Button>
      </DialogFooter>
    </form>
  );
}

async function copy(value: string, done: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(done);
  } catch {
    toast.error(toastCopy.failed("copied", "to the clipboard"), { description: "The browser refused clipboard access" });
  }
}

/** Shows the token exactly once. It cannot be dismissed until the operator confirms they saved it: closing loses it for good. */
function TokenCreatedDialog({ created, origin, onDone }: { created: CreatedToken | null; origin: string | null; onDone: () => void }) {
  return (
    <Dialog open={created !== null}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {created && <CreatedBody created={created} origin={origin} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function CreatedBody({ created, origin, onDone }: { created: CreatedToken; origin: string | null; onDone: () => void }) {
  const id = useId();
  const [saved, setSaved] = useState(false);
  const config = mcpConfig(origin ?? "https://<your dashboard>", created.token);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Token &ldquo;{created.name}&rdquo; created</DialogTitle>
        <DialogDescription>
          Copy it now. It is shown once and cannot be recovered: only a fingerprint is stored here. It expires <RelativeTime at={created.expiresAt} future />.
        </DialogDescription>
      </DialogHeader>
      <FieldShell id={`${id}-token`} label="Token">
        <div className="flex gap-2">
          <Input
            readOnly
            value={created.token}
            className="font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
            {...describeField(`${id}-token`, false, undefined)}
          />
          <Button type="button" variant="outline" onClick={() => copy(created.token, toastCopy.copied("token"))}>
            <CopyIcon /> Copy
          </Button>
        </div>
      </FieldShell>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${id}-mcp`}>MCP client configuration</Label>
          <Button type="button" variant="ghost" size="sm" onClick={() => copy(config, toastCopy.copied("configuration"))}>
            <CopyIcon /> Copy
          </Button>
        </div>
        <pre id={`${id}-mcp`} className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {config}
        </pre>
        <p className="text-xs text-muted-foreground">
          Replace <code className="font-mono">/path/to/keelson</code> with where you built the MCP server (<code className="font-mono">cd mcp &amp;&amp; pnpm install &amp;&amp; pnpm build</code>).
        </p>
      </div>
      <div className="flex items-start gap-2">
        <input id={`${id}-saved`} type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} className="mt-0.5 size-4 accent-primary" />
        <Label htmlFor={`${id}-saved`} className="font-normal">
          I saved this token
        </Label>
      </div>
      <DialogFooter>
        <Button type="button" disabled={!saved} onClick={onDone}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
