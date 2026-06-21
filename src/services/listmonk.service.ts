import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ListmonkSubscriber {
  id?: number;
  uuid?: string;
  email: string;
  name?: string;
  status: 'enabled' | 'disabled' | 'blocklisted';
  lists?: number[];
  attribs?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface ListmonkList {
  id: number;
  uuid: string;
  name: string;
  type: 'public' | 'private' | 'temporary';
  optin: 'single' | 'double';
  tags: string[];
  subscriber_count: number;
  created_at: string;
  updated_at: string;
}

export interface ListmonkCampaign {
  id?: number;
  uuid?: string;
  name: string;
  subject: string;
  from_email?: string;
  body: string;
  altbody?: string;
  content_type: 'richtext' | 'html' | 'markdown' | 'plain';
  send_at?: string;
  status?:
    | 'draft'
    | 'running'
    | 'scheduled'
    | 'paused'
    | 'cancelled'
    | 'finished';
  template_id?: number;
  tags?: string[];
  lists?: number[];
  headers?: Record<string, string>[];
  messenger?: string;
}

export interface ListmonkCampaignStats {
  id: number;
  status: string;
  to_send: number;
  sent: number;
  started_at: string | null;
  updated_at: string;
  views: number;
  clicks: number;
  bounces: number;
  lists: { id: number; name: string }[];
}

export interface ListmonkConfig {
  url: string;
  apiUser: string;
  apiPassword: string;
  defaultListId?: number;
}

@Injectable()
export class ListmonkService {
  private readonly logger = new Logger(ListmonkService.name);
  private config: ListmonkConfig | null = null;

  constructor(private readonly configService: ConfigService) {
    this.loadConfig();
  }

  /** Env vars arrive as strings; Listmonk requires integer list IDs. */
  private parseListId(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed =
      typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private coerceListIds(listIds?: unknown[]): number[] {
    if (listIds?.length) {
      return listIds
        .map((id) => this.parseListId(id))
        .filter((id): id is number => id !== undefined);
    }
    const defaultId = this.parseListId(this.config?.defaultListId);
    return defaultId !== undefined ? [defaultId] : [];
  }

  private loadConfig() {
    const url = this.configService.get<string>('LISTMONK_URL');
    const apiUser = this.configService.get<string>('LISTMONK_API_USER');
    const apiPassword = this.configService.get<string>('LISTMONK_API_PASSWORD');
    const defaultListId = this.parseListId(
      this.configService.get<string>('LISTMONK_DEFAULT_LIST_ID'),
    );

    if (url && apiUser && apiPassword) {
      this.config = {
        url: url.replace(/\/$/, ''),
        apiUser,
        apiPassword,
        defaultListId: defaultListId ?? 1,
      };
      this.logger.log(`Listmonk configured: ${this.config.url}`);
    } else {
      this.logger.warn(
        'Listmonk not configured - missing LISTMONK_URL, LISTMONK_API_USER, or LISTMONK_API_PASSWORD',
      );
    }
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  getConfig(): ListmonkConfig | null {
    return this.config;
  }

  updateConfig(config: Partial<ListmonkConfig>) {
    const defaultListId = this.parseListId(config.defaultListId) ?? 1;
    if (this.config) {
      this.config = { ...this.config, ...config, defaultListId };
    } else {
      this.config = {
        url: config.url || '',
        apiUser: config.apiUser || '',
        apiPassword: config.apiPassword || '',
        defaultListId,
      };
    }
  }

  private getAuthHeader(): string {
    if (!this.config) throw new Error('Listmonk not configured');
    return (
      'Basic ' +
      Buffer.from(`${this.config.apiUser}:${this.config.apiPassword}`).toString(
        'base64',
      )
    );
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: any,
  ): Promise<T> {
    if (!this.config) {
      throw new Error('Listmonk not configured');
    }

    const url = `${this.config.url}/api${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      'Content-Type': 'application/json',
    };

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Listmonk API error: ${response.status} - ${errorText}`,
        );
        throw new Error(
          `Listmonk API error: ${response.status} - ${errorText}`,
        );
      }

      const data = await response.json();
      return data.data ?? data;
    } catch (error) {
      this.logger.error(`Listmonk request failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.getLists();
      return { ok: true, message: 'Connected to Listmonk successfully' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async getLists(): Promise<ListmonkList[]> {
    const result = await this.request<{ results: ListmonkList[] }>(
      'GET',
      '/lists',
    );
    return result.results || [];
  }

  async getList(id: number): Promise<ListmonkList> {
    return this.request<ListmonkList>('GET', `/lists/${id}`);
  }

  async createSubscriber(
    email: string,
    name?: string,
    listIds?: number[],
    attribs?: Record<string, any>,
  ): Promise<ListmonkSubscriber> {
    const lists = this.coerceListIds(listIds);

    return this.request<ListmonkSubscriber>('POST', '/subscribers', {
      email,
      name: name || '',
      status: 'enabled',
      lists,
      attribs: attribs || {},
      preconfirm_subscriptions: true,
    });
  }

  async getSubscriber(id: number): Promise<ListmonkSubscriber> {
    return this.request<ListmonkSubscriber>('GET', `/subscribers/${id}`);
  }

  async getSubscriberByEmail(
    email: string,
  ): Promise<ListmonkSubscriber | null> {
    try {
      const result = await this.request<{ results: ListmonkSubscriber[] }>(
        'GET',
        `/subscribers?query=subscribers.email='${encodeURIComponent(email)}'`,
      );
      return result.results?.[0] || null;
    } catch {
      return null;
    }
  }

  async getSubscribers(
    page = 1,
    perPage = 50,
    query?: string,
  ): Promise<{ results: ListmonkSubscriber[]; total: number }> {
    let endpoint = `/subscribers?page=${page}&per_page=${perPage}`;
    if (query) {
      endpoint += `&query=${encodeURIComponent(query)}`;
    }
    return this.request<{ results: ListmonkSubscriber[]; total: number }>(
      'GET',
      endpoint,
    );
  }

  async updateSubscriber(
    id: number,
    data: Partial<ListmonkSubscriber>,
  ): Promise<ListmonkSubscriber> {
    const payload = { ...data };
    if (payload.lists !== undefined) {
      payload.lists = this.coerceListIds(payload.lists);
    }
    return this.request<ListmonkSubscriber>(
      'PUT',
      `/subscribers/${id}`,
      payload,
    );
  }

  async deleteSubscriber(id: number): Promise<void> {
    await this.request<void>('DELETE', `/subscribers/${id}`);
  }

  async blocklistSubscriber(id: number): Promise<ListmonkSubscriber> {
    return this.updateSubscriber(id, { status: 'blocklisted' });
  }

  async unsubscribe(id: number): Promise<ListmonkSubscriber> {
    return this.updateSubscriber(id, { status: 'disabled' });
  }

  async addSubscriberToList(
    subscriberId: number,
    listId: number,
  ): Promise<void> {
    const parsedListId = this.parseListId(listId);
    const parsedSubscriberId = this.parseListId(subscriberId);
    if (parsedListId === undefined || parsedSubscriberId === undefined) {
      throw new Error('Invalid subscriber or list ID');
    }
    await this.request<void>('PUT', `/subscribers/lists`, {
      ids: [parsedSubscriberId],
      action: 'add',
      target_list_ids: [parsedListId],
    });
  }

  async removeSubscriberFromList(
    subscriberId: number,
    listId: number,
  ): Promise<void> {
    const parsedListId = this.parseListId(listId);
    const parsedSubscriberId = this.parseListId(subscriberId);
    if (parsedListId === undefined || parsedSubscriberId === undefined) {
      throw new Error('Invalid subscriber or list ID');
    }
    await this.request<void>('PUT', `/subscribers/lists`, {
      ids: [parsedSubscriberId],
      action: 'remove',
      target_list_ids: [parsedListId],
    });
  }

  async createCampaign(campaign: ListmonkCampaign): Promise<ListmonkCampaign> {
    const lists = this.coerceListIds(campaign.lists);

    return this.request<ListmonkCampaign>('POST', '/campaigns', {
      name: campaign.name,
      subject: campaign.subject,
      body: campaign.body,
      altbody: campaign.altbody || '',
      content_type: campaign.content_type || 'richtext',
      from_email: campaign.from_email,
      lists,
      template_id: campaign.template_id,
      tags: campaign.tags || [],
      headers: campaign.headers || [],
      messenger: campaign.messenger || 'email',
      send_at: campaign.send_at,
    });
  }

  async getCampaign(id: number): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>('GET', `/campaigns/${id}`);
  }

  async getCampaigns(
    page = 1,
    perPage = 50,
    status?: string,
  ): Promise<{ results: ListmonkCampaign[]; total: number }> {
    let endpoint = `/campaigns?page=${page}&per_page=${perPage}`;
    if (status) {
      endpoint += `&status=${status}`;
    }
    return this.request<{ results: ListmonkCampaign[]; total: number }>(
      'GET',
      endpoint,
    );
  }

  async updateCampaign(
    id: number,
    data: Partial<ListmonkCampaign>,
  ): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>('PUT', `/campaigns/${id}`, data);
  }

  async deleteCampaign(id: number): Promise<void> {
    await this.request<void>('DELETE', `/campaigns/${id}`);
  }

  async startCampaign(id: number): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>('PUT', `/campaigns/${id}/status`, {
      status: 'running',
    });
  }

  async pauseCampaign(id: number): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>('PUT', `/campaigns/${id}/status`, {
      status: 'paused',
    });
  }

  async cancelCampaign(id: number): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>('PUT', `/campaigns/${id}/status`, {
      status: 'cancelled',
    });
  }

  async scheduleCampaign(id: number, sendAt: Date): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>('PUT', `/campaigns/${id}/status`, {
      status: 'scheduled',
      send_at: sendAt.toISOString(),
    });
  }

  async getCampaignStats(id: number): Promise<ListmonkCampaignStats> {
    return this.request<ListmonkCampaignStats>('GET', `/campaigns/${id}`);
  }

  async getTemplates(): Promise<any[]> {
    const result = await this.request<{ results: any[] }>('GET', '/templates');
    return result.results || [];
  }

  async getDashboardStats(): Promise<{
    subscribers: {
      total: number;
      enabled: number;
      blocklisted: number;
      orphans: number;
    };
    campaigns: { total: number };
    lists: { total: number };
  }> {
    return this.request<any>('GET', '/dashboard/counts');
  }

  async importSubscribers(
    subscribers: Array<{
      email: string;
      name?: string;
      attribs?: Record<string, any>;
    }>,
    listIds?: number[],
    mode: 'subscribe' | 'blocklist' = 'subscribe',
  ): Promise<{ imported: number; failed: number }> {
    const lists = this.coerceListIds(listIds);

    const result = await this.request<{ imported: number; failed: number }>(
      'POST',
      '/import/subscribers',
      {
        mode,
        delim: ',',
        lists,
        overwrite: true,
        data: subscribers.map((s) => ({
          email: s.email,
          name: s.name || '',
          attribs: s.attribs || {},
        })),
      },
    );

    return result;
  }

  async syncSubscriber(
    email: string,
    name?: string,
    status: 'enabled' | 'disabled' | 'blocklisted' = 'enabled',
  ): Promise<ListmonkSubscriber> {
    const existing = await this.getSubscriberByEmail(email);

    if (existing) {
      if (existing.status !== status || (name && existing.name !== name)) {
        return this.updateSubscriber(existing.id!, { name, status });
      }
      return existing;
    }

    return this.createSubscriber(email, name);
  }
}
