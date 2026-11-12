import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

/**
 * "Variables changed since the running version": shown from the moment a managed variable is saved until the next
 * deployment that started after it. Plain props so it renders without an agent; the page it links to says when (`href`: the
 * project's Variables tab for an app of a project, the app's own page otherwise).
 */
export function EnvChangedBadge({ serverId, app, href }: { serverId: string; app: string; href?: string }) {
  return (
    <Badge variant="warning" asChild>
      <Link
        href={href ?? `/servers/${serverId}/apps/${encodeURIComponent(app)}/environment`}
        title="The variables of this app were changed after the running version was deployed. Deploy to apply them."
      >
        <ICONS.variables />
        Variables changed since the running version
      </Link>
    </Badge>
  );
}
