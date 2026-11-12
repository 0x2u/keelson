"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";
import { DisabledWithReason, GatedButton } from "@/components/GatedButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ICONS } from "@/lib/icons";
import { addAppFromServerHref, newAppOnServerHref } from "@/lib/project-actions-core";
import { soleServer, type ServerChoice } from "@/lib/project-lifecycle-core";
import { ChoiceList, type Choice } from "@/components/projects/ChoiceList";
import { useIntentDialog } from "@/components/projects/useIntentDialog";

/** What "Add app" asks for: the server, from a project (its Apps tab), or the project, from a server (its Overview). */
export type AddAppTarget = { kind: "server"; project: string; choices: ServerChoice[] } | { kind: "project"; serverId: string; serverName: string; canDeploy: boolean; projects: string[] };

const NEW_PROJECT = "\0new";

type ButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size">;

/**
 * The one "Add app" of the project: from a project, which server the app runs on (its own servers first; a link to the form
 * when only one server can take it); from a server, which project it belongs to (an existing one, or a new one). Either way
 * it ends at the same form of a new app, and comes back to the project's Apps tab.
 */
export function AddAppButton({ target, intent = false, variant = "default", size }: { target: AddAppTarget; intent?: boolean } & ButtonProps) {
  const [open, setOpen] = useIntentDialog(intent);
  const button = { variant, size };

  if (target.kind === "server") {
    const sole = soleServer(target.choices);
    if (sole !== null) {
      return (
        <Button asChild {...button}>
          <Link href={newAppOnServerHref(sole.id, target.project)}>
            <ICONS.add />
            Add app
          </Link>
        </Button>
      );
    }
    if (target.choices.every((c) => !c.enabled)) {
      return (
        <DisabledWithReason reason={target.choices[0]?.reason ?? "No server can run apps yet"}>
          <Button {...button} disabled aria-disabled>
            <ICONS.add />
            Add app
          </Button>
        </DisabledWithReason>
      );
    }
  } else if (!target.canDeploy) {
    return (
      <GatedButton canDeploy={false} {...button}>
        <ICONS.add />
        Add app
      </GatedButton>
    );
  } else if (target.projects.length === 0) {
    return (
      <Button asChild {...button}>
        <Link href={addAppFromServerHref(target.serverId, null)}>
          <ICONS.add />
          Add app
        </Link>
      </Button>
    );
  }

  return (
    <>
      <Button type="button" {...button} onClick={() => setOpen(true)}>
        <ICONS.add />
        Add app
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <AddAppPicker target={target} onContinue={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddAppPicker({ target, onContinue }: { target: AddAppTarget; onContinue: () => void }) {
  const firstServer = target.kind === "server" ? target.choices.find((c) => c.enabled)?.id : undefined;
  const [picked, setPicked] = useState(firstServer ?? "");

  let choices: Choice[];
  let href: string | null;
  if (target.kind === "server") {
    choices = target.choices.map((c) => ({ value: c.id, label: c.name, disabled: !c.enabled, detail: c.enabled ? (c.inProject ? `Already runs apps of ${target.project}` : undefined) : c.reason }));
    href = picked === "" ? null : newAppOnServerHref(picked, target.project);
  } else {
    choices = [...target.projects.map((p): Choice => ({ value: p, label: p })), { value: NEW_PROJECT, label: "New project", detail: "Starts a project of its own, from an image or a repository" }];
    href = picked === "" ? null : addAppFromServerHref(target.serverId, picked === NEW_PROJECT ? null : picked);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{target.kind === "server" ? `Add app to ${target.project}` : `Add app on ${target.serverName}`}</DialogTitle>
        <DialogDescription>{target.kind === "server" ? "Choose the server it runs on." : "Choose the project it belongs to."}</DialogDescription>
      </DialogHeader>
      <ChoiceList id="add-app-choice" label={target.kind === "server" ? "Server" : "Project"} choices={choices} value={picked} onChange={setPicked} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onContinue}>
          Cancel
        </Button>
        {href === null ? (
          <Button type="button" disabled>
            Continue
          </Button>
        ) : (
          <Button asChild>
            <Link href={href} onClick={onContinue}>
              Continue
            </Link>
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
