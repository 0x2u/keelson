import { StatusDot } from "@/components/status";
import type { StreamStatus } from "@/components/useEventStream";
import type { StatusView } from "@/lib/status";

/** What the viewer of a stream should be told. A lost stream is never shown as live. */
export function connectionView(status: StreamStatus, reconnecting: boolean, visible: boolean): StatusView {
  if (!visible) return { tone: "muted", label: "Paused while this tab is hidden" };
  if (reconnecting) return { tone: "warning", label: "Reconnecting", live: true };
  switch (status) {
    case "connecting":
      return { tone: "warning", label: "Connecting", live: true };
    case "live":
      return { tone: "success", label: "Live", live: true };
    case "ended":
      return { tone: "muted", label: "Stream ended" };
    case "disconnected":
      return { tone: "danger", label: "Disconnected" };
  }
}

/**
 * The connection state of a stream: a dot and a word, in a polite live region so
 * screen readers hear the changes (the stream's own content is never announced).
 */
export function ConnectionState({ view, subject }: { view: StatusView; subject: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm">
      <StatusDot tone={view.tone} live={view.live} />
      <span className="sr-only">{subject}: </span>
      <span>{view.label}</span>
    </span>
  );
}
