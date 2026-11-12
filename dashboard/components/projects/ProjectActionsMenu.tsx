"use client";

import { EllipsisIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { RenameProjectDialog } from "@/components/projects/RenameProjectDialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ICONS } from "@/lib/icons";
import { addAppHref, addEnvironmentHref } from "@/lib/project-actions-core";

/**
 * What can be done to the project itself, in the hub's header: add an app or an environment, rename it. There is no "remove
 * project": a project is the label of its apps, so it goes when the last app does, which the menu says.
 */
export function ProjectActionsMenu({ project }: { project: string }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Project actions">
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem asChild>
            <Link href={addAppHref(project)}>
              <ICONS.add />
              Add app
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={addEnvironmentHref(project)}>
              <ICONS.add />
              Add environment
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <ICONS.edit />
            Rename project
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal whitespace-normal text-muted-foreground" data-testid="project-removal-note">
            A project exists as long as it has apps. Remove its apps ({"Edit app > Remove"}) and it disappears.
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameProjectDialog project={project} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
