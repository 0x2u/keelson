"use client";

import { LogOutIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { revokeOtherSessionsAction, revokeSessionAction } from "@/app/auth-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastCopy } from "@/lib/toast-core";
import { parseUserAgent } from "@/lib/user-agent";

export interface SessionView {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  method: string;
}

const METHOD: Record<string, string> = {
  password: "Password",
  "password+totp": "Password + authenticator",
  "password+recovery": "Password + recovery code",
  passkey: "Passkey",
};

export function SessionsSection({ sessions, currentId }: { sessions: SessionView[]; currentId: string | null }) {
  const [target, setTarget] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [othersError, setOthersError] = useState<string | null>(null);
  const [revoking, startRevoke] = useTransition();
  const [revokingOthers, startRevokeOthers] = useTransition();
  const others = sessions.filter((s) => s.id !== currentId).length;

  function signOut(id: string) {
    setError(null);
    startRevoke(async () => {
      try {
        await revokeSessionAction(id);
        setTarget(null);
        toast.success(toastCopy.done("revoked", "session"));
      } catch {
        setError("Reload the page and try again.");
      }
    });
  }

  function signOutOthers() {
    setOthersError(null);
    startRevokeOthers(async () => {
      try {
        await revokeOtherSessionsAction();
        setOthersOpen(false);
        toast.success("Signed out of all other sessions");
      } catch {
        setOthersError("Could not sign out the other sessions. Reload the page and try again.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>Browsers currently signed in to this dashboard. Sign out any you do not recognise.</CardDescription>
        <CardAction>
          <ConfirmDialog
            open={othersOpen}
            onOpenChange={(next) => {
              setOthersOpen(next);
              if (next) setOthersError(null);
            }}
            trigger={
              <Button variant="outline" size="sm" disabled={others === 0}>
                <LogOutIcon />
                Sign out all other sessions
              </Button>
            }
            title="Sign out all other sessions?"
            description={`${others === 1 ? "1 other session" : `${others} other sessions`} will end immediately and need the password (and second factor) to sign in again. This session stays signed in.`}
            confirmLabel="Sign out other sessions"
            destructive
            pending={revokingOthers}
            error={othersError}
            onConfirm={signOutOthers}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>IP address</TableHead>
              <TableHead>Signed in with</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => {
              const current = s.id === currentId;
              return (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" title={s.userAgent ?? undefined}>
                        {parseUserAgent(s.userAgent)}
                      </span>
                      {current && <Badge variant="info">This session</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.ip === "local" ? (
                      <span title="Not available: the dashboard is not behind a trusted proxy, so it cannot tell clients apart.">Not available</span>
                    ) : (
                      (s.ip ?? "Unknown")
                    )}
                  </TableCell>
                  <TableCell>{METHOD[s.method] ?? s.method}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime at={s.createdAt} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime at={s.lastSeenAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {!current && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setError(null);
                          setTarget(s);
                        }}
                        aria-label={`Sign out session ${parseUserAgent(s.userAgent)}`}
                      >
                        Sign out
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next) setTarget(null);
        }}
        title="Sign out this session?"
        description="It ends immediately and needs the password (and second factor) to sign in again."
        confirmLabel="Sign out"
        destructive
        typeToConfirm={target ? parseUserAgent(target.userAgent) : undefined}
        pending={revoking}
        error={error}
        onConfirm={() => target && signOut(target.id)}
      />
    </Card>
  );
}
