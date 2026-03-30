import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { N8nWebhookPayload } from '../common/types';

@Injectable()
export class N8nService {
  private readonly logger = new Logger(N8nService.name);
  private readonly webhookUrl: string;
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.webhookUrl = this.configService.get<string>('n8n.webhookUrl') || '';
    this.apiKey = this.configService.get<string>('n8n.apiKey') || '';
  }

  async triggerContentGeneration(
    payload: N8nWebhookPayload,
    options?: { webhookUrlOverride?: string },
  ): Promise<{ success: boolean; message: string }> {
    try {
      const targetUrl =
        options?.webhookUrlOverride?.trim() || this.webhookUrl;
      if (!targetUrl) {
        throw new Error('n8n webhook URL is not configured');
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `n8n webhook failed: ${response.status} - ${errorText}`,
        );
        throw new Error(`n8n webhook failed: ${response.status}`);
      }

      // Try to parse JSON response, but don't fail if it's empty
      try {
        const text = await response.text();
        if (text) {
          const result = JSON.parse(text);
          this.logger.log(`n8n webhook response: ${JSON.stringify(result)}`);
        }
      } catch (parseError) {
        // Ignore JSON parse errors - n8n might return empty response
        this.logger.log(
          `n8n webhook triggered (empty response) for job ${payload.jobId}`,
        );
      }

      this.logger.log(
        `n8n webhook triggered successfully for job ${payload.jobId}`,
      );

      return {
        success: true,
        message: 'Webhook triggered successfully',
      };
    } catch (error) {
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
}
