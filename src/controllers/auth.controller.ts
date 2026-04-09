import {
  Controller,
  Post,
  Body,
  Logger,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { AuthGuard } from '../guards/auth.guard';
import { GetUser } from '../decorators/get-user.decorator';

interface AuthWebhookPayload {
  type: string;
  schema?: string;
  table?: string;
  record: {
    id: string;
    email: string;
    email_confirmed_at?: string;
    user_metadata?: any;
    raw_user_meta_data?: any;
    app_metadata?: any;
    raw_app_meta_data?: any;
  };
  old_record?: {
    email_confirmed_at?: string;
  };
}

interface RegisterDto {
  email: string;
  password: string;
  username?: string;
  fullName?: string;
}

interface ForgotPasswordDto {
  email: string;
}

interface InviteUserDto {
  email: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  /**
   * Register a new user via Admin API (no Supabase email sent).
   * Returns userId; frontend then signs in with signInWithPassword.
   */
  @Post('register')
  async register(@Body() body: RegisterDto) {
    try {
      if (!body.email || !body.password) {
        return { success: false, message: 'Email and password are required' };
      }
      if (body.password.length < 6) {
        return {
          success: false,
          message: 'Password must be at least 6 characters',
        };
      }

      const result = await this.authService.registerUser({
        email: body.email,
        password: body.password,
        username: body.username,
        fullName: body.fullName,
      });

      return { success: true, userId: result.userId };
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.error('Registration error:', msg);

      if (
        msg.includes('already been registered') ||
        msg.includes('duplicate')
      ) {
        return {
          success: false,
          message: 'An account with this email already exists',
        };
      }
      return { success: false, message: msg || 'Registration failed' };
    }
  }

  /**
   * Handle Supabase auth webhooks
   * This endpoint receives webhooks from Supabase about user events
   */
  @Post('webhook')
  async handleAuthWebhook(@Body() payload: AuthWebhookPayload) {
    try {
      this.logger.log(
        'Received auth webhook:',
        JSON.stringify(payload, null, 2),
      );

      const { type, record } = payload;

      switch (type) {
        case 'INSERT':
          await this.authService.handleUserSignup({
            id: record.id,
            email: record.email,
            email_confirmed_at: record.email_confirmed_at,
            user_metadata: record.user_metadata || record.raw_user_meta_data,
            app_metadata: record.app_metadata || record.raw_app_meta_data || {},
          });
          break;

        case 'UPDATE':
          // With "Confirm email: OFF", Supabase auto-sets email_confirmed_at
          // on signup. We ignore this entirely — welcome email and "Email
          // Verified" notification are sent only when the user completes
          // our OTP verification (in verifyEmailToken).
          this.logger.log(
            `Ignoring UPDATE webhook for ${record.email} — verification handled via OTP`,
          );
          break;

        default:
          this.logger.log(`Unhandled auth webhook type: ${type}`);
      }

      return { success: true };
    } catch (error) {
      this.logger.error(
        'Error processing auth webhook:',
        (error as Error).message,
      );
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Request password reset
   */
  @Post('forgot-password')
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    try {
      await this.authService.handlePasswordResetRequest(body.email);

      // Always return success for security (don't reveal if email exists)
      return {
        success: true,
        message:
          'If an account with that email exists, a password reset link has been sent.',
      };
    } catch (error) {
      this.logger.error('Error in forgot password:', (error as Error).message);
      return {
        success: true,
        message:
          'If an account with that email exists, a password reset link has been sent.',
      };
    }
  }

  /**
   * Send user invitation
   */
  @Post('invite')
  @UseGuards(AuthGuard)
  async inviteUser(
    @Body() body: InviteUserDto,
    @GetUser() user: { id: string },
  ) {
    try {
      const success = await this.authService.sendUserInvitation(
        user.id,
        body.email,
      );

      if (success) {
        return { success: true, message: 'Invitation sent successfully' };
      } else {
        return { success: false, message: 'Failed to send invitation' };
      }
    } catch (error) {
      this.logger.error('Error sending invitation:', (error as Error).message);
      return { success: false, message: 'Failed to send invitation' };
    }
  }

  /**
   * Send OTP for a newly signed-up user (called by frontend right after signUp)
   */
  @Post('send-otp')
  @UseGuards(AuthGuard)
  async sendOtp(@GetUser() user: { id: string }) {
    try {
      const success = await this.authService.resendVerificationOtp(user.id);
      if (success) {
        return { success: true, message: 'Verification code sent' };
      }
      return { success: false, message: 'Could not send verification code' };
    } catch (error) {
      this.logger.error('Error sending OTP:', (error as Error).message);
      return { success: false, message: 'Could not send verification code' };
    }
  }

  /**
   * Verify email with OTP code
   */
  @Post('verify-otp')
  async verifyOtp(@Body() body: { otp: string }) {
    try {
      if (!body.otp || body.otp.length !== 6) {
        return { success: false, message: 'A 6-digit code is required' };
      }
      const success = await this.authService.verifyEmailToken(body.otp);
      if (success) {
        return { success: true, message: 'Email verified successfully' };
      }
      return { success: false, message: 'Invalid or expired code' };
    } catch (error) {
      this.logger.error('Error verifying OTP:', (error as Error).message);
      return { success: false, message: 'Invalid or expired code' };
    }
  }

  /**
   * Resend OTP verification code
   */
  @Post('resend-otp')
  @UseGuards(AuthGuard)
  async resendOtp(@GetUser() user: { id: string }) {
    try {
      const success = await this.authService.resendVerificationOtp(user.id);
      if (success) {
        return { success: true, message: 'Verification code sent' };
      }
      return { success: false, message: 'Could not send verification code' };
    } catch (error) {
      this.logger.error('Error resending OTP:', (error as Error).message);
      return { success: false, message: 'Could not send verification code' };
    }
  }

  /**
   * Verify email token (legacy link-based, kept for backward compat)
   */
  @Get('verify-email')
  async verifyEmail(@Query('token') token: string) {
    try {
      if (!token) {
        return { success: false, message: 'Token is required' };
      }
      const success = await this.authService.verifyEmailToken(token);
      if (success) {
        return { success: true, message: 'Email verified successfully' };
      }
      return { success: false, message: 'Invalid or expired token' };
    } catch (error) {
      this.logger.error('Error verifying email:', (error as Error).message);
      return { success: false, message: 'Invalid or expired token' };
    }
  }

  /**
   * Reset password with token (from our custom password reset email)
   */
  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; password: string }) {
    try {
      if (!body.token || !body.password) {
        return {
          success: false,
          message: 'Token and password are required',
        };
      }
      const success = await this.authService.resetPasswordWithToken(
        body.token,
        body.password,
      );
      if (success) {
        return { success: true, message: 'Password updated successfully' };
      }
      return {
        success: false,
        message: 'Invalid or expired token',
      };
    } catch (error) {
      this.logger.error('Error resetting password:', (error as Error).message);
      return {
        success: false,
        message: 'Failed to reset password',
      };
    }
  }

  /**
   * Accept invitation
   */
  @Get('accept-invitation')
  async acceptInvitation(@Query('token') token: string) {
    try {
      if (!token) {
        return { success: false, message: 'Token is required' };
      }

      // This would need to be implemented to handle invitation acceptance
      // For now, return a placeholder response
      return { success: true, message: 'Invitation is valid' };
    } catch (error) {
      this.logger.error(
        'Error accepting invitation:',
        (error as Error).message,
      );
      return { success: false, message: 'Invalid or expired invitation' };
    }
  }
}
