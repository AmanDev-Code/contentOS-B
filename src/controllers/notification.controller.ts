import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Param,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import {
  NotificationService,
  CreateNotificationDto,
} from '../services/notification.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    sub: string;
  };
}

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard, PaywallGuard)
@ApiBearerAuth()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'Get notifications for the current user' })
  async getNotifications(
    @Request() req: AuthenticatedRequest,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    try {
      const userId = req.user.id;
      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const result = await this.notificationService.getNotifications(
        userId,
        pageNum,
        limitNum,
      );

      return {
        success: true,
        data: result.notifications,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: result.total,
          pages: Math.ceil(result.total / limitNum),
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch notifications',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count' })
  async getUnreadCount(@Request() req: AuthenticatedRequest) {
    try {
      const userId = req.user.id;
      const count = await this.notificationService.getUnreadCount(userId);

      return {
        success: true,
        count,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get unread count',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markAsRead(
    @Request() req: AuthenticatedRequest,
    @Param('id') notificationId: string,
  ) {
    try {
      const userId = req.user.id;
      const success = await this.notificationService.markAsRead(
        notificationId,
        userId,
      );

      if (!success) {
        throw new HttpException(
          'Failed to mark notification as read',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        message: 'Notification marked as read',
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to mark notification as read',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('mark-all-read')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllAsRead(@Request() req: AuthenticatedRequest) {
    try {
      const userId = req.user.id;
      const success = await this.notificationService.markAllAsRead(userId);

      if (!success) {
        throw new HttpException(
          'Failed to mark all notifications as read',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        message: 'All notifications marked as read',
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to mark all notifications as read',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('stream')
  @ApiOperation({
    summary: 'Server-Sent Events stream for real-time notifications',
  })
  async streamNotifications(
    @Request() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const userId = req.user.id;
    // Tell Fastify we are taking full control of raw response lifecycle (SSE).
    reply.hijack();
    const res = reply.raw;
    const origin = (req as any)?.headers?.origin || '*';

    // Keep SSE headers minimal; global CORS middleware handles CORS headers.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // For hijacked Fastify responses, set CORS headers explicitly.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.writeHead(200);

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    this.notificationService.addSSEClient(userId, res);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
        this.notificationService.removeSSEClient(res);
      }
    }, 30000);

    // Listen on response/socket close (not request close), otherwise
    // Fastify can emit request close early and drop SSE immediately.
    res.on('close', () => {
      clearInterval(heartbeat);
      this.notificationService.removeSSEClient(res);
    });
  }

  // Admin-only endpoints for broadcast notifications
  @Post('broadcast')
  @ApiOperation({ summary: 'Create a broadcast notification (admin only)' })
  async createBroadcastNotification(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      title: string;
      message: string;
      type?: 'info' | 'warning' | 'success';
      category?: 'marketing' | 'announcement';
      priority?: number;
      expiresAt?: string;
    },
  ) {
    try {
      // TODO: Add admin role check here
      // For now, allowing any authenticated user to create broadcast notifications
      // In production, you should check if the user has admin privileges

      const notification =
        await this.notificationService.createBroadcastNotification(
          body.title,
          body.message,
          body.type || 'info',
          body.category || 'marketing',
          body.priority || 0,
          body.expiresAt ? new Date(body.expiresAt) : undefined,
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
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('test')
  @ApiOperation({ summary: 'Create a test notification (development only)' })
  async createTestNotification(@Request() req: AuthenticatedRequest) {
    try {
      const userId = req.user.id;

      const notification = await this.notificationService.createNotification({
        userId,
        title: '🧪 Test Notification',
        message:
          'This is a test notification to verify the system is working correctly.',
        type: 'info',
        category: 'system',
        data: { test: true, timestamp: Date.now() },
      });

      return {
        success: true,
        message: 'Test notification created',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create test notification',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
