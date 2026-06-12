import ws from 'ws';
import {
  createClient,
  type SupabaseClient,
} from '@supabase/supabase-js';

const needsWsTransport = Number(process.versions.node.split('.')[0]) < 22;

const wsTransport = ws as unknown as typeof WebSocket;

type CreateSupabaseClientOptions = NonNullable<
  Parameters<typeof createClient>[2]
>;

export function createSupabaseClient(
  url: string,
  key: string,
  options?: CreateSupabaseClientOptions,
): SupabaseClient {
  return createClient(url, key, {
    ...options,
    realtime: {
      ...options?.realtime,
      ...(needsWsTransport ? { transport: wsTransport } : {}),
    },
  }) as SupabaseClient;
}
