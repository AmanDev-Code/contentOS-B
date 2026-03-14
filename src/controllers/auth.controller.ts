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
  record: {
    id: string;
    email: string;
    email_confirmed_at?: string;
    email_confirmed_at_old?: string;
    user_metadata?: any;
    raw_user_meta_data?: any;
  };
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
          // New user signup
          await this.authService.handleUserSignup({
            id: record.id,
            email: record.email,
            email_confirmed_at: record.email_confirmed_at,
            user_metadata: record.user_metadata || record.raw_user_meta_data,
          });
          break;

        case 'UPDATE':
          // Check if email was just confirmed
          if (record.email_confirmed_at && !record.email_confirmed_at_old) {
            await this.authService.handleEmailConfirmation({
              id: record.id,
              email: record.email,
              user_metadata: record.user_metadata || record.raw_user_meta_data,
            });
          }
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
   * Verify email token
   */
  @Get('verify-email')
  async verifyEmail(@Query('token') token: string) {
    try {
      if (!token) {
        return { success: false, message: 'Token is required' };
      }

      // This would need to be implemented to verify the token
      // For now, return a placeholder response
      return { success: true, message: 'Email verified successfully' };
    } catch (error) {
      this.logger.error('Error verifying email:', (error as Error).message);
      return { success: false, message: 'Invalid or expired token' };
    }
  }

  /**
   * Verify password reset token
   */
  @Get('verify-reset-token')
  async verifyResetToken(@Query('token') token: string) {
    try {
      if (!token) {
        return { success: false, message: 'Token is required' };
      }

      // This would need to be implemented to verify the token
      // For now, return a placeholder response
      return { success: true, message: 'Token is valid' };
    } catch (error) {
      this.logger.error(
        'Error verifying reset token:',
        (error as Error).message,
      );
      return { success: false, message: 'Invalid or expired token' };
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
