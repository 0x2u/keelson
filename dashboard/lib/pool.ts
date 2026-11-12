/**
 * Runs `fn` over `items` with at most `limit` calls in flight, and returns the results in the order of the items. `fn` is
 * expected to settle with a value (turn a failure into one): a rejection ends the run, as it would in `Promise.all`.
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
