"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

// The project the page being shown belongs to, as its own breadcrumb says (Projects > shop > ...): a page of a server's
// entity (an app, a job, a deployment...) that a project owns lights Projects in the sidebar, not Servers. The page knows
// the owner, the sidebar (a layout that stays mounted between pages) does not: the page's header tells it. Until it has,
// the sidebar falls back to what the path says, which is never wrong, only less specific.

interface Owner {
  project: string | null;
  setProject: (project: string | null) => void;
}

const OwnerContext = createContext<Owner>({ project: null, setProject: () => {} });

export function ShellOwnerProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<string | null>(null);
  const value = useMemo(() => ({ project, setProject }), [project]);
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

/** The project the current page belongs to, or null. */
export function useShellOwner(): string | null {
  return useContext(OwnerContext).project;
}

/** Rendered by a page's header: tells the shell which project owns the page. Draws nothing, and lets go when the page goes. */
export function ShellOwner({ project }: { project: string }) {
  const { setProject } = useContext(OwnerContext);
  useLayoutEffect(() => {
    setProject(project);
    return () => setProject(null);
  }, [project, setProject]);
  return null;
}
