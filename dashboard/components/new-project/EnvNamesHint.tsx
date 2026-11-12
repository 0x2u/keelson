"use client";

/**
 * The names of the variables the repository's example environment file lists, as a reminder above the variables form.
 * Names only: a value is the operator's to give, and nothing here is added for them.
 */
export function EnvNamesHint({ names, already }: { names: string[]; already: string[] }) {
  const missing = names.filter((n) => !already.includes(n));
  if (missing.length === 0) return null;
  return (
    <div className="rounded-lg border p-4 text-sm" data-testid="env-names-hint">
      <p className="font-medium">The repository&apos;s example environment file lists {missing.length === 1 ? "a variable" : `${missing.length} variables`}</p>
      <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{missing.join(", ")}</p>
      <p className="mt-2 text-xs text-muted-foreground">Add the ones the app needs, below. Nothing is added for you: the values are yours to give.</p>
    </div>
  );
}
