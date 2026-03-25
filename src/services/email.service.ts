import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import {
  getVerificationTemplate,
  getPasswordResetTemplate,
  getWelcomeTemplate,
  getUpgradeTemplate,
  getOrderReceiptTemplate,
  getInvitationTemplate,
} from '../templates/email';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  html_body: string;
  text_body: string;
  variables: string[];
}

export interface SendEmailDto {
  to: string | string[];
  subject: string;
  html_body?: string;
  text_body?: string;
  template_id?: string;
  template_data?: Record<string, any>;
  cc?: string[];
  bcc?: string[];
  custom_headers?: Array<{ header: string; value: string }>;
}

export interface EmailDeliveryStatus {
  email_id: string;
  recipient: string;
  status:
    | 'sent'
    | 'delivered'
    | 'bounced'
    | 'rejected'
    | 'spam'
    | 'unsubscribed'
    | 'opened'
    | 'clicked';
  event_time: string;
  details?: any;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {
    this.apiKey = this.configService.get<string>('SMTP2GO_API_KEY') || '';
    this.baseUrl =
      this.configService.get<string>('SMTP2GO_BASE_URL') ||
      'https://api.smtp2go.com/v3';
    this.fromEmail =
      this.configService.get<string>('SMTP2GO_FROM_EMAIL') ||
      'noreply@trndinn.com';
    this.fromName =
      this.configService.get<string>('SMTP2GO_FROM_NAME') || 'Trndinn Team';

    if (!this.apiKey) {
      this.logger.warn(
        'SMTP2GO_API_KEY not configured - email functionality will be disabled',
      );
    }
  }

