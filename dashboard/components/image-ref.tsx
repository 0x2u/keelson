import { cn } from "@/lib/utils";
import { middleTruncate, splitRef } from "@/lib/image-ref-core";
import { CopyButton } from "@/components/copy-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An image reference you can read: the repository, cut in the middle when long, and the tag (or the short digest) in a
 * chip that is never cut. The whole reference is in the tooltip and behind the copy button.
 */
export function ImageRef({
  value,
  copy = true,
  serving,
  className,
}: {
  value: string;
  copy?: boolean;
  /** Marks the version that serves now. */
  serving?: boolean;
  className?: string;
}) {
  const { repository, tag, digest } = splitRef(value);
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1 align-middle", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 rounded-sm font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0 truncate" aria-label={repository}>
              {middleTruncate(repository)}
            </span>
            <VersionChip tag={tag} digest={digest} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md font-mono text-xs break-all">{value}</TooltipContent>
      </Tooltip>
      {serving && <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-success">serving</span>}
      {copy && <CopyButton value={value} label="Copy image reference" />}
    </span>
  );
}

/** The tag, or the short digest, as a chip. A reference with neither runs `latest`. */
export function VersionChip({ tag, digest, className }: { tag?: string; digest?: string; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] leading-none", className)}>
      {tag ?? (digest ? `@${digest}` : "latest")}
      {tag !== undefined && digest !== undefined && <span className="text-muted-foreground">@{digest}</span>}
    </span>
  );
}

/** The version an image reference names, as a chip that is never cut (the whole reference on hover). */
export function VersionTag({ image, className }: { image: string; className?: string }) {
  const { tag, digest } = splitRef(image);
  return (
    <span title={image} className={cn("inline-block max-w-full align-middle", className)}>
      <VersionChip tag={tag} digest={digest} />
    </span>
  );
}
