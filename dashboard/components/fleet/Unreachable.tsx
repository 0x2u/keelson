import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/states";
import { cantTell } from "@/lib/attention-core";

export interface Unanswered {
  id: string;
  name: string;
  reason?: string;
}

/**
 * Stands where an empty state would: when a server did not answer, "nothing here" is not known, so the page says it
 * cannot tell, names the server and the reason, and points to the way to look into it.
 */
export function CantTell({ servers, what }: { servers: Unanswered[]; what: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full border bg-muted text-muted-foreground">
        <TriangleAlertIcon className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{cantTell(servers)}</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          {what} cannot be listed until {servers.length === 1 ? "it answers" : "they answer"}, so there may well be some.{" "}
          {servers.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <Link href={`/servers/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                Open {s.name}
              </Link>
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

/** Above data that is there for the servers that answered: whose part is missing, and why. */
export function UnansweredNotice({ servers, what }: { servers: Unanswered[]; what: string }) {
  if (servers.length === 0) return null;
  return (
    <Notice tone="warning" title={cantTell(servers)}>
      {what}: the part on {servers.length === 1 ? "that server" : "those servers"} is missing from this view until {servers.length === 1 ? "it answers" : "they answer"}; the other servers are shown as they are.
    </Notice>
  );
}