  /**
   * Send email using SMTP2GO API
   */
  async sendEmail(
    dto: SendEmailDto,
  ): Promise<{ success: boolean; email_id?: string; error?: string }> {
    if (!this.apiKey) {
      this.logger.warn('Email service not configured - skipping email send');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const payload: Record<string, any> = {
        sender: `${this.fromName} <${this.fromEmail}>`,
        to: Array.isArray(dto.to) ? dto.to : [dto.to],
        subject: dto.subject,
        html_body: dto.html_body,
        text_body: dto.text_body,
        cc: dto.cc,
        bcc: dto.bcc,
        custom_headers: dto.custom_headers,
      };

      // Only include template_id/template_data if using SMTP2GO templates (not our built-in HTML)
      // We use html_body for our templates, so never pass template_id to SMTP2GO
      // template_id in dto is for our internal logging only

      // Remove undefined fields
      Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined) {
          delete payload[key];
        }
      });

      const response = await fetch(`${this.baseUrl}/email/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Smtp2go-Api-Key': this.apiKey,
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (response.ok && result.data?.succeeded > 0) {
        this.logger.log(
          `Email sent successfully to ${dto.to} - ID: ${result.data.email_id}`,
        );

        // Log email send to database
        await this.logEmailSend({
          email_id: result.data.email_id,
          recipient: Array.isArray(dto.to) ? dto.to[0] : dto.to,
          subject: dto.subject,
          status: 'sent',
          template_id: dto.template_id || 'custom',
        });

        return { success: true, email_id: result.data.email_id };
      } else {
        this.logger.error('Failed to send email:', result);
        return { success: false, error: result.data?.error || 'Unknown error' };
      }
    } catch (error) {
      this.logger.error('Error sending email:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Log email send to database
   */
  private async logEmailSend(data: {
    email_id: string;
    recipient: string;
    subject: string;
    status: string;
    template_id?: string;
  }): Promise<void> {
    try {
      const { error } = await this.supabaseService.getServiceClient().from('email_logs').insert({
        email_id: data.email_id,
        recipient: data.recipient,
        subject: data.subject,
        status: data.status,
        template_id: data.template_id,
        sent_at: new Date().toISOString(),
      });

      if (error) {
        this.logger.error('Failed to log email send:', error.message);
      }
    } catch (error) {
      this.logger.error('Failed to log email send:', (error as Error).message);
    }
  }

  /**
   * Handle webhook delivery status updates
   */
  async handleDeliveryWebhook(data: EmailDeliveryStatus): Promise<void> {
    try {
      const { error } = await this.supabaseService
        .getServiceClient()
        .from('email_logs')
        .update({
          status: data.status,
          delivered_at: data.event_time,
          webhook_data: data.details,
          updated_at: new Date().toISOString(),
        })
        .eq('email_id', data.email_id);

      if (error) {
        this.logger.error('Failed to update email delivery status:', error.message);
      } else {
        this.logger.log(`Email delivery status updated: ${data.email_id} - ${data.status}`);
      }
    } catch (error) {
      this.logger.error('Failed to update email delivery status:', (error as Error).message);
    }
  }

  /**
   * Get email logs with filtering and pagination
   */
  async getEmailLogs(options: {
    page?: number;
    limit?: number;
    status?: string;
    recipient?: string;
    template_id?: string;
    user_id?: string;
    from_date?: string;
    to_date?: string;
  } = {}): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    try {
      const {
        page = 1,
        limit = 50,
        status,
        recipient,
        template_id,
        user_id,
        from_date,
        to_date
      } = options;

      let query = this.supabaseService.getServiceClient()
        .from('email_logs')
        .select('*', { count: 'exact' });

      // Apply filters
      if (status) {
        query = query.eq('status', status);
      }
      if (recipient) {
        query = query.ilike('recipient', `%${recipient}%`);
      }
      if (template_id) {
        query = query.eq('template_id', template_id);
      }
      if (from_date) {
        query = query.gte('sent_at', from_date);
      }
      if (to_date) {
        query = query.lte('sent_at', to_date);
      }

      // Apply pagination
      const from = (page - 1) * limit;
      const to = from + limit - 1;

      query = query
        .order('sent_at', { ascending: false })
        .range(from, to);

      const { data, error, count } = await query;

      if (error) {
        throw new Error(`Failed to fetch email logs: ${error.message}`);
      }

      return {
        data: data || [],
        total: count || 0,
        page,
        limit,
      };
    } catch (error) {
      this.logger.error('Error fetching email logs:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get email statistics
   */
  async getEmailStats(options: {
    from_date?: string;
    to_date?: string;
  } = {}): Promise<{
    total: number;
    sent: number;
    delivered: number;
    bounced: number;
    opened: number;
    clicked: number;
    by_template: Record<string, number>;
    by_status: Record<string, number>;
  }> {
    try {
      const { from_date, to_date } = options;

      let query = this.supabaseService.getServiceClient()
        .from('email_logs')
        .select('status, template_id');

      if (from_date) {
        query = query.gte('sent_at', from_date);
      }
      if (to_date) {
        query = query.lte('sent_at', to_date);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to fetch email stats: ${error.message}`);
      }

      const stats = {
        total: data?.length || 0,
        sent: 0,
        delivered: 0,
        bounced: 0,
        opened: 0,
        clicked: 0,
        by_template: {} as Record<string, number>,
        by_status: {} as Record<string, number>,
      };

      data?.forEach((log) => {
        // Count by status
        stats.by_status[log.status] = (stats.by_status[log.status] || 0) + 1;
        
        // Count specific statuses
        switch (log.status) {
          case 'sent':
            stats.sent++;
            break;
          case 'delivered':
            stats.delivered++;
            break;
          case 'bounced':
            stats.bounced++;
            break;
          case 'opened':
            stats.opened++;
            break;
          case 'clicked':
            stats.clicked++;
            break;
        }

        // Count by template (use 'custom' for null/undefined)
        const templateKey = log.template_id || 'custom';
        stats.by_template[templateKey] = (stats.by_template[templateKey] || 0) + 1;
      });

      return stats;
    } catch (error) {
      this.logger.error('Error fetching email stats:', (error as Error).message);
      throw error;
    }
  }

  // Email Templates

  /**
   * Send user verification email with OTP code
   */
  async sendVerificationEmail(
    email: string,
    otp: string,
  ): Promise<boolean> {
    const result = await this.sendEmail({
      to: email,
      subject: `${otp} is your Trndinn verification code`,
      html_body: getVerificationTemplate(otp),
      text_body: `Your Trndinn verification code is: ${otp}. This code expires in 10 minutes.`,
      template_id: 'verification',
    });

    return result.success;
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(
    email: string,
    resetToken: string,
  ): Promise<boolean> {
    const resetUrl = `${this.configService.get('frontendUrl')}/reset-password?token=${resetToken}`;

    const result = await this.sendEmail({
      to: email,
      subject: 'Reset Your Trndinn Password',
      html_body: getPasswordResetTemplate(resetUrl),
      text_body: `Reset your password by visiting: ${resetUrl}`,
      template_id: 'password-reset',
    });

    return result.success;
  }

  /**
   * Send account upgrade confirmation email
   */
  async sendUpgradeConfirmationEmail(
    email: string,
    planName: string,
    amount: number,
  ): Promise<boolean> {
    const result = await this.sendEmail({
      to: email,
      subject: `Welcome to Trndinn ${planName}!`,
      html_body: getUpgradeTemplate(planName, amount),
      text_body: `Your account has been upgraded to ${planName} for $${amount}. Thank you for choosing Trndinn!`,
      template_id: 'upgrade',
    });

    return result.success;
  }

  /**
   * Send order receipt email
   */
  async sendOrderReceiptEmail(
    email: string,
    orderDetails: {
      orderId: string;
      planName: string;
      amount: number;
      credits: number;
      date: string;
    },
  ): Promise<boolean> {
    const result = await this.sendEmail({
      to: email,
      subject: `Receipt for Your Trndinn ${orderDetails.planName} Purchase`,
      html_body: getOrderReceiptTemplate(orderDetails),
      text_body: `Receipt: Order ${orderDetails.orderId} - ${orderDetails.planName} - $${orderDetails.amount}`,
      template_id: 'order-receipt',
    });

    return result.success;
  }

  /**
   * Send welcome email for new users
   */
  async sendWelcomeEmail(email: string, userName: string): Promise<boolean> {
    const frontendUrl = this.configService.get('frontendUrl') || 'http://localhost:5173';
    const result = await this.sendEmail({
      to: email,
      subject: 'Welcome to Trndinn - Your AI Content Journey Begins!',
      html_body: getWelcomeTemplate(userName, frontendUrl),
      text_body: `Welcome to Trndinn, ${userName}! Start creating amazing content with AI.`,
      template_id: 'welcome',
    });

    return result.success;
  }

  /**
   * Send user invitation email
   */
  async sendInvitationEmail(
    email: string,
    inviterName: string,
    inviteToken: string,
  ): Promise<boolean> {
    const inviteUrl = `${this.configService.get('frontendUrl')}/invite?token=${inviteToken}`;

    const result = await this.sendEmail({
      to: email,
      subject: `${inviterName} invited you to join Trndinn`,
      html_body: getInvitationTemplate(inviterName, inviteUrl),
      text_body: `${inviterName} invited you to join Trndinn. Accept invitation: ${inviteUrl}`,
      template_id: 'invitation',
    });

    return result.success;
  }
}
