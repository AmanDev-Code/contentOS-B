import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { EmailService } from './email.service';
import { NotificationService } from './notification.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly emailService: EmailService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Handle user signup event
   * This should be called when a user signs up (can be triggered by Supabase webhook)
   */
  async handleUserSignup(userData: {
    id: string;
    email: string;
    email_confirmed_at?: string;
    user_metadata?: any;
  }): Promise<void> {
    try {
      this.logger.log(`Handling user signup for: ${userData.email}`);

      // If email is not confirmed, send verification email
      if (!userData.email_confirmed_at) {
        // Generate verification token (you might want to use Supabase's built-in confirmation)
        const verificationToken = this.generateToken();

        // Store token in database for verification
        await this.supabaseService
          .getServiceClient()
          .from('user_verification_tokens')
          .insert({
            user_id: userData.id,
            token: verificationToken,
            type: 'email_verification',
            expires_at: new Date(
              Date.now() + 24 * 60 * 60 * 1000,
            ).toISOString(), // 24 hours
          });

        // Send verification email
        await this.emailService.sendVerificationEmail(
          userData.email,
          verificationToken,
        );
      } else {
        // Email is already confirmed, send welcome email
        const userName =
          userData.user_metadata?.full_name || userData.email.split('@')[0];
        await this.emailService.sendWelcomeEmail(userData.email, userName);
      }

      // Create welcome notification
      await this.notificationService.createNotification({
        userId: userData.id,
        title: 'Welcome to Postra!',
        message:
          'Your account has been created successfully. Start creating amazing content with AI.',
        type: 'success',
        category: 'system',
      });
    } catch (error) {
      this.logger.error(`Error handling user signup: ${error.message}`);
    }
  }

  /**
   * Handle email confirmation event
   */
  async handleEmailConfirmation(userData: {
    id: string;
    email: string;
    user_metadata?: any;
  }): Promise<void> {
    try {
      this.logger.log(`Handling email confirmation for: ${userData.email}`);

      // Send welcome email
      const userName =
        userData.user_metadata?.full_name || userData.email.split('@')[0];
      await this.emailService.sendWelcomeEmail(userData.email, userName);

      // Create notification
      await this.notificationService.createNotification({
        userId: userData.id,
        title: 'Email Verified!',
        message:
          'Your email has been verified successfully. You can now access all features.',
        type: 'success',
        category: 'system',
      });
    } catch (error) {
      this.logger.error(`Error handling email confirmation: ${error.message}`);
    }
  }

  /**
   * Handle password reset request
   */
  async handlePasswordResetRequest(email: string): Promise<boolean> {
    try {
      this.logger.log(`Handling password reset request for: ${email}`);

      const { data } = await this.supabaseService
        .getServiceClient()
        .auth.admin.listUsers({ page: 1, perPage: 1000 });

      const users = data?.users ?? [];
      const user = users.find((u: { email?: string }) => u.email === email);
      if (!user) {
        this.logger.warn(
          `Password reset requested for non-existent email: ${email}`,
        );
        return false;
      }

      const resetToken = this.generateToken();

      await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .insert({
          user_id: user.id,
          token: resetToken,
          type: 'password_reset',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });

      await this.emailService.sendPasswordResetEmail(email, resetToken);
      return true;
    } catch (error) {
      this.logger.error(
        `Error handling password reset request: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Reset password using token
   */
  async resetPasswordWithToken(
    token: string,
    newPassword: string,
  ): Promise<boolean> {
    try {
      const { data: row } = await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .select('user_id, expires_at')
        .eq('token', token)
        .eq('type', 'password_reset')
        .is('used_at', null)
        .single();

      if (!row || new Date(row.expires_at) < new Date()) {
        return false;
      }

      await this.supabaseService
        .getServiceClient()
        .auth.admin.updateUserById(row.user_id, { password: newPassword });

      await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token', token);

      return true;
    } catch (error) {
      this.logger.error(`Error resetting password: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify email token and confirm user
   */
  async verifyEmailToken(token: string): Promise<boolean> {
    try {
      const { data: row } = await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .select('user_id, expires_at')
        .eq('token', token)
        .eq('type', 'email_verification')
        .is('used_at', null)
        .single();

      if (!row || new Date(row.expires_at) < new Date()) {
        return false;
      }

      await this.supabaseService
        .getServiceClient()
        .auth.admin.updateUserById(row.user_id, {
          email_confirm: true,
        });

      await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token', token);

      return true;
    } catch (error) {
      this.logger.error(`Error verifying email: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle subscription upgrade
   */
  async handleSubscriptionUpgrade(
    userId: string,
    planName: string,
    amount: number,
  ): Promise<void> {
    try {
      this.logger.log(`Handling subscription upgrade for user: ${userId}`);

      const { data: { user } } = await this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(userId);

      if (!user?.email) {
        this.logger.warn(`No email found for user: ${userId}`);
        return;
      }

      await this.emailService.sendUpgradeConfirmationEmail(
        user.email,
        planName,
        amount,
      );

      // Create notification
      await this.notificationService.createNotification({
        userId: userId,
        title: `Upgraded to ${planName}!`,
        message: `Your account has been upgraded to ${planName}. Enjoy your new features!`,
        type: 'success',
        category: 'credits',
      });
    } catch (error) {
      this.logger.error(
        `Error handling subscription upgrade: ${error.message}`,
      );
    }
  }

  /**
   * Handle order completion
   */
  async handleOrderCompletion(orderDetails: {
    userId: string;
    orderId: string;
    planName: string;
    amount: number;
    credits: number;
    date: string;
  }): Promise<void> {
    try {
      this.logger.log(
        `Handling order completion for user: ${orderDetails.userId}`,
      );

      const { data: { user } } = await this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(orderDetails.userId);

      if (!user?.email) {
        this.logger.warn(`No email found for user: ${orderDetails.userId}`);
        return;
      }

      await this.emailService.sendOrderReceiptEmail(
        user.email,
        orderDetails,
      );

      // Create notification
      await this.notificationService.createNotification({
        userId: orderDetails.userId,
        title: 'Payment Received!',
        message: `Your payment of $${orderDetails.amount} has been processed successfully.`,
        type: 'success',
        category: 'credits',
      });
    } catch (error) {
      this.logger.error(`Error handling order completion: ${error.message}`);
    }
  }

  /**
   * Send user invitation
   */
  async sendUserInvitation(
    inviterUserId: string,
    email: string,
  ): Promise<boolean> {
    try {
      this.logger.log(
        `Sending user invitation from ${inviterUserId} to ${email}`,
      );

      const { data: { user: inviterUser } } = await this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(inviterUserId);

      if (!inviterUser) {
        this.logger.warn(`Inviter not found: ${inviterUserId}`);
        return false;
      }

      const inviteToken = this.generateToken();

      await this.supabaseService
        .getServiceClient()
        .from('user_invitations')
        .insert({
          inviter_id: inviterUserId,
          email: email,
          token: inviteToken,
          expires_at: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });

      const inviterName =
        inviterUser.user_metadata?.full_name || inviterUser.email?.split('@')[0] || 'Someone';
      await this.emailService.sendInvitationEmail(
        email,
        inviterName,
        inviteToken,
      );

      return true;
    } catch (error) {
      this.logger.error(`Error sending user invitation: ${error.message}`);
      return false;
    }
  }

  /**
   * Generate a secure random token
   */
  private generateToken(): string {
    return require('crypto').randomBytes(32).toString('hex');
  }
}
