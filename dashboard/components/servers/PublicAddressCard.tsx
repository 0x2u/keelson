"use client";

import { useActionState } from "react";
import { savePublicIpAction, type PublicIpState } from "@/app/public-ip-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StepUpAction } from "@/components/unlock";
import { Label } from "@/components/ui/label";

/**
 * The address the domains of a server that connects out must point at. Such a server has no URL to read it from, so it is
 * set here; a project's Domains tab says what record to create once it is.
 */
export function PublicAddressCard({ serverId, current }: { serverId: string; current: string | null }) {
  const [state, action, pending] = useActionState<PublicIpState, FormData>(savePublicIpAction.bind(null, serverId), {});
  return (
    <Card className="max-w-2xl">
      <form action={action}>
        <CardHeader>
          <CardTitle>Public address</CardTitle>
          <CardDescription>
            This server connects out to the dashboard, so Keelson cannot read its address from a URL. Set the IP address its domains must point at: it is what the DNS records Keelson shows
            (or creates through Cloudflare) contain.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="publicIp">IP address</Label>
          <Input
            id="publicIp"
            name="publicIp"
            defaultValue={current ?? ""}
            placeholder="203.0.113.7"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "publicIp-error" : undefined}
          />
          {state.error && (
            <p id="publicIp-error" role="alert" className="text-sm font-medium text-destructive">
              {state.error}
            </p>
          )}
          <StepUpAction error={state.error} />
          {state.error === undefined && state.saved !== undefined && (
            <p role="status" className="text-sm text-muted-foreground">
              {state.saved === "" ? "Cleared." : `Saved: domains of this server point at ${state.saved}.`}
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
