import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';

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
      'noreply@postra.katana-ai.com';
    this.fromName =
      this.configService.get<string>('SMTP2GO_FROM_NAME') || 'Postra Team';

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
   * Send user verification email
   */
  async sendVerificationEmail(
    email: string,
    verificationToken: string,
  ): Promise<boolean> {
    const verificationUrl = `${this.configService.get('FRONTEND_URL')}/verify-email?token=${verificationToken}`;

    const result = await this.sendEmail({
      to: email,
      subject: 'Welcome to Postra - Verify Your Email',
      html_body: this.getVerificationEmailTemplate(verificationUrl),
      text_body: `Welcome to Postra! Please verify your email by visiting: ${verificationUrl}`,
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
    const resetUrl = `${this.configService.get('FRONTEND_URL')}/reset-password?token=${resetToken}`;

    const result = await this.sendEmail({
      to: email,
      subject: 'Reset Your Postra Password',
      html_body: this.getPasswordResetEmailTemplate(resetUrl),
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
      subject: `Welcome to Postra ${planName}!`,
      html_body: this.getUpgradeConfirmationTemplate(planName, amount),
      text_body: `Your account has been upgraded to ${planName} for $${amount}. Thank you for choosing Postra!`,
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
      subject: `Receipt for Your Postra ${orderDetails.planName} Purchase`,
      html_body: this.getOrderReceiptTemplate(orderDetails),
      text_body: `Receipt: Order ${orderDetails.orderId} - ${orderDetails.planName} - $${orderDetails.amount}`,
      template_id: 'order-receipt',
    });

    return result.success;
  }

  /**
   * Send welcome email for new users
   */
  async sendWelcomeEmail(email: string, userName: string): Promise<boolean> {
    const result = await this.sendEmail({
      to: email,
      subject: 'Welcome to Postra - Your AI Content Journey Begins!',
      html_body: this.getWelcomeEmailTemplate(userName),
      text_body: `Welcome to Postra, ${userName}! Start creating amazing content with AI.`,
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
    const inviteUrl = `${this.configService.get('FRONTEND_URL')}/invite?token=${inviteToken}`;

    const result = await this.sendEmail({
      to: email,
      subject: `${inviterName} invited you to join Postra`,
      html_body: this.getInvitationEmailTemplate(inviterName, inviteUrl),
      text_body: `${inviterName} invited you to join Postra. Accept invitation: ${inviteUrl}`,
      template_id: 'invitation',
    });

    return result.success;
  }

  // Email Template Methods

  private getVerificationEmailTemplate(verificationUrl: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: rgba(255,255,255,0.9); font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        .divider { height: 1px; background-color: #e2e8f0; margin: 30px 0; }
        @media (max-width: 600px) {
            .container { margin: 0 10px; }
            .header, .content, .footer { padding: 20px; }
            .title { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🚀 Postra</div>
            <div class="header-text">AI-Powered Content Creation Platform</div>
        </div>
        
        <div class="content">
            <h1 class="title">Welcome to Postra!</h1>
            <p class="text">
                Thank you for joining Postra, the ultimate AI-powered content creation platform. 
                To get started and unlock all features, please verify your email address.
            </p>
            
            <div style="text-align: center;">
                <a href="${verificationUrl}" class="button">Verify Email Address</a>
            </div>
            
            <div class="divider"></div>
            
            <p class="text" style="font-size: 14px;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="${verificationUrl}" style="color: #667eea; word-break: break-all;">${verificationUrl}</a>
            </p>
            
            <p class="text" style="font-size: 14px; color: #718096;">
                This verification link will expire in 24 hours. If you didn't create an account with Postra, 
                you can safely ignore this email.
            </p>
        </div>
        
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Need help? Contact us at <a href="mailto:support@postra.katana-ai.com" style="color: #667eea;">support@postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
  }

  private getPasswordResetEmailTemplate(resetUrl: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: rgba(255,255,255,0.9); font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        .alert { background-color: #fed7d7; border: 1px solid #feb2b2; color: #c53030; padding: 15px; border-radius: 8px; margin: 20px 0; }
        @media (max-width: 600px) {
            .container { margin: 0 10px; }
            .header, .content, .footer { padding: 20px; }
            .title { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🔐 Postra</div>
            <div class="header-text">Password Reset Request</div>
        </div>
        
        <div class="content">
            <h1 class="title">Reset Your Password</h1>
            <p class="text">
                We received a request to reset your password for your Postra account. 
                Click the button below to create a new password.
            </p>
            
            <div style="text-align: center;">
                <a href="${resetUrl}" class="button">Reset Password</a>
            </div>
            
            <div class="alert">
                <strong>⚠️ Security Notice:</strong> This link will expire in 1 hour for your security. 
                If you didn't request this reset, please ignore this email.
            </div>
            
            <p class="text" style="font-size: 14px;">
                If the button doesn't work, copy and paste this link:<br>
                <a href="${resetUrl}" style="color: #f5576c; word-break: break-all;">${resetUrl}</a>
            </p>
        </div>
        
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Need help? Contact us at <a href="mailto:support@postra.katana-ai.com" style="color: #f5576c;">support@postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
  }

  private getUpgradeConfirmationTemplate(
    planName: string,
    amount: number,
  ): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Account Upgraded - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: rgba(255,255,255,0.9); font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .highlight { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; margin: 30px 0; }
        .features { background-color: #f7fafc; padding: 20px; border-radius: 8px; margin: 30px 0; }
        .feature { display: flex; align-items: center; margin: 10px 0; }
        .feature-icon { color: #48bb78; margin-right: 10px; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) {
            .container { margin: 0 10px; }
            .header, .content, .footer { padding: 20px; }
            .title { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🎉 Postra</div>
            <div class="header-text">Account Successfully Upgraded</div>
        </div>
        
        <div class="content">
            <h1 class="title">Welcome to ${planName}!</h1>
            <p class="text">
                Congratulations! Your account has been successfully upgraded to <strong>${planName}</strong>. 
                You now have access to premium features and increased limits.
            </p>
            
            <div class="highlight">
                <h3 style="margin: 0 0 10px 0; font-size: 18px;">Upgrade Summary</h3>
                <p style="margin: 0; font-size: 16px;"><strong>${planName}</strong> - $${amount}</p>
            </div>
            
            <div class="features">
                <h4 style="margin: 0 0 15px 0; color: #2d3748;">What's New:</h4>
                <div class="feature">
                    <span class="feature-icon">✅</span>
                    <span>Increased AI credit limits</span>
                </div>
                <div class="feature">
                    <span class="feature-icon">✅</span>
                    <span>Priority content generation</span>
                </div>
                <div class="feature">
                    <span class="feature-icon">✅</span>
                    <span>Advanced scheduling features</span>
                </div>
                <div class="feature">
                    <span class="feature-icon">✅</span>
                    <span>Premium support</span>
                </div>
            </div>
            
            <p class="text">
                Ready to create amazing content? Log in to your dashboard and start exploring your new features.
            </p>
        </div>
        
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Questions? Contact us at <a href="mailto:support@postra.katana-ai.com" style="color: #4facfe;">support@postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
  }

  private getOrderReceiptTemplate(orderDetails: {
    orderId: string;
    planName: string;
    amount: number;
    credits: number;
    date: string;
  }): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Receipt - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background-color: #2d3748; padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: rgba(255,255,255,0.8); font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .receipt { background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 25px; margin: 30px 0; }
        .receipt-row { display: flex; justify-content: between; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
        .receipt-row:last-child { border-bottom: none; font-weight: 600; }
        .receipt-label { color: #4a5568; }
        .receipt-value { color: #1a202c; font-weight: 500; margin-left: auto; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) {
            .container { margin: 0 10px; }
            .header, .content, .footer { padding: 20px; }
            .title { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🧾 Postra</div>
            <div class="header-text">Order Receipt</div>
        </div>
        
        <div class="content">
            <h1 class="title">Thank You for Your Purchase!</h1>
            <p class="text">
                Your payment has been processed successfully. Here are the details of your order:
            </p>
            
            <div class="receipt">
                <div class="receipt-row">
                    <span class="receipt-label">Order ID:</span>
                    <span class="receipt-value">${orderDetails.orderId}</span>
                </div>
                <div class="receipt-row">
                    <span class="receipt-label">Plan:</span>
                    <span class="receipt-value">${orderDetails.planName}</span>
                </div>
                <div class="receipt-row">
                    <span class="receipt-label">Credits:</span>
                    <span class="receipt-value">${orderDetails.credits.toLocaleString()}</span>
                </div>
                <div class="receipt-row">
                    <span class="receipt-label">Date:</span>
                    <span class="receipt-value">${orderDetails.date}</span>
                </div>
                <div class="receipt-row">
                    <span class="receipt-label">Total:</span>
                    <span class="receipt-value">$${orderDetails.amount}</span>
                </div>
            </div>
            
            <p class="text">
                Your credits have been added to your account and are ready to use. 
                Start creating amazing content with AI right away!
            </p>
        </div>
        
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Need support? Email us at <a href="mailto:support@postra.katana-ai.com" style="color: #2d3748;">support@postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
  }

  private getWelcomeEmailTemplate(userName: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: rgba(255,255,255,0.9); font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .steps { background-color: #f7fafc; padding: 25px; border-radius: 8px; margin: 30px 0; }
        .step { margin: 15px 0; padding-left: 30px; position: relative; }
        .step-number { position: absolute; left: 0; top: 0; background: #667eea; color: white; width: 20px; height: 20px; border-radius: 50%; text-align: center; font-size: 12px; line-height: 20px; font-weight: bold; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) {
            .container { margin: 0 10px; }
            .header, .content, .footer { padding: 20px; }
            .title { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🎉 Postra</div>
            <div class="header-text">Welcome to AI-Powered Content Creation</div>
        </div>
        
        <div class="content">
            <h1 class="title">Welcome, ${userName}!</h1>
            <p class="text">
                Thank you for joining Postra! You're now part of a community that's revolutionizing 
                content creation with AI. Get ready to create engaging, viral content effortlessly.
            </p>
            
            <div class="steps">
                <h3 style="margin: 0 0 20px 0; color: #2d3748;">Getting Started:</h3>
                <div class="step">
                    <div class="step-number">1</div>
                    <strong>Complete your profile</strong> - Add your LinkedIn account for seamless posting
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <strong>Generate your first post</strong> - Use "Find Viral Topic" to get AI-generated content
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <strong>Schedule or publish</strong> - Post immediately or schedule for optimal timing
                </div>
            </div>
            
            <div style="text-align: center;">
                <a href="${this.configService.get('FRONTEND_URL')}/dashboard" class="button">Start Creating Content</a>
            </div>
            
            <p class="text">
                Need help getting started? Check out our <a href="#" style="color: #667eea;">quick start guide</a> 
                or reach out to our support team.
            </p>
        </div>
        
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Follow us: <a href="#" style="color: #667eea;">LinkedIn</a> | <a href="#" style="color: #667eea;">Twitter</a></p>
        </div>
    </div>
</body>
</html>`;
  }

  private getInvitationEmailTemplate(
    inviterName: string,
    inviteUrl: string,
  ): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>You're Invited to Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); padding: 40px 30px; text-align: center; }
        .logo { color: #2d3748; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: #4a5568; font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .inviter { background-color: #edf2f7; padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) {
            .container { margin: 0 10px; }
            .header, .content, .footer { padding: 20px; }
            .title { font-size: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">📧 Postra</div>
            <div class="header-text">You've Been Invited!</div>
        </div>
        
        <div class="content">
            <h1 class="title">Join Postra Today!</h1>
            
            <div class="inviter">
                <p style="margin: 0; color: #2d3748;"><strong>${inviterName}</strong> has invited you to join Postra</p>
            </div>
            
            <p class="text">
                Postra is an AI-powered content creation platform that helps you generate viral, 
                engaging content for LinkedIn and other social media platforms. Join thousands of 
                creators who are already using AI to boost their content strategy.
            </p>
            
            <div style="text-align: center;">
                <a href="${inviteUrl}" class="button">Accept Invitation</a>
            </div>
            
            <p class="text" style="font-size: 14px;">
                This invitation will expire in 7 days. If you're not interested, you can safely ignore this email.
            </p>
        </div>
        
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Learn more at <a href="${this.configService.get('FRONTEND_URL')}" style="color: #667eea;">postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
  }
}
