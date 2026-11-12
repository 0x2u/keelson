"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { saveNotificationsDefaultAction } from "@/app/notifications-actions";
import { DurationField } from "@/components/config/FormParts";
import { CheckboxField, FieldShell, SwitchField, TextField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ICONS } from "@/lib/icons";
import {
  draftOfTemplate,
  TEMPLATE_EVENTS_HELP,
  KNOWN_EVENTS,
  MAX_WEBHOOK_SLOTS,
  templateOfDraft,
  type NotificationsTemplate,
  type TemplateDraft,
  type TemplateErrors,
} from "@/lib/notifications-core";

/**
 * Edits the default: the non-secret settings the operator applies to servers. Saving changes nothing on any server. Webhook
 * URLs are not here at all (they are secrets, asked for when the default is applied); only the path of each signing-secret
 * file is, and the path of the Telegram bot token file: the files themselves stay on the servers.
 */
export function DefaultDialog({ template, onClose }: { template: NotificationsTemplate | null; onClose: () => void }) {
  const router = useRouter();
  const base = useId();
  const [draft, setDraft] = useState<TemplateDraft>(() => draftOfTemplate(template));
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<TemplateErrors>({});

  const parsed = templateOfDraft(draft);
  const errors: TemplateErrors = parsed.ok ? {} : parsed.errors;
  const shown = (field: string): string | undefined => (submitted ? (serverErrors[field] ?? errors[field]) : undefined);
  const id = (field: string) => `${base}-${field}`;
  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function close(next: boolean) {
    if (!next && !pending) onClose();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed.ok) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await saveNotificationsDefaultAction(parsed.template);
      if (result.ok) {
        toast.success("Saved the default");
        onClose();
        router.refresh();
      } else {
        setServerErrors(result.errors);
      }
    } catch {
      setFailure("The request failed before the dashboard answered. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const problems = submitted ? Object.keys({ ...errors, ...serverErrors }).length : 0;

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form noValidate onSubmit={(e) => void save(e)} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Default for new and existing servers</DialogTitle>
            <DialogDescription>
              A template, not a setting: saving it changes nothing on any server. You apply it to the servers you choose, and each server&apos;s own file stays the truth.
            </DialogDescription>
          </DialogHeader>

          {failure !== null && <Notice title="Not saved">{failure}</Notice>}
          {problems > 0 && <Notice title="Not saved yet">{problems === 1 ? "One field needs attention." : `${problems} fields need attention.`}</Notice>}

          <FieldShell id={id("events")} label="Events" group help={TEMPLATE_EVENTS_HELP} error={shown("events")}>
            <div className="grid gap-3 sm:grid-cols-2">
              {KNOWN_EVENTS.map((event) => (
                <CheckboxField
                  key={event.value}
                  id={id(`event-${event.value}`)}
                  label={event.label}
                  help={<span className="font-mono">{event.value}</span>}
                  checked={draft.events.includes(event.value)}
                  onChange={(checked) => set("events", checked ? [...draft.events, event.value] : draft.events.filter((e) => e !== event.value))}
                />
              ))}
            </div>
          </FieldShell>

          <div className="grid gap-5 sm:grid-cols-3">
            <TextField
              id={id("disk")}
              label="Disk full at (%)"
              help="Between 6 and 100."
              error={shown("diskPercent")}
              value={draft.diskPercent}
              onChange={(v) => set("diskPercent", v)}
              inputMode="numeric"
              mono
            />
            <TextField
              id={id("memory")}
              label="Memory low under (%)"
              help="Between 1 and 95."
              error={shown("memoryPercent")}
              value={draft.memoryPercent}
              onChange={(v) => set("memoryPercent", v)}
              inputMode="numeric"
              mono
            />
            <DurationField id={id("cooldown")} label="Alert cooldown" error={shown("cooldown")} value={draft.cooldown} onChange={(v) => set("cooldown", v)} placeholder="5m" />
          </div>

          <div className="space-y-4">
            <SwitchField
              id={id("telegram")}
              label="Expect Telegram"
              help="A server without this chat shows as differing. The bot token is a file on each server: only its path is shared here."
              checked={draft.telegram}
              onChange={(v) => set("telegram", v)}
            />
            {draft.telegram && (
              <div className="grid gap-5 sm:grid-cols-2">
                <TextField
                  id={id("bot-token-file")}
                  label="Bot token file"
                  help="Path on each server."
                  error={shown("botTokenFile")}
                  value={draft.botTokenFile}
                  onChange={(v) => set("botTokenFile", v)}
                  placeholder="/etc/keelson/telegram.token"
                  mono
                />
                <TextField id={id("chat-id")} label="Chat id" error={shown("chatId")} value={draft.chatId} onChange={(v) => set("chatId", v)} placeholder="-1001234567890" mono />
                <TextField
                  id={id("api-url")}
                  label="API URL"
                  optional
                  help="Leave empty for the public Telegram API."
                  error={shown("apiUrl")}
                  value={draft.apiUrl}
                  onChange={(v) => set("apiUrl", v)}
                  placeholder="https://api.telegram.org"
                  mono
                />
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Webhooks</p>
              <p className="text-xs text-muted-foreground">
                Each one is a slot every server is expected to have. The URLs are secrets: you type them when you apply the default, they are never kept here. Only the path of the file
                that signs each request is.
              </p>
            </div>
            {draft.webhookSecretFiles.length === 0 && <p className="text-sm text-muted-foreground">No webhook expected.</p>}
            {draft.webhookSecretFiles.map((file, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <TextField
                    id={id(`webhook-${i}`)}
                    label={`Webhook ${i + 1}: signing secret file`}
                    optional
                    help="Path on each server. Leave empty for an unsigned webhook."
                    error={shown(`webhook.${i}`)}
                    value={file}
                    onChange={(v) =>
                      set(
                        "webhookSecretFiles",
                        draft.webhookSecretFiles.map((f, j) => (j === i ? v : f)),
                      )
                    }
                    placeholder="/etc/keelson/webhook.secret"
                    mono
                  />
                </div>
                <Button type="button" variant="ghost" size="icon-sm" className="mt-6" aria-label={`Remove webhook ${i + 1}`} onClick={() => set("webhookSecretFiles", draft.webhookSecretFiles.filter((_, j) => j !== i))}>
                  <ICONS.remove />
                </Button>
              </div>
            ))}
            {shown("webhooks") && <p className="text-xs font-medium text-destructive-text">{shown("webhooks")}</p>}
            <Button type="button" variant="outline" size="sm" disabled={draft.webhookSecretFiles.length >= MAX_WEBHOOK_SLOTS} onClick={() => set("webhookSecretFiles", [...draft.webhookSecretFiles, ""])}>
              <ICONS.add />
              Add webhook
            </Button>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save the default
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
