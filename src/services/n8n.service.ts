import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { N8nWebhookPayload } from '../common/types';

@Injectable()
export class N8nService {
  private readonly logger = new Logger(N8nService.name);
  private readonly webhookUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;

  constructor(private configService: ConfigService) {
    this.webhookUrl = this.configService.get<string>('n8n.webhookUrl') || '';
    this.apiKey = this.configService.get<string>('n8n.apiKey') || '';
    this.webhookSecret = this.configService.get<string>('n8n.webhookSecret') || '';
  }

  async triggerContentGeneration(
    payload: N8nWebhookPayload,
    options?: { webhookUrlOverride?: string },
  ): Promise<{ success: boolean; message: string; data?: unknown }> {
    try {
      const targetUrl = options?.webhookUrlOverride?.trim() || this.webhookUrl;
      if (!targetUrl) {
        throw new Error('n8n webhook URL is not configured');
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      if (this.webhookSecret) {
        headers['X-N8N-Webhook-Secret'] = this.webhookSecret;
      }

      this.logger.log(
        JSON.stringify({
          event: 'n8n.trigger.request',
          jobId: payload.jobId,
          targetUrl,
          callbackUrl: payload.callbackUrl || payload.callback_url || '(none)',
          hasApiKey: !!this.apiKey,
          hasWebhookSecret: !!this.webhookSecret,
          payloadKeys: Object.keys(payload),
          // Log the full callback URL for debugging
          fullCallbackUrl: payload.callbackUrl,
        }),
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `n8n webhook failed: ${response.status} - ${errorText}`,
        );
        throw new Error(`n8n webhook failed: ${response.status}`);
      }

      const responseText = await response.text();
      const parsed = this.parseJsonLike(responseText);
      const parsedKeys =
        parsed && typeof parsed === 'object'
          ? Object.keys(parsed as Record<string, unknown>).slice(0, 12)
          : [];
      this.logger.log(
        JSON.stringify({
          event: 'n8n.trigger.response',
          jobId: payload.jobId,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          textLength: responseText.length,
          parsed: parsed !== undefined,
          parsedType: parsed === null ? 'null' : typeof parsed,
          parsedKeys,
        }),
      );

      this.logger.log(
        `n8n webhook triggered successfully for job ${payload.jobId}`,
      );

      return {
        success: true,
        message: 'Webhook triggered successfully',
        data: parsed,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.error(
          `n8n webhook timed out after 60s for job ${payload.jobId} (url=${options?.webhookUrlOverride?.trim() || this.webhookUrl})`,
        );
        throw new Error('n8n webhook request timed out after 60 seconds');
      }
      this.logger.error(`Failed to trigger n8n webhook: ${error.message}`);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(
        this.webhookUrl.replace('/webhook/', '/healthz'),
        {
          method: 'GET',
        },
      );
      return response.ok;
    } catch (error) {
      this.logger.error(`n8n health check failed: ${error.message}`);
      return false;
    }
  }

  private parseJsonLike(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Try to recover JSON embedded in wrappers, markdown fences, or logs.
      const jsonCandidate =
        trimmed.match(/\{[\s\S]*\}$/)?.[0] ||
        trimmed.match(/\[[\s\S]*\]$/)?.[0] ||
        '';
      if (jsonCandidate) {
        try {
          return JSON.parse(jsonCandidate);
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }
}
