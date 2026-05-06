import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { EmailService } from './email.service';
import { NotificationService } from './notification.service';


@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly emailService: EmailService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Register a new user via Admin API (bypasses Supabase built-in emails entirely).
   * Creates the user, verification token, sends OTP, and creates notification.
   */
  async registerUser(data: {
    email: string;
    password: string;
    username?: string;
    fullName?: string;
  }): Promise<{ userId: string }> {
    const { email, password, username, fullName } = data;

    const { data: newUser, error } = await this.supabaseService
      .getServiceClient()
      .auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          username: username || undefined,
          full_name: fullName || undefined,
        },
      });

    if (error) {
      this.logger.error(`Admin createUser failed: ${error.message}`);
      throw new Error(error.message);
    }

    const userId = newUser.user.id;

    const otp = this.generateOtp();

    await this.supabaseService
      .getServiceClient()
      .from('user_verification_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('type', 'email_verification');

    await this.supabaseService
      .getServiceClient()
      .from('user_verification_tokens')
      .insert({
        user_id: userId,
        token: otp,
        type: 'email_verification',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

    // Fire email + notification in background so the response returns fast
    this.emailService.sendVerificationEmail(email, otp).catch((err) => {
      this.logger.error(`Background OTP email failed: ${err.message}`);
    });

    this.notificationService
      .createNotification({
        userId,
        title: 'Verify your email',
        message:
          'Enter the 6-digit verification code to access your dashboard.',
        type: 'info',
        category: 'system',
      })
      .catch((err) => {
        this.logger.error(`Background notification failed: ${err.message}`);
      });

    return { userId };
  }

  /**
   * Handle user signup event (from Supabase webhook INSERT).
   * For email signups registered via /auth/register, the token and OTP
   * are already created — this handler skips duplicate work.
   */
  async handleUserSignup(userData: {
    id: string;
    email: string;
    email_confirmed_at?: string;
    user_metadata?: any;
    app_metadata?: any;
  }): Promise<void> {
    try {
      this.logger.log(`Handling user signup for: ${userData.email}`);

      const provider =
        userData.app_metadata?.provider ||
        userData.app_metadata?.providers?.[0];

      if (provider === 'email') {
        // Check if registerUser() already created a verification token
        const { data: existingToken } = await this.supabaseService
          .getServiceClient()
          .from('user_verification_tokens')
          .select('id')
          .eq('user_id', userData.id)
          .eq('type', 'email_verification')
          .is('used_at', null)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle();

        if (existingToken) {
          this.logger.log(
            `Verification token already exists for ${userData.email} — skipping webhook duplicate`,
          );
          return;
        }

        const placeholder = this.generateOtp();

        await this.supabaseService
          .getServiceClient()
          .from('user_verification_tokens')
          .delete()
          .eq('user_id', userData.id)
          .eq('type', 'email_verification');

        await this.supabaseService
          .getServiceClient()
          .from('user_verification_tokens')
          .insert({
            user_id: userData.id,
            token: placeholder,
            type: 'email_verification',
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          });

        await this.notificationService.createNotification({
          userId: userData.id,
          title: 'Verify your email',
          message:
            'Enter the 6-digit verification code to access your dashboard.',
          type: 'info',
          category: 'system',
        });
      } else {
        const userName =
          userData.user_metadata?.full_name || userData.email.split('@')[0];
        await this.emailService.sendWelcomeEmail(userData.email, userName);

        await this.notificationService.createNotification({
          userId: userData.id,
          title: 'Welcome to Trndinn!',
          message:
            'Your account has been created successfully. Start creating amazing content with AI.',
          type: 'success',
          category: 'system',
        });
      }
    } catch (error) {
      this.logger.error(`Error handling user signup: ${error.message}`);
    }
  }

  /**
   * Handle email confirmation event (from Supabase webhook UPDATE)
   * Only fires welcome/notification if user has completed our OTP verification
   * (no pending verification tokens remain).
   */
  async handleEmailConfirmation(userData: {
    id: string;
    email: string;
    user_metadata?: any;
  }): Promise<void> {
    try {
      this.logger.log(`Handling email confirmation for: ${userData.email}`);

      const { data: pendingToken } = await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .select('id')
        .eq('user_id', userData.id)
        .eq('type', 'email_verification')
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (pendingToken) {
        this.logger.log(
          `Skipping email-confirmed notification for ${userData.email} — OTP verification still pending`,
        );
        return;
      }

      const userName =
        userData.user_metadata?.full_name || userData.email.split('@')[0];
      await this.emailService.sendWelcomeEmail(userData.email, userName);

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
   * Verify email with OTP code
   */
  async verifyEmailToken(token: string): Promise<boolean> {
    try {
      const { data: row } = await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .select('user_id, expires_at')
        .eq('token', token.trim())
        .eq('type', 'email_verification')
        .is('used_at', null)
        .single();

      if (!row || new Date(row.expires_at) < new Date()) {
        return false;
      }

      await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token', token.trim());

      const {
        data: { user },
      } = await this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(row.user_id);

      if (user?.email) {
        const userName =
          user.user_metadata?.full_name || user.email.split('@')[0];
        await this.emailService.sendWelcomeEmail(user.email, userName);

        await this.notificationService.createNotification({
          userId: row.user_id,
          title: 'Email Verified!',
          message:
            'Your email has been verified successfully. You can now access all features.',
          type: 'success',
          category: 'system',
        });
      }

      return true;
    } catch (error) {
      this.logger.error(`Error verifying email: ${error.message}`);
      return false;
    }
  }

  /**
   * Resend OTP verification code
   */
  async resendVerificationOtp(userId: string): Promise<boolean> {
    try {
      const {
        data: { user },
      } = await this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(userId);

      if (!user?.email) return false;

      await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .delete()
        .eq('user_id', userId)
        .eq('type', 'email_verification');

      const otp = this.generateOtp();

      await this.supabaseService
        .getServiceClient()
        .from('user_verification_tokens')
        .insert({
          user_id: userId,
          token: otp,
          type: 'email_verification',
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });

      this.emailService.sendVerificationEmail(user.email, otp).catch((err) => {
        this.logger.error(`Background resend OTP email failed: ${err.message}`);
      });

      return true;
    } catch (error) {
      this.logger.error(`Error resending OTP: ${error.message}`);
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

      const {
        data: { user },
      } = await this.supabaseService
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

      const {
        data: { user },
      } = await this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(orderDetails.userId);

      if (!user?.email) {
        this.logger.warn(`No email found for user: ${orderDetails.userId}`);
        return;
      }

      await this.emailService.sendOrderReceiptEmail(user.email, orderDetails);

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

      const {
        data: { user: inviterUser },
      } = await this.supabaseService
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
        inviterUser.user_metadata?.full_name ||
        inviterUser.email?.split('@')[0] ||
        'Someone';
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

  // ─── Google OAuth ────────────────────────────────────────────────────────────

  /**
   * Generate a Google OAuth consent URL via Supabase.
   * Uses a per-request Supabase client with Map-based storage so the PKCE code
   * verifier is captured server-side and persisted in Redis for the callback.
   */
  async initiateGoogleOAuth(): Promise<{ url: string }> {
    const supabaseUrl = this.configService.get<string>('supabase.url') ?? '';
    const redirectTo =
      this.configService.get<string>('google.oauthCallbackUrl') ??
      'http://localhost:8080/auth/callback';

    // Supabase handles PKCE + state entirely on its own side (the registered
    // redirect URI in Google Console points to Supabase's /auth/v1/callback).
    // We just need to send the browser to Supabase's authorize endpoint with
    // the provider and the post-auth destination for the user.
    const authorizeUrl = new URL(`${supabaseUrl}/auth/v1/authorize`);
    authorizeUrl.searchParams.set('provider', 'google');
    authorizeUrl.searchParams.set('redirect_to', redirectTo);

    return { url: authorizeUrl.toString() };
  }

  /**
   * Exchange the OAuth authorisation code for a Supabase session.
   * Restores the PKCE code verifier stored during initiateGoogleOAuth so that
   * Supabase can validate the code_challenge / code_verifier pair.
   */
  async handleGoogleOAuthCallback(
    code: string,
    _state: string,
  ): Promise<Session> {
    // Supabase handles the Google → Supabase callback itself (registered redirect
    // URI is https://<project>.supabase.co/auth/v1/callback). After processing,
    // Supabase redirects the browser to `redirect_to` (the frontend /auth/callback
    // page) with the session tokens in the URL fragment/query. This backend endpoint
    // is therefore not part of the normal flow, but we keep it as a fallback in case
    // a custom redirect_to pointing here is ever configured.
    const supabaseUrl = this.configService.get<string>('supabase.url') ?? '';
    const supabaseAnonKey =
      this.configService.get<string>('supabase.anonKey') ?? '';

    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: false },
    });

    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error || !data?.session) {
      throw new Error(error?.message ?? 'Code exchange failed');
    }

    return data.session;
  }

  /**
   * Verify a Google ID token (for native mobile clients).
   * Returns a Supabase session on success.
   */
  async verifyGoogleIdToken(idToken: string): Promise<Session> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .auth.signInWithIdToken({ provider: 'google', token: idToken });

    if (error || !data?.session) {
      throw new Error(error?.message ?? 'Failed to verify Google ID token');
    }

    return data.session;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Generate a secure random token
   */
  private generateToken(): string {
    return require('crypto').randomBytes(32).toString('hex');
  }

  /**
   * Generate a 6-digit OTP code
   */
  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
