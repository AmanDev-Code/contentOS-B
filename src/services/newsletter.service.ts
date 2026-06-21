import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { AiGatewayService } from './ai-gateway.service';
import {
  ListmonkService,
  ListmonkSubscriber,
  ListmonkCampaign,
} from './listmonk.service';
import * as crypto from 'crypto';

export interface NewsletterSubscriber {
  id: string;
  email: string;
  name?: string;
  status: 'enabled' | 'disabled' | 'blocklisted';
  listmonk_id?: number;
  subscribed_at: string;
  source: string;
  tags: string[];
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface NewsletterCampaign {
  id: string;
  title: string;
  subject: string;
  preview_text?: string;
  body_html?: string;
  body_text?: string;
  template_id?: string;
  blog_post_id?: string;
  listmonk_campaign_id?: number;
  status: 'draft' | 'scheduled' | 'running' | 'sent' | 'cancelled';
  scheduled_at?: string;
  sent_at?: string;
  total_sent: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
  created_at: string;
  updated_at: string;
}

export interface NewsletterTemplate {
  id: string;
  name: string;
  html_template: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewsletterImport {
  id: string;
  filename: string;
  total_rows: number;
  imported: number;
  failed: number;
  errors: Array<{ row: number; email: string; error: string }>;
  created_at: string;
}

export interface NewsletterAnalytics {
  total_subscribers: number;
  active_subscribers: number;
  disabled_subscribers: number;
  blocklisted_subscribers: number;
  total_campaigns: number;
  sent_campaigns: number;
  avg_open_rate: number;
  avg_click_rate: number;
  recent_campaigns: NewsletterCampaign[];
  subscriber_growth: Array<{ date: string; count: number }>;
}

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly aiGateway: AiGatewayService,
    private readonly listmonk: ListmonkService,
  ) {}

  private generateUnsubscribeToken(email: string): string {
    const secret = process.env.JWT_SECRET || 'newsletter-secret';
    return crypto
      .createHmac('sha256', secret)
      .update(email)
      .digest('hex')
      .slice(0, 32);
  }

  private async syncToListmonk(
    email: string,
    name?: string,
    metadata: Record<string, any> = {},
  ): Promise<number> {
    if (!this.listmonk.isConfigured()) {
      throw new BadRequestException(
        'Newsletter service is temporarily unavailable',
      );
    }

    try {
      const listmonkSub = await this.listmonk.syncSubscriber(
        email,
        name,
        'enabled',
      );
      if (!listmonkSub.id) {
        throw new Error('Listmonk returned subscriber without id');
      }
      return listmonkSub.id;
    } catch (e) {
      this.logger.error(
        `Failed to sync subscriber to Listmonk (${email}): ${(e as Error).message}`,
      );
      throw new BadRequestException(
        'Failed to subscribe. Please try again later.',
      );
    }
  }

