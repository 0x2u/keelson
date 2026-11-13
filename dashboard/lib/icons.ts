import {
  ActivityIcon,
  ArchiveIcon,
  BellIcon,
  BoxIcon,
  CalendarClockIcon,
  ClipboardCheckIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  HammerIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutDashboardIcon,
  PencilIcon,
  PlusIcon,
  RocketIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  Undo2Icon,
  VariableIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * One icon per concept, so the sidebar, the command palette, empty states and buttons draw the same thing the same way.
 * Pick the icon from here by concept; do not import a Lucide icon for one of these concepts directly.
 */
export const ICONS = {
  home: LayoutDashboardIcon,
  /** A project: the group of apps, jobs and databases. */
  project: LayersIcon,
  server: ServerIcon,
  app: RocketIcon,
  container: BoxIcon,
  /** A scheduled job, its schedule and its runs. */
  job: CalendarClockIcon,
  database: DatabaseIcon,
  domain: GlobeIcon,
  /** The activity feed: what happened, newest first. */
  activity: ActivityIcon,
  /** How the fleet delivers: the four measures of DORA over a window. */
  delivery: GaugeIcon,
  /** Version history of a file, a configuration or a variable set. */
  history: HistoryIcon,
  /** The audit log of a server. */
  audit: ScrollTextIcon,
  /** The YAML-backed definition of an app, job or database ("Edit configuration"). */
  configuration: SlidersHorizontalIcon,
  /** Keelson's own connection and account settings ("Settings"). */
  settings: SettingsIcon,
  /** The stored, write-only variables of an app. */
  variables: VariableIcon,
  /** A secret: token, key, password. */
  secret: KeyRoundIcon,
  security: ShieldCheckIcon,
  /** The readiness checklist: whether something can be trusted, not only whether it runs. */
  readiness: ClipboardCheckIcon,
  source: GitBranchIcon,
  build: HammerIcon,
  deploy: RocketIcon,
  rollback: Undo2Icon,
  backup: ArchiveIcon,
  notification: BellIcon,
  resources: CpuIcon,
  add: PlusIcon,
  edit: PencilIcon,
  remove: Trash2Icon,
} as const satisfies Record<string, LucideIcon>;

export type Concept = keyof typeof ICONS;
