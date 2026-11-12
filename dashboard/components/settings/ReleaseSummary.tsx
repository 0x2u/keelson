import { CheckNowButton } from "@/components/settings/CheckNowButton";
import { INLINE_LINK, InlineLink } from "@/components/layout";
import { RelativeTime } from "@/components/relative-time";
import { CodeBlock } from "@/components/servers/install-outcome";
import { Notice } from "@/components/states";
import { releaseCheck } from "@/lib/release-check";
import { updateCommand, type ReleaseCheck } from "@/lib/release-check-core";

const STATUS_TEXT = {
  newer: "newer than this dashboard",
  current: "this dashboard is up to date",
  ahead: "this dashboard is a newer or custom build",
  unknown: "",
} as const;

/** What the dashboard asks and what it sends, said where the operator decides about it. */
function Privacy({ enabled }: { enabled: boolean }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="release-privacy">
      {enabled ? (
        <>
          Once a day, and when you press Check now, this dashboard asks <span className="font-mono">api.github.com</span> for the latest release. The request carries no data about your servers or projects, only your address and this
          version. To stop it, set <span className="font-mono">KEELSON_UPDATE_CHECK=off</span> in <span className="font-mono">dashboard.env</span> beside <span className="font-mono">compose.yaml</span> and run{" "}
          <span className="font-mono">docker compose up -d</span> there.
        </>
      ) : (
        <>
          The update check is off: this dashboard makes no request to find newer releases. To turn it on, remove <span className="font-mono">KEELSON_UPDATE_CHECK=off</span> from <span className="font-mono">dashboard.env</span> beside{" "}
          <span className="font-mono">compose.yaml</span> and run <span className="font-mono">docker compose up -d</span> there. It then asks <span className="font-mono">api.github.com</span> once a day, with no data about your
          servers.
        </>
      )}
    </p>
  );
}

/** The three steps of an update, in order, with the command that does the second. */
export function UpdateSteps({ tag }: { tag: string }) {
  return (
    <ol className="list-decimal space-y-3 pl-5 text-sm" data-testid="update-steps">
      <li>
        Back up the dashboard: download a copy in{" "}
        <InlineLink href="/settings/backup">Settings, Backup</InlineLink>.
      </li>
      <li className="space-y-2">
        <p>Update the dashboard: run this on the machine that hosts it. It keeps your data, master key, settings and domain.</p>
        <div className="w-0 min-w-full">
          <CodeBlock value={updateCommand(tag)} label="Copy the update command" />
        </div>
      </li>
      <li>Update the agent of each server from its Update page, once the dashboard runs the new version.</li>
    </ol>
  );
}

/** The latest release and how this dashboard stands against it. Pure: `ReleaseStatus` supplies the check. */
export function ReleaseSummary({ check }: { check: ReleaseCheck }) {
  if (!check.enabled) {
    return (
      <div className="space-y-2" data-testid="release">
        <p className="text-sm text-muted-foreground">Update check: off</p>
        <Privacy enabled={false} />
      </div>
    );
  }
  const { latest } = check;
  return (
    <div className="space-y-3" data-testid="release">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <p className="flex flex-wrap gap-x-2">
          <span className="text-muted-foreground">Latest release</span>
          {latest ? (
            <span>
              <a href={latest.url} target="_blank" rel="noreferrer noopener" className={`${INLINE_LINK} font-mono`}>
                {latest.tag}
              </a>
              {STATUS_TEXT[check.status] && <span className="text-muted-foreground">{` · ${STATUS_TEXT[check.status]}`}</span>}
            </span>
          ) : (
            <span className="text-muted-foreground">{check.failed ? "unknown" : "none published yet"}</span>
          )}
        </p>
        <CheckNowButton />
      </div>
      {check.failed && (
        <p className="text-sm text-destructive" role="status" data-testid="release-failed">
          Could not check: GitHub did not answer. The dashboard tries again in an hour{latest ? ", the release above is from an earlier check" : ""}.
        </p>
      )}
      {check.checkedAt !== null && !check.failed && (
        <p className="text-xs text-muted-foreground">
          Checked <RelativeTime at={check.checkedAt} />
        </p>
      )}
      {check.status === "newer" && latest && (
        <Notice tone="info" title={`Update available: ${latest.tag}`}>
          <UpdateSteps tag={latest.tag} />
        </Notice>
      )}
      <Privacy enabled />
    </div>
  );
}

/** The release part of the About section: awaits the check (cached for a day, so this is slow only after a restart). */
export async function ReleaseStatus() {
  return <ReleaseSummary check={await releaseCheck()} />;
}
