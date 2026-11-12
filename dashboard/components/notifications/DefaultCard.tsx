import { RelativeTime } from "@/components/relative-time";
import { DefinitionItem, DefinitionList } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ICONS } from "@/lib/icons";
import { channelLabel, DEFAULT_EVENTS, type NotificationsTemplate } from "@/lib/notifications-core";

/** What the default says, in a few words each. */
function Summary({ template }: { template: NotificationsTemplate }) {
  const events = template.events.length === 0 ? `Agent default (${DEFAULT_EVENTS.length})` : `${template.events.length} ${template.events.length === 1 ? "event" : "events"}`;
  const channels = channelLabel({ telegram: template.telegram !== null, webhooks: template.webhooks.length, heartbeat: false });
  return (
    <DefinitionList className="lg:grid-cols-4">
      <DefinitionItem label="Events">{events}</DefinitionItem>
      <DefinitionItem label="Thresholds">
        Disk {template.diskPercent}% · memory {template.memoryPercent}% · cooldown {template.cooldown}
      </DefinitionItem>
      <DefinitionItem label="Channels expected">{channels}</DefinitionItem>
      <DefinitionItem label="Telegram chat">{template.telegram ? <span className="font-mono text-xs">{template.telegram.chatId}</span> : <span className="text-muted-foreground">Not expected</span>}</DefinitionItem>
    </DefinitionList>
  );
}

/**
 * The top of the page: the default, a template the operator applies on demand. It is not desired state (each server's file on its
 * agent is), so the card says what following it means and how many servers do.
 */
export function DefaultCard({
  template,
  updatedAt,
  following,
  differing,
  onEdit,
}: {
  template: NotificationsTemplate | null;
  updatedAt: number | null;
  /** Servers that were read and match the default, and that were read and do not. */
  following: number;
  differing: number;
  onEdit: () => void;
}) {
  return (
    <Card data-testid="notifications-default">
      <CardHeader>
        <CardTitle>Default for new and existing servers</CardTitle>
        <CardDescription>
          A template you apply on demand: saving it changes nothing by itself, each server&apos;s file on its agent stays the truth, and a server added later shows as differing until you apply it.
        </CardDescription>
        <CardAction>
          <Button type="button" variant={template === null ? "default" : "outline"} onClick={onEdit}>
            <ICONS.edit />
            {template === null ? "Set a default" : "Edit"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {template === null ? (
          <p className="text-sm text-muted-foreground">No default yet. Set one, then apply it to the servers you choose.</p>
        ) : (
          <>
            <Summary template={template} />
            <p className="text-sm text-muted-foreground" data-testid="default-status">
              {differing === 0 ? `${following} ${following === 1 ? "server follows" : "servers follow"} it` : `${following} follow it · ${differing} differ`}
              {updatedAt !== null && (
                <>
                  {" · saved "}
                  <RelativeTime at={updatedAt} />
                </>
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
