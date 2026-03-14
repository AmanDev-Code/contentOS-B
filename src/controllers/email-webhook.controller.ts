import { Controller, Post, Body, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { EmailService, EmailDeliveryStatus } from '../services/email.service';

interface SMTP2GOWebhookPayload {
  email_id?: string;
  emailId?: string;
  rcpt?: string;
  recipient?: string;
  event?: string;
  status?: string;
  timestamp?: string;
  event_time?: string;
  subject?: string;
  message_id?: string;
  [key: string]: any;
}

@Controller('webhook')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(private readonly emailService: EmailService) {}

  /**
   * SMTP2GO webhook endpoint for email delivery status
   */
  @Post('email-delivery')
  @HttpCode(HttpStatus.OK)
  async handleEmailDelivery(@Body() payload: SMTP2GOWebhookPayload) {
    this.logger.log('Received SMTP2GO webhook:', JSON.stringify(payload, null, 2));

    try {
      // Map SMTP2GO webhook to our format
      const webhookData: EmailDeliveryStatus = {
        email_id: payload.email_id || payload.emailId || '',
        recipient: payload.rcpt || payload.recipient || '',
        status: this.mapEventToStatus(payload.event || payload.status || ''),
        event_time: payload.timestamp || payload.event_time || new Date().toISOString(),
        details: payload,
      };

      if (!webhookData.email_id) {
        this.logger.warn('Webhook missing email_id:', payload);
        return { success: false, message: 'Missing email_id' };
      }

      await this.emailService.handleDeliveryWebhook(webhookData);
      
      this.logger.log(`Email ${webhookData.email_id} status updated to: ${webhookData.status}`);
      return { success: true, message: 'Webhook processed successfully' };
    } catch (error) {
      this.logger.error('Error processing email webhook:', (error as Error).message);
      return { success: false, message: 'Internal server error' };
    }
  }

  /**
   * Map SMTP2GO events to our internal status
   */
  private mapEventToStatus(event: string): EmailDeliveryStatus['status'] {
    const eventMap: Record<string, EmailDeliveryStatus['status']> = {
      'processed': 'sent',
      'delivered': 'delivered',
      'bounce': 'bounced',
      'bounced': 'bounced',
      'reject': 'rejected',
      'rejected': 'rejected',
      'spam': 'spam',
      'unsubscribe': 'unsubscribed',
      'unsubscribed': 'unsubscribed',
      'resubscribe': 'unsubscribed',
      'open': 'opened',
      'opened': 'opened',
      'click': 'clicked',
      'clicked': 'clicked',
    };

    return eventMap[event?.toLowerCase()] || 'sent';
  }
}