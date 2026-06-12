import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { SupabaseService } from './supabase.service';

const SUPPORTED_EVENTS = [
  'post.published',
  'post.failed',
  'post.scheduled',
  'post.cancelled',
] as const;
export type WebhookEventType = (typeof SUPPORTED_EVENTS)[number];

export interface WebhookRow {
  id: string;
  user_id: string;
  url: string;
  vault_secret_id: string;
  events: string[];
  enabled: boolean;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  id: number;
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  request_signature: string | null;
  attempt: number;
  status: 'pending' | 'succeeded' | 'failed' | 'dead_letter';
  response_status_code: number | null;
  response_body_truncated: string | null;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface CreateWebhookDto {
  url: string;
  events?: string[];
  description?: string;
  enabled?: boolean;
}

export interface UpdateWebhookDto {
  url?: string;
  events?: string[];
  description?: string;
  enabled?: boolean;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^::1$/,
  /^::$/,
];

@Injectable()
export class OutboundWebhookService {
  private readonly logger = new Logger(OutboundWebhookService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async create(userId: string, dto: CreateWebhookDto): Promise<WebhookRow> {
    this.validateUrl(dto.url);
    this.validateEvents(dto.events);

    const secret = randomBytes(32).toString('hex');
    const client = this.supabase.getServiceClient();

    const { data: secretId, error: vaultErr } = await client.rpc(
      'trndinn_vault_create_secret',
      {
        p_secret: secret,
        p_name: `webhook:${userId}:${Date.now()}`,
        p_description: 'Outbound webhook HMAC signing secret',
      },
    );
    if (vaultErr || typeof secretId !== 'string') {
      throw new Error(
        `Vault create_secret failed: ${vaultErr?.message ?? 'no id returned'}`,
      );
    }

    const { data, error } = await client
      .from('webhooks')
      .insert({
        user_id: userId,
        url: dto.url,
        vault_secret_id: secretId,
        events: dto.events ?? [...SUPPORTED_EVENTS],
        enabled: dto.enabled ?? true,
        description: dto.description ?? null,
      })
      .select('*')
      .single();

    if (error) {
      await this.deleteVaultSecretSafe(secretId);
      throw new Error(`Failed to create webhook: ${error.message}`);
    }

    return data as WebhookRow;
  }

  async list(userId: string): Promise<WebhookRow[]> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('webhooks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Failed to list webhooks: ${error.message}`);
    return (data ?? []) as WebhookRow[];
  }

  async getById(userId: string, webhookId: string): Promise<WebhookRow | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('webhooks')
      .select('*')
      .eq('id', webhookId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to get webhook: ${error.message}`);
    return data as WebhookRow | null;
  }

  async update(
    userId: string,
    webhookId: string,
    dto: UpdateWebhookDto,
  ): Promise<WebhookRow> {
    if (dto.url) this.validateUrl(dto.url);
    if (dto.events) this.validateEvents(dto.events);

    const client = this.supabase.getServiceClient();
    const updatePayload: Record<string, unknown> = {};
    if (dto.url !== undefined) updatePayload.url = dto.url;
    if (dto.events !== undefined) updatePayload.events = dto.events;
    if (dto.description !== undefined) updatePayload.description = dto.description;
    if (dto.enabled !== undefined) updatePayload.enabled = dto.enabled;

    const { data, error } = await client
      .from('webhooks')
      .update(updatePayload)
      .eq('id', webhookId)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`Failed to update webhook: ${error.message}`);
    return data as WebhookRow;
  }

  async delete(userId: string, webhookId: string): Promise<void> {
    const client = this.supabase.getServiceClient();
    const existing = await this.getById(userId, webhookId);
    if (!existing) return;

    const { error } = await client
      .from('webhooks')
      .delete()
      .eq('id', webhookId)
      .eq('user_id', userId);
    if (error) throw new Error(`Failed to delete webhook: ${error.message}`);

    await this.deleteVaultSecretSafe(existing.vault_secret_id);
  }

  async getEnabledWebhooksForEvent(
    userId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookRow[]> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('webhooks')
      .select('*')
      .eq('user_id', userId)
      .eq('enabled', true)
      .contains('events', [eventType]);
    if (error) {
      this.logger.warn(`Failed to fetch webhooks for event: ${error.message}`);
      return [];
    }
    return (data ?? []) as WebhookRow[];
  }

  async readWebhookSecret(vaultSecretId: string): Promise<string | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client.rpc('trndinn_vault_read_secret', {
      p_id: vaultSecretId,
    });
    if (error) {
      this.logger.warn(`Vault read_secret failed: ${error.message}`);
      return null;
    }
    return typeof data === 'string' ? data : null;
  }

  signPayload(payload: string, secret: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload, 'utf8');
    return `sha256=${hmac.digest('hex')}`;
  }

  verifySignature(payload: string, secret: string, signature: string): boolean {
    const expected = this.signPayload(payload, secret);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async recordDelivery(params: {
    webhookId: string;
    eventType: string;
    payload: Record<string, unknown>;
    signature: string;
    attempt: number;
    status: 'pending' | 'succeeded' | 'failed' | 'dead_letter';
    responseStatusCode?: number;
    responseBodyTruncated?: string;
    nextRetryAt?: Date;
    deliveredAt?: Date;
  }): Promise<number> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('webhook_deliveries')
      .insert({
        webhook_id: params.webhookId,
        event_type: params.eventType,
        payload: params.payload,
        request_signature: params.signature,
        attempt: params.attempt,
        status: params.status,
        response_status_code: params.responseStatusCode ?? null,
        response_body_truncated: params.responseBodyTruncated
          ? params.responseBodyTruncated.slice(0, 4096)
          : null,
        next_retry_at: params.nextRetryAt?.toISOString() ?? null,
        delivered_at: params.deliveredAt?.toISOString() ?? null,
      })
      .select('id')
      .single();
    if (error) {
      this.logger.warn(`Failed to record delivery: ${error.message}`);
      return -1;
    }
    return (data as { id: number }).id;
  }

  async listDeliveries(
    userId: string,
    webhookId: string,
    limit = 50,
  ): Promise<WebhookDeliveryRow[]> {
    const webhook = await this.getById(userId, webhookId);
    if (!webhook) return [];

    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('webhook_deliveries')
      .select('*')
      .eq('webhook_id', webhookId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to list deliveries: ${error.message}`);
    return (data ?? []) as WebhookDeliveryRow[];
  }

  static getSupportedEvents(): readonly string[] {
    return SUPPORTED_EVENTS;
  }

  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid webhook URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Webhook URL must use http or https.');
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local')
    ) {
      throw new Error(
        'Webhook URL must not target localhost or private hosts.',
      );
    }
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(host)) {
        throw new Error(
          'Webhook URL must not target private or reserved IP addresses.',
        );
      }
    }
  }

  private validateEvents(events?: string[]): void {
    if (!events) return;
    for (const evt of events) {
      if (!SUPPORTED_EVENTS.includes(evt as WebhookEventType)) {
        throw new Error(
          `Unsupported event type: ${evt}. Supported: ${SUPPORTED_EVENTS.join(', ')}`,
        );
      }
    }
  }

  private async deleteVaultSecretSafe(id: string): Promise<void> {
    try {
      const client = this.supabase.getServiceClient();
      const { error } = await client.rpc('trndinn_vault_delete_secret', {
        p_id: id,
      });
      if (error) {
        this.logger.warn(`Vault delete_secret failed for ${id}: ${error.message}`);
      }
    } catch (err) {
      this.logger.warn(`Vault delete_secret threw for ${id}: ${String(err)}`);
    }
  }
}
