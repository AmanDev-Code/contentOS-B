import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import type { AuthenticatedRequest } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { SeoKeywordsService } from '../services/seo-keywords.service';
import type {
  BulkUpsertAssignmentsDto,
  CreateKeywordDto,
  UpdateKeywordDto,
  UpsertAssignmentDto,
} from '../services/seo-keywords.service';

@ApiTags('admin-seo-keywords')
@Controller('admin/seo/keywords')
@ApiBearerAuth()
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
export class AdminSeoKeywordsController {
  private readonly logger = new Logger(AdminSeoKeywordsController.name);

  constructor(private readonly seoKeywordsService: SeoKeywordsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // KEYWORDS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get()
  @ApiOperation({ summary: 'List keywords with optional filters' })
  async list(
    @Query('status') status?: string,
    @Query('cluster') cluster?: string,
    @Query('intent') intent?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.seoKeywordsService.getAllKeywords({
        status,
        cluster,
        intent,
        q,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      });
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create a new keyword' })
  async create(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      const actorId = req.user?.id;
      return await this.seoKeywordsService.createKeyword({
        ...(body as unknown as CreateKeywordDto),
        actorId,
      });
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a keyword' })
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      const actorId = req.user?.id;
      return await this.seoKeywordsService.updateKeyword(id, {
        ...(body as unknown as UpdateKeywordDto),
        actorId,
      });
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive a keyword (soft delete)' })
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    try {
      const actorId = req.user?.id;
      await this.seoKeywordsService.deleteKeyword(id, actorId);
      return { success: true };
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('bulk-import')
  @ApiOperation({ summary: 'Bulk import keywords from array or CSV text' })
  async bulkImport(
    @Body()
    body: {
      keywords: string[] | string;
      cluster?: string | null;
      intent?: string;
      priority?: number;
      language?: string;
      status?: string;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      const actorId = req.user?.id;
      const raw = Array.isArray(body.keywords)
        ? body.keywords
        : String(body.keywords).split(/[\n,]+/);
      return await this.seoKeywordsService.bulkImport(
        raw,
        {
          cluster: body.cluster,
          intent: body.intent,
          priority: body.priority,
          language: body.language,
          status: body.status,
        },
        actorId,
      );
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('bulk-status')
  @ApiOperation({ summary: 'Bulk update keyword status' })
  async bulkStatus(
    @Body() body: { ids: string[]; status: string },
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        throw new HttpException(
          'ids must be a non-empty array',
          HttpStatus.BAD_REQUEST,
        );
      }
      const actorId = req.user?.id;
      const count = await this.seoKeywordsService.bulkUpdateStatus(
        body.ids,
        body.status,
        actorId,
      );
      return { success: true, updated: count };
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('bulk-delete')
  @ApiOperation({
    summary: 'Permanently delete selected keywords (assignments cascade)',
  })
  async bulkDelete(
    @Body() body: { ids: string[] },
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        throw new HttpException(
          'ids must be a non-empty array',
          HttpStatus.BAD_REQUEST,
        );
      }
      const actorId = req.user?.id;
      return await this.seoKeywordsService.bulkPermanentDelete(
        body.ids,
        actorId,
      );
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('clusters')
  @ApiOperation({ summary: 'List keyword clusters with stats' })
  async getClusters() {
    try {
      return await this.seoKeywordsService.getClusters();
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}

@ApiTags('admin-seo-assignments')
@Controller('admin/seo/assignments')
@ApiBearerAuth()
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
export class AdminSeoAssignmentsController {
  private readonly logger = new Logger(AdminSeoAssignmentsController.name);

  constructor(private readonly seoKeywordsService: SeoKeywordsService) {}

  @Get()
  @ApiOperation({ summary: 'Get keyword assignments for a target' })
  async list(
    @Query('target_type') targetType: string,
    @Query('target_ref') targetRef: string,
  ) {
    try {
      if (!targetType || !targetRef) {
        throw new HttpException(
          'target_type and target_ref are required',
          HttpStatus.BAD_REQUEST,
        );
      }
      return await this.seoKeywordsService.getAssignments(
        targetType,
        targetRef,
      );
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create or update an assignment' })
  async upsert(@Body() body: Record<string, unknown>) {
    try {
      return await this.seoKeywordsService.upsertAssignment(
        body as unknown as UpsertAssignmentDto,
      );
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Bulk create or update assignments for one target' })
  async bulkUpsert(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    try {
      const actorId = req.user?.id;
      return await this.seoKeywordsService.bulkUpsertAssignments(
        body as unknown as BulkUpsertAssignmentsDto,
        actorId,
      );
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove an assignment' })
  async remove(@Param('id') id: string) {
    try {
      await this.seoKeywordsService.deleteAssignment(id);
      return { success: true };
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err.message);
      throw new HttpException(
        err.message || 'Failed',
        err.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
