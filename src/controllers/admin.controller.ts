import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationService } from '../services/notification.service';
import { OnboardingService } from '../services/onboarding.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    sub: string;
  };
}

interface CreateBroadcastDto {
  title: string;
  message: string;
  type?: 'info' | 'warning' | 'success';
  category?: 'marketing' | 'announcement';
  priority?: number;
  expiresAt?: string;
}

interface UpdateOnboardingConfigDto {
  enabled?: boolean;
  enabledAt?: string | null;
  questionVersion?: number;
  tourVersion?: number;
  tourSteps?: Record<string, boolean>;
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly onboardingService: OnboardingService,
  ) {}

  @Get('onboarding/config')
  @ApiOperation({ summary: 'Get onboarding feature flag config' })
  async getOnboardingConfig() {
    const data = await this.onboardingService.getConfig();
    return { success: true, data };
  }

  @Put('onboarding/config')
  @ApiOperation({ summary: 'Update onboarding feature flag config' })
  async updateOnboardingConfig(@Body() body: UpdateOnboardingConfigDto) {
    const data = await this.onboardingService.updateConfig({
      enabled: body.enabled,
      enabledAt: body.enabledAt,
      questionVersion: body.questionVersion,
      tourVersion: body.tourVersion,
      tourSteps: body.tourSteps,
    });
    return { success: true, data };
  }

  @Post('notifications/broadcast')
  @ApiOperation({ summary: 'Create a broadcast notification for all users' })
  async createBroadcastNotification(
    @Request() req: AuthenticatedRequest,
    @Body() body: CreateBroadcastDto,
  ) {
    try {
      // TODO: Add admin role check here
      // For now, allowing any authenticated user to create broadcast notifications
      // In production, you should check if the user has admin privileges
      // Example: if (!this.isAdmin(req.user.id)) throw new ForbiddenException();

      const { title, message, type, category, priority, expiresAt } = body;

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const notification =
        await this.notificationService.createBroadcastNotification(
          title,
          message,
          type || 'info',
          category || 'marketing',
          priority || 0,
          expiresAt ? new Date(expiresAt) : undefined,
        );

      if (!notification) {
        throw new HttpException(
          'Failed to create broadcast notification',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'Broadcast notification created successfully',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create broadcast notification',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('notifications/test-user')
  @ApiOperation({ summary: 'Send a test notification to a specific user' })
  async sendTestNotification(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      userId?: string;
      title: string;
      message: string;
      type?: 'success' | 'error' | 'warning' | 'info';
      category?: string;
    },
  ) {
    try {
      // TODO: Add admin role check here

      const { userId, title, message, type, category } = body;
      const targetUserId = userId || req.user.id; // Default to current user if no userId provided

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const validCategory =
        (category as
          | 'publishing'
          | 'generation'
          | 'scheduling'
          | 'system'
          | 'credits'
          | 'marketing'
          | 'announcement') || 'system';

      const notification = await this.notificationService.createNotification({
        userId: targetUserId,
        title,
        message,
        type: type || 'info',
        category: validCategory,
        data: { test: true, sentBy: req.user.id },
      });

      if (!notification) {
        throw new HttpException(
          'Failed to send test notification',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'Test notification sent successfully',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to send test notification',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('notifications/stats')
  @ApiOperation({ summary: 'Get notification statistics' })
  async getNotificationStats(@Request() req: AuthenticatedRequest) {
    try {
      // TODO: Add admin role check here

      // This is a placeholder for notification statistics
      // In a real implementation, you would query the database for actual stats
      return {
        success: true,
        data: {
          totalNotifications: 0,
          totalBroadcasts: 0,
          activeUsers: 0,
          notificationsSentToday: 0,
          averageReadRate: 0,
          topCategories: [],
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get notification statistics',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('notifications/marketing-campaign')
  @ApiOperation({ summary: 'Create a marketing campaign notification' })
  async createMarketingCampaign(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      title: string;
      message: string;
      priority?: number;
      expiresAt?: string;
      targetSegment?: 'all' | 'free' | 'paid' | 'inactive';
    },
  ) {
    try {
      // TODO: Add admin role check here

      const { title, message, priority, expiresAt, targetSegment } = body;

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      // For now, we'll create a simple broadcast notification
      // In the future, you could implement user segmentation logic here
      const notification =
        await this.notificationService.createBroadcastNotification(
          title,
          message,
          'info',
          'marketing',
          priority || 0,
          expiresAt ? new Date(expiresAt) : undefined,
        );

      if (!notification) {
        throw new HttpException(
          'Failed to create marketing campaign',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: `Marketing campaign created successfully${targetSegment ? ` for ${targetSegment} users` : ''}`,
        data: {
          ...notification,
          targetSegment: targetSegment || 'all',
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create marketing campaign',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('notifications/system-announcement')
  @ApiOperation({ summary: 'Create a system announcement' })
  async createSystemAnnouncement(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      title: string;
      message: string;
      type?: 'info' | 'warning' | 'success';
      priority?: number;
      expiresAt?: string;
    },
  ) {
    try {
      // TODO: Add admin role check here

      const { title, message, type, priority, expiresAt } = body;

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const notification =
        await this.notificationService.createBroadcastNotification(
          title,
          message,
          type || 'info',
          'announcement',
          priority || 1, // Higher priority for system announcements
          expiresAt ? new Date(expiresAt) : undefined,
        );

      if (!notification) {
        throw new HttpException(
          'Failed to create system announcement',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'System announcement created successfully',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create system announcement',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Helper method to check if user is admin (placeholder)
  // private async isAdmin(userId: string): Promise<boolean> {
  //   // TODO: Implement admin role check
  //   // This could check a user_roles table, profile metadata, or environment variables
  //   return false;
  // }
}
