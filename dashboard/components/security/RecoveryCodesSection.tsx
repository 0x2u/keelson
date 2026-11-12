"use client";

import { ICONS } from "@/lib/icons";
import { useState } from "react";
import { regenerateRecoveryCodesAction } from "@/app/auth-actions";
import { PasswordConfirmDialog } from "@/components/security/PasswordConfirmDialog";
import { RecoveryCodesDialog } from "@/components/security/RecoveryCodesDialog";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const RECOVERY_CODES_TOTAL = 10;
const LOW_AT = 3;

export function RecoveryCodesSection({ left }: { left: number }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const low = left <= LOW_AT;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovery codes</CardTitle>
        <CardDescription>One-time codes that let you sign in when your authenticator and passkeys are out of reach.</CardDescription>
        <CardAction>
          <Badge variant={low ? "warning" : "muted"}>
            {left} of {RECOVERY_CODES_TOTAL} left
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {low && (
          <Notice tone="warning" title={left === 0 ? "No recovery codes left" : "Recovery codes are running low"}>
            {left === 0
              ? "If you lose access to your authenticator and passkeys you will be locked out. Generate new codes now."
              : "Generate new codes before you run out."}
          </Notice>
        )}
        <div>
          <PasswordConfirmDialog
            title="Generate new recovery codes"
            description="This replaces every recovery code you have now: the old ones stop working immediately. The new codes are shown once."
            confirmLabel="Generate new codes"
            successMessage="Generated new recovery codes"
            action={regenerateRecoveryCodesAction}
            onSuccess={(state) => setCodes(state.recoveryCodes ?? null)}
            trigger={
              <Button variant="outline">
                <ICONS.secret /> Generate new codes
              </Button>
            }
          />
        </div>
      </CardContent>
      <RecoveryCodesDialog codes={codes} onDone={() => setCodes(null)} />
    </Card>
  );
}
