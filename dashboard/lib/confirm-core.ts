/** Whether the typed text confirms: exactly the required name when one is required, always otherwise. */
export function confirmEnabled({ typed, required, pending }: { typed: string; required?: string; pending?: boolean }): boolean {
  if (pending) return false;
  return required === undefined || typed === required;
}
