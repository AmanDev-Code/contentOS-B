/**
 * Single definition of “platform admin” for API authorization.
 * Keep in sync with frontend `useAdmin` / `NEXT_PUBLIC_ADMIN_*`.
 */
const DEFAULT_ADMIN_USER_ID = 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
const DEFAULT_ADMIN_EMAIL = 'amanahuja@gmail.com';

export function isPlatformAdmin(user: { id: string; email?: string }): boolean {
  const adminUserId = process.env.ADMIN_USER_ID || DEFAULT_ADMIN_USER_ID;
  const adminEmail = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  return user.id === adminUserId || user.email === adminEmail;
}
