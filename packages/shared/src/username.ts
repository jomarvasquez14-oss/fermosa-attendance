import { USERNAME_EMAIL_DOMAIN } from './constants';

/**
 * Map a login identifier to the email Supabase Auth stores internally.
 *
 * Employees sign in with a plain username (many have no email address); it
 * becomes `<username>@<USERNAME_EMAIL_DOMAIN>` under the hood. A value that
 * already contains "@" is treated as a real email and returned as-is (lowercased),
 * so accounts created with real emails keep working with no migration.
 */
export function usernameToEmail(input: string): string {
  const v = input.trim().toLowerCase();
  if (!v) return v;
  if (v.includes('@')) return v;
  return `${v}@${USERNAME_EMAIL_DOMAIN}`;
}
