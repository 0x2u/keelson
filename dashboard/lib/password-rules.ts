// What a new admin password must satisfy. No imports: the setup form (a client component) checks it as you type, the setup
// action checks it again, and scripts/hash-password.ts applies it outside Next.

export const MIN_PASSWORD_LENGTH = 12;

/** What is wrong with a new password, in words for the person typing it, or null when it is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length === 0) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters (${password.length} so far)`;
  return null;
}
