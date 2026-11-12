"use client";

import { UploadIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteEnvScopeAction } from "@/app/env-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { GatedButton } from "@/components/GatedButton";
import { ImportDialog } from "@/components/environment/ImportDialog";
import { useEnvSave } from "@/components/environment/useEnvSave";
import { VariableDialog } from "@/components/environment/VariableDialog";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EnvScope, EnvVar } from "@/lib/agent-types";
import { shadowLabel, type EnvRules } from "@/lib/env-core";
import { toastCopy } from "@/lib/toast-core";

interface Props {
  serverId: string;
  app: string;
  scope: EnvScope;
  vars: EnvVar[];
  /** Whether the dashboard holds the deploy secret: without it the list is read-only. */
  canDeploy: boolean;
  /** The image that serves now, so the notice's Deploy opens the dialog with it typed in. */
  servingImage: string;
  rules: EnvRules;
}

type Dialog = { kind: "add" } | { kind: "edit"; variable: EnvVar } | { kind: "import" } | { kind: "delete"; variable: EnvVar } | { kind: "clear" } | null;

/** The variables of one scope: their names and state, never their values, with the add, import, replace and delete controls. */
export function EnvironmentEditor({ serverId, app, scope, vars, canDeploy, servingImage, rules }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removing, startRemoving] = useTransition();
  const [clearError, setClearError] = useState<string | null>(null);
  const target = { serverId, app, scope, servingImage };
  const remove = useEnvSave(target);

  const closeDialog = () => {
    setDialog(null);
    setClearError(null);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <GatedButton onClick={() => setDialog({ kind: "add" })} canDeploy={canDeploy}>
          <ICONS.add />
          Add variable
        </GatedButton>
        <GatedButton variant="outline" onClick={() => setDialog({ kind: "import" })} canDeploy={canDeploy}>
          <UploadIcon />
          Import .env
        </GatedButton>
        {vars.length > 0 && (
          <GatedButton variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setDialog({ kind: "clear" })} canDeploy={canDeploy}>
            <ICONS.remove />
            Remove all
          </GatedButton>
        )}
      </div>

      {vars.length === 0 ? (
        <div className="rounded-lg border border-dashed">
          <EmptyState icon={ICONS.variables} title="No variable yet">
            Add one, or import a .env file. Values are stored on the server and never shown again.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Value</TableHead>
                <TableHead className="hidden md:table-cell">Changed</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vars.map((v) => {
                const shadow = shadowLabel(v.shadows);
                return (
                  <TableRow key={v.key}>
                    <TableCell className="pl-4 whitespace-normal">
                      <div className="font-mono text-sm break-all">{v.key}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="success" className="sm:hidden">
                          Set
                        </Badge>
                        {v.build && (
                          <Badge variant="info" title="Also passed to docker build: baked into the image">
                            build
                          </Badge>
                        )}
                        {shadow && (
                          <Badge variant="warning" title={`The managed value wins over the same name in ${v.shadows === "env" ? "env:" : "env_file"} of the server's configuration`}>
                            {shadow}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground md:hidden">
                          changed <RelativeTime at={v.updated_at} />
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="success">Set</Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      <RelativeTime at={v.updated_at} />
                    </TableCell>
                    <TableCell className="pr-4 text-right whitespace-nowrap">
                      <GatedButton variant="ghost" size="sm" onClick={() => setDialog({ kind: "edit", variable: v })} canDeploy={canDeploy}>
                        <ICONS.edit />
                        Replace<span className="sr-only"> value of {v.key}</span>
                      </GatedButton>
                      <GatedButton variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDialog({ kind: "delete", variable: v })} canDeploy={canDeploy}>
                        <ICONS.remove />
                        <span className="sr-only">Delete {v.key}</span>
                      </GatedButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog?.kind === "add" && <VariableDialog target={target} rules={rules} stored={vars} open onOpenChange={(open) => !open && closeDialog()} />}
      {dialog?.kind === "edit" && <VariableDialog target={target} rules={rules} stored={vars} existing={dialog.variable} open onOpenChange={(open) => !open && closeDialog()} />}
      {dialog?.kind === "import" && <ImportDialog target={target} rules={rules} stored={vars} onClose={closeDialog} />}

      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={`Delete ${dialog?.kind === "delete" ? dialog.variable.key : ""}?`}
        description={`The value is removed from the server and cannot be read back. The running container keeps it until ${app} is deployed again.`}
        confirmLabel="Delete variable"
        destructive
        pending={remove.pending}
        error={remove.failure?.message}
        onConfirm={() => {
          if (dialog?.kind !== "delete") return;
          remove.save([], [dialog.variable.key], closeDialog);
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === "clear"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={`Remove all ${vars.length} variables of ${scope === "app" ? "production" : "previews"}?`}
        description={`Every value stored here is removed from the server and cannot be read back. The running container keeps its variables until ${app} is deployed again.`}
        confirmLabel="Remove all variables"
        destructive
        typeToConfirm={app}
        pending={removing}
        error={clearError}
        onConfirm={() => {
          setClearError(null);
          startRemoving(async () => {
            const result = await deleteEnvScopeAction(serverId, app, scope);
            if (!result.ok) {
              setClearError(result.error);
              return;
            }
            closeDialog();
            toast.success(toastCopy.removed(`${result.removed} variable${result.removed === 1 ? "" : "s"}`));
            router.refresh();
          });
        }}
      />
    </div>
  );
}