  async subscribe(
    email: string,
    name?: string,
    source = 'website',
    tags: string[] = [],
    metadata: Record<string, any> = {},
  ): Promise<NewsletterSubscriber> {
    const client = this.supabase.getServiceClient();

    const normalizedEmail = email.toLowerCase().trim();

    const { data: existing } = await client
      .from('newsletter_subscribers')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (existing) {
      if (existing.status === 'enabled') {
        if (this.listmonk.isConfigured() && !existing.listmonk_id) {
          const listmonkId = await this.syncToListmonk(
            normalizedEmail,
            name || existing.name,
            { ...existing.metadata, ...metadata },
          );
          const { data: updated, error } = await client
            .from('newsletter_subscribers')
            .update({
              listmonk_id: listmonkId,
              name: name || existing.name,
              metadata: { ...existing.metadata, ...metadata },
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
            .select()
            .single();

          if (error)
            throw new BadRequestException(
              `Failed to update subscriber: ${error.message}`,
            );
          this.logger.log(`Backfilled Listmonk sync for: ${normalizedEmail}`);
          return updated as NewsletterSubscriber;
        }
        return existing as NewsletterSubscriber;
      }

      const { data: updated, error } = await client
        .from('newsletter_subscribers')
        .update({
          status: 'enabled',
          name: name || existing.name,
          source,
          tags: [...new Set([...(existing.tags || []), ...tags])],
          metadata: { ...existing.metadata, ...metadata },
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error)
        throw new BadRequestException(
          `Failed to resubscribe: ${error.message}`,
        );

      if (this.listmonk.isConfigured()) {
        try {
          if (existing.listmonk_id) {
            await this.listmonk.updateSubscriber(existing.listmonk_id, {
              status: 'enabled',
            });
          } else {
            const listmonkId = await this.syncToListmonk(
              normalizedEmail,
              name || existing.name,
              { ...existing.metadata, ...metadata },
            );
            await client
              .from('newsletter_subscribers')
              .update({
                listmonk_id: listmonkId,
                updated_at: new Date().toISOString(),
              })
              .eq('id', existing.id);
            (updated as NewsletterSubscriber).listmonk_id = listmonkId;
          }
        } catch (e) {
          if (e instanceof BadRequestException) throw e;
          this.logger.error(
            `Failed to sync resubscribe to Listmonk: ${(e as Error).message}`,
          );
          throw new BadRequestException(
            'Failed to subscribe. Please try again later.',
          );
        }
      }

      return updated as NewsletterSubscriber;
    }

    const listmonkId = this.listmonk.isConfigured()
      ? await this.syncToListmonk(normalizedEmail, name, metadata)
      : undefined;

    const { data: subscriber, error } = await client
      .from('newsletter_subscribers')
      .insert({
        email: normalizedEmail,
        name,
        status: 'enabled',
        listmonk_id: listmonkId,
        source,
        tags,
        metadata,
      })
      .select()
      .single();

    if (error)
      throw new BadRequestException(`Failed to subscribe: ${error.message}`);

    this.logger.log(`New subscriber: ${normalizedEmail} from ${source}`);
    return subscriber as NewsletterSubscriber;
  }

  async unsubscribe(email: string): Promise<{ success: boolean }> {
    const client = this.supabase.getServiceClient();
    const normalizedEmail = email.toLowerCase().trim();

    const { data: subscriber } = await client
      .from('newsletter_subscribers')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (!subscriber) {
      return { success: true };
    }

    const { error } = await client
      .from('newsletter_subscribers')
      .update({ status: 'disabled', updated_at: new Date().toISOString() })
      .eq('id', subscriber.id);

    if (error)
      throw new BadRequestException(`Failed to unsubscribe: ${error.message}`);

    if (this.listmonk.isConfigured() && subscriber.listmonk_id) {
      try {
        await this.listmonk.unsubscribe(subscriber.listmonk_id);
      } catch (e) {
        this.logger.warn(
          `Failed to sync unsubscribe to Listmonk: ${(e as Error).message}`,
        );
      }
    }

    this.logger.log(`Unsubscribed: ${normalizedEmail}`);
    return { success: true };
  }

  async unsubscribeByToken(
    token: string,
    email: string,
  ): Promise<{ success: boolean }> {
    const expectedToken = this.generateUnsubscribeToken(email);
    if (token !== expectedToken) {
      throw new BadRequestException('Invalid unsubscribe token');
    }
    return this.unsubscribe(email);
  }

  async getSubscribers(
    page = 1,
    limit = 50,
    status?: string,
    search?: string,
  ): Promise<{ subscribers: NewsletterSubscriber[]; total: number }> {
    const client = this.supabase.getServiceClient();

    let query = client
      .from('newsletter_subscribers')
      .select('*', { count: 'exact' });

    if (status) {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`);
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error)
      throw new BadRequestException(
        `Failed to fetch subscribers: ${error.message}`,
      );

    return {
      subscribers: (data || []) as NewsletterSubscriber[],
      total: count || 0,
    };
  }

  async importSubscribers(
    csvData: Array<{ email: string; name?: string; tags?: string[] }>,
    filename: string,
    source = 'import',
  ): Promise<NewsletterImport> {
    const client = this.supabase.getServiceClient();

    const errors: Array<{ row: number; email: string; error: string }> = [];
    let imported = 0;

    for (let i = 0; i < csvData.length; i++) {
      const row = csvData[i];
      try {
        if (!row.email || !row.email.includes('@')) {
          errors.push({
            row: i + 1,
            email: row.email || '',
            error: 'Invalid email',
          });
          continue;
        }

        await this.subscribe(row.email, row.name, source, row.tags || []);
        imported++;
      } catch (e) {
        errors.push({
          row: i + 1,
          email: row.email,
          error: (e as Error).message,
        });
      }
    }

    const { data: importRecord, error } = await client
      .from('newsletter_imports')
      .insert({
        filename,
        total_rows: csvData.length,
        imported,
        failed: errors.length,
        errors,
      })
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        `Failed to save import record: ${error.message}`,
      );

    this.logger.log(
      `Import complete: ${imported}/${csvData.length} from ${filename}`,
    );
    return importRecord as NewsletterImport;
  }

  async createCampaign(data: {
    title: string;
    subject: string;
    preview_text?: string;
    body_html?: string;
    body_text?: string;
    template_id?: string;
    blog_post_id?: string;
  }): Promise<NewsletterCampaign> {
    const client = this.supabase.getServiceClient();

    const { data: campaign, error } = await client
      .from('newsletter_campaigns')
      .insert({
        title: data.title,
        subject: data.subject,
        preview_text: data.preview_text,
        body_html: data.body_html,
        body_text: data.body_text,
        template_id: data.template_id,
        blog_post_id: data.blog_post_id,
        status: 'draft',
      })
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        `Failed to create campaign: ${error.message}`,
      );

    return campaign as NewsletterCampaign;
  }

  async createCampaignFromPost(postId: string): Promise<NewsletterCampaign> {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postError } = await client
      .from('blog_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (postError || !post) {
      throw new NotFoundException('Blog post not found');
    }

    const newsletterContent = await this.generateNewsletterContent(post);

    return this.createCampaign({
      title: post.title,
      subject: newsletterContent.subject,
      preview_text: newsletterContent.preview_text,
      body_html: newsletterContent.body_html,
      body_text: newsletterContent.body_text,
      blog_post_id: postId,
    });
  }

  async generateNewsletterContent(post: any): Promise<{
    subject: string;
    preview_text: string;
    body_html: string;
    body_text: string;
  }> {
    const systemPrompt = `You are an expert email copywriter. Convert the following blog post into an engaging newsletter email.

Requirements:
1. Create a compelling subject line (max 60 chars)
2. Write a preview text (max 100 chars) that entices opens
3. Convert the article body into email-friendly HTML with:
   - A brief intro hook (2-3 sentences)
   - Key highlights/takeaways as bullet points
   - A "Read More" CTA linking to the full article
4. Also provide a plain text version

Respond with JSON:
{
  "subject": "string",
  "preview_text": "string",
  "body_html": "string (HTML)",
  "body_text": "string (plain text)"
}`;

    const userPrompt = `Convert this blog post to a newsletter:

Title: ${post.title}
Subtitle: ${post.subtitle || ''}
Excerpt: ${post.excerpt || ''}

Body:
${post.body?.slice(0, 3000) || ''}

Article URL: /blog/${post.slug}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.7,
        maxTokens: 2000,
        timeoutMs: 30_000,
      });

      const parsed = JSON.parse(content);
      return {
        subject: parsed.subject || post.title,
        preview_text: parsed.preview_text || post.excerpt?.slice(0, 100) || '',
        body_html: parsed.body_html || `<p>${post.excerpt}</p>`,
        body_text: parsed.body_text || post.excerpt || '',
      };
    } catch (error) {
      this.logger.error(
        `Newsletter content generation failed: ${(error as Error).message}`,
      );
      return {
        subject: post.title,
        preview_text: post.excerpt?.slice(0, 100) || '',
        body_html: `<h1>${post.title}</h1><p>${post.excerpt || ''}</p><p><a href="/blog/${post.slug}">Read more</a></p>`,
        body_text: `${post.title}\n\n${post.excerpt || ''}\n\nRead more: /blog/${post.slug}`,
      };
    }
  }

  async getCampaigns(
    page = 1,
    limit = 50,
    status?: string,
  ): Promise<{ campaigns: NewsletterCampaign[]; total: number }> {
    const client = this.supabase.getServiceClient();

    let query = client
      .from('newsletter_campaigns')
      .select('*', { count: 'exact' });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error)
      throw new BadRequestException(
        `Failed to fetch campaigns: ${error.message}`,
      );

    return {
      campaigns: (data || []) as NewsletterCampaign[],
      total: count || 0,
    };
  }

