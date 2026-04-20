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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { CareersService } from '../services/careers.service';
import {
  CareersJobCopyAiService,
  type JobCopyContext,
  type JobCopyField,
} from '../services/careers-job-copy-ai.service';

@ApiTags('admin-careers')
@Controller('admin/careers')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminCareersController {
  private readonly logger = new Logger(AdminCareersController.name);

  constructor(
    private readonly careersService: CareersService,
    private readonly careersJobCopyAi: CareersJobCopyAiService,
  ) {}

  @Post('ai/field')
  @ApiOperation({
    summary: 'Generate or refine one job section with AI (same stack as content refinement)',
  })
  async aiField(
    @Body()
    body: {
      field: JobCopyField;
      context: JobCopyContext;
      existingDraft?: string;
    },
  ) {
    try {
      const allowed: JobCopyField[] = [
        'summary',
        'description',
        'responsibilities',
        'requirements',
        'nice_to_have',
        'benefits',
        'team_overview',
        'equity_notes',
      ];
      if (!body?.field || !allowed.includes(body.field)) {
        throw new HttpException('Invalid field', HttpStatus.BAD_REQUEST);
      }
      if (!body?.context?.title?.trim()) {
        throw new HttpException('context.title is required', HttpStatus.BAD_REQUEST);
      }
      return await this.careersJobCopyAi.generateField(
        body.context,
        body.field,
        body.existingDraft,
      );
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'AI generation failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('ai/all-sections')
  @ApiOperation({
    summary:
      'Generate all long-form sections at once from title/category/location/etc. (AI)',
  })
  async aiAllSections(
    @Body()
    body: {
      context: JobCopyContext;
      existing?: Partial<Record<JobCopyField, string>>;
    },
  ) {
    try {
      if (!body?.context?.title?.trim()) {
        throw new HttpException('context.title is required', HttpStatus.BAD_REQUEST);
      }
      const sections = await this.careersJobCopyAi.generateAllSections(
        body.context,
        body.existing,
      );
      return { sections };
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'AI generation failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List all job postings (all statuses)' })
  async list() {
    try {
      return { jobs: await this.careersService.listJobsAdmin() };
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to list jobs',
        e.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('jobs')
  @ApiOperation({ summary: 'Create job (draft, scheduled, or published)' })
  async create(@Req() req: ExpressRequest, @Body() body: Record<string, unknown>) {
    try {
      const userId = (req as ExpressRequest & { user?: { id: string } }).user?.id;
      if (!userId) {
        throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
      }
      if (!(body?.title as string)?.trim()) {
        throw new HttpException('title is required', HttpStatus.BAD_REQUEST);
      }
      return await this.careersService.createJob(userId, body as any);
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Create failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get job + questions' })
  async getOne(@Param('id') id: string) {
    try {
      return await this.careersService.getJobAdmin(id);
    } catch (e: any) {
      if (e.status === 404) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Not found',
        e.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('jobs/:id')
  @ApiOperation({ summary: 'Update job and optionally replace questions' })
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    try {
      return await this.careersService.updateJob(id, body as any);
    } catch (e: any) {
      if (e.status === 404) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Update failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete('jobs/:id')
  @ApiOperation({ summary: 'Delete job and related data' })
  async remove(@Param('id') id: string) {
    try {
      return await this.careersService.deleteJob(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Delete failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('jobs/:id/applications')
  @ApiOperation({ summary: 'List applications for a job' })
  async applications(@Param('id') id: string) {
    try {
      return await this.careersService.listApplications(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to load applications',
        e.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
