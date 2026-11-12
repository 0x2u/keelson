import Link from "next/link";
import { ChevronRightIcon, CloudIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import type { ComponentType, ReactNode } from "react";
import { StatusDot } from "@/components/status";
import { INLINE_LINK, InlineLink, PageSection, TableCard } from "@/components/layout";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { notificationsHref } from "@/lib/redirects-core";
import { notificationStatus, type NotificationState, type SettingsCard, type SettingsStatus } from "@/lib/settings-core";

const ICON: Record<SettingsCard["id"], ComponentType<{ className?: string }>> = {
  security: ICONS.security,
  backup: ICONS.backup,
  "api-tokens": ICONS.secret,
  github: ICONS.source,
  cloudflare: CloudIcon,
};

export interface ServerNotifications {
  id: string;
  name: string;
  state: NotificationState;
}

/** A status as a dot and a sentence that wraps: the sentences here can be long, and the colour is never the only carrier. */
function StatusLine({ status }: { status: SettingsStatus }) {
  return (
    <p className="flex min-w-0 items-start gap-2 text-sm">
      <StatusDot tone={status.tone} className="mt-1.5" />
      <span className="min-w-0 break-words">{status.label}</span>
    </p>
  );
}

function SectionCard({ card }: { card: SettingsCard }) {
  const Icon = ICON[card.id];
  return (
    <Link
      href={card.href}
      data-card={card.id}
      className="group block min-w-0 rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Card className="h-full transition-colors group-hover:border-foreground/25">
        <CardHeader className="gap-2">
          <CardTitle className="flex items-center gap-2">
            <Icon aria-hidden className="size-4 text-muted-foreground" />
            {card.title}
            <ChevronRightIcon aria-hidden className="ml-auto size-4 text-muted-foreground" />
          </CardTitle>
          <CardDescription>{card.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusLine status={card.status} />
        </CardContent>
      </Card>
    </Link>
  );
}

/** What this dashboard is: its version, the agent it carries, and the release notes when the version is a published tag. */
export interface AboutInfo {
  version: string;
  agent: string | null;
  releaseNotes: string | null;
}

/**
 * The settings index: every section of the dashboard's own settings as a card with where it stands, then the
 * notifications of each server (they live on the server's configuration, so each links there).
 */
export function SettingsIndex({
  cards,
  notifications,
  about,
  release,
}: {
  cards: SettingsCard[];
  notifications: ServerNotifications[];
  about: AboutInfo;
  /** The latest release and the update command (it waits for GitHub, so the page wraps it in Suspense). */
  release?: ReactNode;
}) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="settings-sections" className="space-y-3">
        <h2 id="settings-sections" className="sr-only">
          Sections
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {cards.map((card) => (
            <SectionCard key={card.id} card={card} />
          ))}
        </div>
      </section>

      <PageSection id="settings-notifications" title="Notifications">
        <p className="text-sm text-muted-foreground">Where each server reports deployments, apps going down and failing jobs. Set per server.</p>
        {notifications.length === 0 ? (
          <div data-testid="notifications-empty">
            <EmptyState
              bordered
              compact
              icon={ICONS.notification}
              title="No servers yet"
              action={
                <Button asChild size="sm">
                  <Link href="/servers/new">Add a server</Link>
                </Button>
              }
            >
              Notifications are configured on each server once it is added.
            </EmptyState>
          </div>
        ) : (
          <TableCard>
            <ul className="divide-y" data-testid="notifications">
              {notifications.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4" data-server={s.id}>
                  <InlineLink href={notificationsHref(s.id)} className="text-sm">
                    {s.name}
                  </InlineLink>
                  <StatusLine status={notificationStatus(s.state)} />
                </li>
              ))}
            </ul>
          </TableCard>
        )}
      </PageSection>

      <PageSection id="settings-about" title="About">
        <dl className="grid gap-1 text-sm" data-testid="about">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Keelson</dt>
            <dd className="font-mono">
              {about.version}
              {about.releaseNotes && (
                <>
                  {" · "}
                  <a href={about.releaseNotes} target="_blank" rel="noreferrer noopener" className={`${INLINE_LINK} font-sans`}>
                    Release notes
                  </a>
                </>
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Agent it installs on servers</dt>
            <dd className="font-mono">{about.agent ?? "none"}</dd>
          </div>
        </dl>
        {release}
      </PageSection>
    </div>
  );
}