  async getCampaign(id: string): Promise<NewsletterCampaign> {
    const client = this.supabase.getServiceClient();

    const { data, error } = await client
      .from('newsletter_campaigns')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Campaign not found');

    return data as NewsletterCampaign;
  }

  async updateCampaign(
    id: string,
    data: Partial<NewsletterCampaign>,
  ): Promise<NewsletterCampaign> {
    const client = this.supabase.getServiceClient();

    const { data: campaign, error } = await client
      .from('newsletter_campaigns')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        `Failed to update campaign: ${error.message}`,
      );

    return campaign as NewsletterCampaign;
  }

  async sendCampaign(id: string): Promise<NewsletterCampaign> {
    const campaign = await this.getCampaign(id);

    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new BadRequestException(
        'Campaign cannot be sent in current status',
      );
    }

    if (!this.listmonk.isConfigured()) {
      throw new BadRequestException('Listmonk is not configured');
    }

    const template = campaign.template_id
      ? await this.getTemplate(campaign.template_id)
      : await this.getDefaultTemplate();

    const bodyHtml = template
      ? template.html_template
          .replace('{{ .Subject }}', campaign.subject)
          .replace('{{ .Body }}', campaign.body_html || '')
          .replace('{{ .LogoURL }}', process.env.LOGO_URL || '/logo.png')
          .replace('{{ .UnsubscribeURL }}', '{{ .UnsubscribeURL }}')
          .replace('{{ .PreferencesURL }}', '{{ .PreferencesURL }}')
          .replace('{{ .Year }}', new Date().getFullYear().toString())
      : campaign.body_html || '';

    const listmonkCampaign = await this.listmonk.createCampaign({
      name: campaign.title,
      subject: campaign.subject,
      body: bodyHtml,
      altbody: campaign.body_text,
      content_type: 'richtext',
    });

    await this.listmonk.startCampaign(listmonkCampaign.id!);

    return this.updateCampaign(id, {
      status: 'running',
      listmonk_campaign_id: listmonkCampaign.id,
      sent_at: new Date().toISOString(),
    });
  }

  async scheduleCampaign(
    id: string,
    scheduledAt: Date,
  ): Promise<NewsletterCampaign> {
    const campaign = await this.getCampaign(id);

    if (campaign.status !== 'draft') {
      throw new BadRequestException('Only draft campaigns can be scheduled');
    }

    return this.updateCampaign(id, {
      status: 'scheduled',
      scheduled_at: scheduledAt.toISOString(),
    });
  }

  async cancelCampaign(id: string): Promise<NewsletterCampaign> {
    const campaign = await this.getCampaign(id);

    if (campaign.listmonk_campaign_id && this.listmonk.isConfigured()) {
      try {
        await this.listmonk.cancelCampaign(campaign.listmonk_campaign_id);
      } catch (e) {
        this.logger.warn(
          `Failed to cancel Listmonk campaign: ${(e as Error).message}`,
        );
      }
    }

    return this.updateCampaign(id, { status: 'cancelled' });
  }

  async syncCampaignStats(id: string): Promise<NewsletterCampaign> {
    const campaign = await this.getCampaign(id);

    if (!campaign.listmonk_campaign_id || !this.listmonk.isConfigured()) {
      return campaign;
    }

    try {
      const stats = await this.listmonk.getCampaignStats(
        campaign.listmonk_campaign_id,
      );

      return this.updateCampaign(id, {
        total_sent: stats.sent,
        opens: stats.views,
        clicks: stats.clicks,
        status: stats.status === 'finished' ? 'sent' : campaign.status,
      });
    } catch (e) {
      this.logger.warn(
        `Failed to sync campaign stats: ${(e as Error).message}`,
      );
      return campaign;
    }
  }

  async getTemplates(): Promise<NewsletterTemplate[]> {
    const client = this.supabase.getServiceClient();

    const { data, error } = await client
      .from('newsletter_templates')
      .select('*')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error)
      throw new BadRequestException(
        `Failed to fetch templates: ${error.message}`,
      );

    return (data || []) as NewsletterTemplate[];
  }

  async getTemplate(id: string): Promise<NewsletterTemplate | null> {
    const client = this.supabase.getServiceClient();

    const { data } = await client
      .from('newsletter_templates')
      .select('*')
      .eq('id', id)
      .single();

    return data as NewsletterTemplate | null;
  }

  async getDefaultTemplate(): Promise<NewsletterTemplate | null> {
    const client = this.supabase.getServiceClient();

    const { data } = await client
      .from('newsletter_templates')
      .select('*')
      .eq('is_default', true)
      .single();

    return data as NewsletterTemplate | null;
  }

  async createTemplate(
    name: string,
    htmlTemplate: string,
    isDefault = false,
  ): Promise<NewsletterTemplate> {
    const client = this.supabase.getServiceClient();

    if (isDefault) {
      await client
        .from('newsletter_templates')
        .update({ is_default: false })
        .eq('is_default', true);
    }

    const { data, error } = await client
      .from('newsletter_templates')
      .insert({ name, html_template: htmlTemplate, is_default: isDefault })
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        `Failed to create template: ${error.message}`,
      );

    return data as NewsletterTemplate;
  }

  async updateTemplate(
    id: string,
    data: Partial<NewsletterTemplate>,
  ): Promise<NewsletterTemplate> {
    const client = this.supabase.getServiceClient();

    if (data.is_default) {
      await client
        .from('newsletter_templates')
        .update({ is_default: false })
        .eq('is_default', true);
    }

    const { data: template, error } = await client
      .from('newsletter_templates')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        `Failed to update template: ${error.message}`,
      );

    return template as NewsletterTemplate;
  }

  async getAnalytics(): Promise<NewsletterAnalytics> {
    const client = this.supabase.getServiceClient();

    const { data: subscribers } = await client
      .from('newsletter_subscribers')
      .select('status');

    const total = subscribers?.length || 0;
    const active =
      subscribers?.filter((s) => s.status === 'enabled').length || 0;
    const disabled =
      subscribers?.filter((s) => s.status === 'disabled').length || 0;
    const blocklisted =
      subscribers?.filter((s) => s.status === 'blocklisted').length || 0;

    const { data: campaigns } = await client
      .from('newsletter_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    const sentCampaigns = campaigns?.filter((c) => c.status === 'sent') || [];
    const avgOpenRate =
      sentCampaigns.length > 0
        ? sentCampaigns.reduce(
            (sum, c) =>
              sum + (c.total_sent > 0 ? (c.opens / c.total_sent) * 100 : 0),
            0,
          ) / sentCampaigns.length
        : 0;
    const avgClickRate =
      sentCampaigns.length > 0
        ? sentCampaigns.reduce(
            (sum, c) =>
              sum + (c.total_sent > 0 ? (c.clicks / c.total_sent) * 100 : 0),
            0,
          ) / sentCampaigns.length
        : 0;

    const { data: growth } = await client
      .from('newsletter_subscribers')
      .select('subscribed_at')
      .order('subscribed_at', { ascending: true });

    const growthByDate = new Map<string, number>();
    let runningTotal = 0;
    growth?.forEach((s) => {
      const date = new Date(s.subscribed_at).toISOString().split('T')[0];
      runningTotal++;
      growthByDate.set(date, runningTotal);
    });

    const subscriberGrowth = Array.from(growthByDate.entries())
      .slice(-30)
      .map(([date, count]) => ({ date, count }));

    return {
      total_subscribers: total,
      active_subscribers: active,
      disabled_subscribers: disabled,
      blocklisted_subscribers: blocklisted,
      total_campaigns: campaigns?.length || 0,
      sent_campaigns: sentCampaigns.length,
      avg_open_rate: Math.round(avgOpenRate * 10) / 10,
      avg_click_rate: Math.round(avgClickRate * 10) / 10,
      recent_campaigns: (campaigns?.slice(0, 5) || []) as NewsletterCampaign[],
      subscriber_growth: subscriberGrowth,
    };
  }

  async getListmonkConfig(): Promise<{
    configured: boolean;
    url?: string;
    connected?: boolean;
    lists?: any[];
  }> {
    if (!this.listmonk.isConfigured()) {
      return { configured: false };
    }

    const config = this.listmonk.getConfig();
    const testResult = await this.listmonk.testConnection();

    let lists: any[] = [];
    if (testResult.ok) {
      try {
        lists = await this.listmonk.getLists();
      } catch {
        // Ignore
      }
    }

    return {
      configured: true,
      url: config?.url,
      connected: testResult.ok,
      lists,
    };
  }
}
