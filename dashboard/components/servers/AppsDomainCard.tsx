"use client";

import { useActionState } from "react";
import { saveAppsDomainAction, type AppsDomainState } from "@/app/apps-domain-actions";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The domain *New project* names a project under on this server (`shop.apps.example.com`), so that adding a project asks
 * for no host name. Only a default: it creates no DNS record by itself (Cloudflare, when connected, does that per project,
 * and a wildcard record `*.apps.example.com` at your DNS provider covers them all if you prefer one record).
 */
export function AppsDomainCard({ serverId, current }: { serverId: string; current: string | null }) {
  const [state, action, pending] = useActionState<AppsDomainState, FormData>(saveAppsDomainAction.bind(null, serverId), {});
  const shown = state.saved !== undefined ? state.saved : current;
  return (
    <Card className="max-w-2xl">
      <form action={action}>
        <CardHeader>
          <CardTitle>Apps domain</CardTitle>
          <CardDescription>
            New projects on this server get <span className="font-mono">&lt;project&gt;.{shown ?? "your-domain"}</span> as their address, filled in for you in <em>New project</em> (you can change it per project). Leave it empty for no default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="appsDomain">Domain</Label>
          <Input
            id="appsDomain"
            name="appsDomain"
            defaultValue={current ?? ""}
            placeholder="apps.example.com"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "appsDomain-error" : "appsDomain-help"}
          />
          <p id="appsDomain-help" className="text-xs text-muted-foreground">
            A domain you control and whose DNS can point at this server. Each project needs a record for its name: with Cloudflare connected Keelson creates it, otherwise it tells you what to create.
          </p>
          {state.error && (
            <div className="flex flex-wrap items-center gap-2">
              <p id="appsDomain-error" role="alert" className="text-sm font-medium text-destructive">
                {state.error}
              </p>
              <StepUpAction error={state.error} />
            </div>
          )}
          {state.error === undefined && state.saved !== undefined && (
            <p role="status" className="text-sm text-muted-foreground">
              {state.saved === null ? "Cleared: new projects get no default domain." : `Saved: new projects get <project>.${state.saved}.`}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
