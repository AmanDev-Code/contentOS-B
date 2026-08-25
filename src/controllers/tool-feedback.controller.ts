import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';

import { ToolFeedbackService } from '../services/tool-feedback.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';

interface AuthedRequest extends Request {
  user?: { id: string; sub: string };
}

/**
 * Tool Feedback Controller — Public endpoints for submitting/checking feedback,
 * plus admin endpoints for viewing per-tool feedback.
 */
@ApiTags('tool-feedback')
@Controller('')
export class ToolFeedbackController {
  private readonly logger = new Logger(ToolFeedbackController.name);

  constructor(private readonly toolFeedback: ToolFeedbackService) {}

  // ─── Public Endpoints (no auth required — tools work anonymously) ───────────

  /**
   * Check if user is eligible to see the feedback popup for a tool.
   * Returns eligible=true if they haven't given feedback yet.
   */
  @Get('tool-feedback/eligibility/:toolSlug')
  @ApiOperation({ summary: 'Check if user should see feedback popup for a tool' })
  async checkEligibility(
    @Param('toolSlug') toolSlug: string,
    @Req() req: AuthedRequest,
  ) {
    const userId = req.user?.id || req.user?.sub;
    const ip = this.getClientIp(req);

    const eligible = await this.toolFeedback.checkEligibility(toolSlug, userId, ip);

    return { eligible };
  }

  /**
   * Submit feedback for a tool.
   * Accepts star rating (1-5) and optional message.
   */
  @Post('tool-feedback/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit star rating + optional message for a tool' })
  async submitFeedback(
    @Body() body: { toolSlug: string; rating: number; message?: string },
    @Req() req: AuthedRequest,
  ) {
    const { toolSlug, rating, message } = body;

    if (!toolSlug) {
      return { success: false, error: 'toolSlug is required' };
    }
    if (!rating || rating < 1 || rating > 5) {
      return { success: false, error: 'rating must be 1-5' };
    }

    const userId = req.user?.id || req.user?.sub;
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'];

    const result = await this.toolFeedback.submit({
      toolSlug,
      rating,
      message,
      userId,
      ip,
      userAgent,
    });

    return result;
  }

  // ─── Admin Endpoints ────────────────────────────────────────────────────────

  /**
   * Admin: List feedback for a specific tool or all tools, paginated.
   */
  @Get('admin/tool-feedback')
  @UseGuards(AuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Get tool feedback with pagination and stats' })
  async listFeedback(
    @Query('toolSlug') toolSlug?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.toolFeedback.listFeedback({
      toolSlug,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? Math.min(parseInt(limit, 10), 100) : 20,
    });

    return result;
  }

  /**
   * Admin: Get stats for a specific tool.
   */
  @Get('admin/tool-feedback/stats/:toolSlug')
  @UseGuards(AuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Get aggregate stats for a tool' })
  async getToolStats(@Param('toolSlug') toolSlug: string) {
    const stats = await this.toolFeedback.getStats(toolSlug);
    return { toolSlug, ...stats };
  }

  /**
   * Admin: Get list of tools that have received feedback.
   */
  @Get('admin/tool-feedback/tools')
  @UseGuards(AuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: List tools with feedback' })
  async getToolsWithFeedback() {
    const tools = await this.toolFeedback.getToolsWithFeedback();
    return { tools };
  }

  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
