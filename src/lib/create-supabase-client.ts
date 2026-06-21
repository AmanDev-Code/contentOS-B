import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type CreateSupabaseClientOptions = NonNullable<
  Parameters<typeof createClient>[2]
>;

export function createSupabaseClient(
  url: string,
  key: string,
  options?: CreateSupabaseClientOptions,
): SupabaseClient {
  return createClient(url, key, options) as SupabaseClient;
}
