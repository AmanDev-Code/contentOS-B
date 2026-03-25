import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
  Get,
  UseGuards,
  Query,
} from '@nestjs/common';
import { EmailService, EmailDeliveryStatus } from '../services/email.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { GetUser } from '../decorators/get-user.decorator';
import { PaywallGuard } from '../guards/paywall.guard';

interface WebhookPayload {
  email_id?: string;
  emailId?: string;
  rcpt?: string;
  recipient?: string;
  event?: string;
  status?: string;
  timestamp?: string;
  event_time?: string;
  [key: string]: any;
}

interface TestEmailDto {
  to: string;
  type: 'verification' | 'password-reset' | 'welcome' | 'upgrade' | 'order-receipt' | 'invitation';
}

@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(private readonly emailService: EmailService) {}

  /**
   * SMTP2GO webhook endpoint for delivery status updates
   * This endpoint receives webhooks from SMTP2GO about email delivery status
   */
  @Post('webhook/delivery')
  @HttpCode(HttpStatus.OK)
  async handleDeliveryWebhook(
    @Body() body: WebhookPayload,
  ): Promise<{ success: boolean }> {
    try {
      this.logger.log(
        'Received email delivery webhook:',
        JSON.stringify(body, null, 2),
      );

      // SMTP2GO webhook payload structure
      const webhookData: EmailDeliveryStatus = {
        email_id: body.email_id || body.emailId || '',
        recipient: body.rcpt || body.recipient || '',
        status: this.mapWebhookEventToStatus((body.event || body.status) || ''),
        event_time:
          body.timestamp || body.event_time || new Date().toISOString(),
        details: body,
      };

      if (!webhookData.email_id) {
        this.logger.warn('Webhook missing email_id:', body);
        return { success: false };
      }

      await this.emailService.handleDeliveryWebhook(webhookData);

      return { success: true };
    } catch (error) {
      this.logger.error('Error processing delivery webhook:', error.message);
      return { success: false };
    }
  }

  /**
   * Get email delivery logs (admin only)
   */
  @Get('logs')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  async getEmailLogs(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
    @Query('status') status?: string,
    @Query('recipient') recipient?: string,
    @Query('template_id') template_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
  ) {
    try {
      const result = await this.emailService.getEmailLogs({
        page: parseInt(page),
        limit: parseInt(limit),
        status,
        recipient,
        template_id,
        from_date,
        to_date,
      });

      return {
        success: true,
        ...result,
      };
    } catch (error) {
      this.logger.error('Error fetching email logs:', (error as Error).message);
      return {
        success: false,
        error: (error as Error).message,
        data: [],
        total: 0,
        page: parseInt(page),
        limit: parseInt(limit),
      };
    }
  }

  /**
   * Get email statistics (admin only)
   */
  @Get('stats')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  async getEmailStats(
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
  ) {
    try {
      const stats = await this.emailService.getEmailStats({
        from_date,
        to_date,
      });

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error('Error fetching email stats:', (error as Error).message);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Test email sending (admin only)
   */
  @Post('test')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  async sendTestEmail(
    @Body() body: TestEmailDto,
    @GetUser() _user: { id: string },
  ) {
    try {
      let result: boolean = false;

      switch (body.type) {
        case 'verification':
          result = await this.emailService.sendVerificationEmail(
            body.to,
            'test-token-123',
          );
          break;
        case 'password-reset':
          result = await this.emailService.sendPasswordResetEmail(
            body.to,
            'test-reset-token-123',
          );
          break;
        case 'welcome':
          result = await this.emailService.sendWelcomeEmail(
            body.to,
            'Test User',
          );
          break;
        case 'upgrade':
          result = await this.emailService.sendUpgradeConfirmationEmail(
            body.to,
            'Pro Plan',
            29.99,
          );
          break;
        case 'order-receipt':
          result = await this.emailService.sendOrderReceiptEmail(body.to, {
            orderId: 'ORD-TEST-12345',
            planName: 'Pro Plan',
            amount: 29.99,
            credits: 1000,
            date: new Date().toLocaleDateString(),
          });
          break;
        case 'invitation':
          result = await this.emailService.sendInvitationEmail(
            body.to,
            'Test Admin',
            'test-invite-token-abc123',
          );
          break;
        default:
          return { success: false, error: 'Invalid email type' };
      }

      return { success: result };
    } catch (error) {
      this.logger.error('Error sending test email:', (error as Error).message);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Map SMTP2GO webhook events to our internal status
   */
  private mapWebhookEventToStatus(
    event: string,
  ): EmailDeliveryStatus['status'] {
    const eventMap: Record<string, EmailDeliveryStatus['status']> = {
      processed: 'sent',
      delivered: 'delivered',
      bounce: 'bounced',
      bounced: 'bounced',
      reject: 'rejected',
      rejected: 'rejected',
      spam: 'spam',
      unsubscribe: 'unsubscribed',
      unsubscribed: 'unsubscribed',
      resubscribe: 'unsubscribed', // Keep as unsubscribed for simplicity
      open: 'opened',
      opened: 'opened',
      click: 'clicked',
      clicked: 'clicked',
    };

    return eventMap[event?.toLowerCase()] || 'sent';
  }
}
