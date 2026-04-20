import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CareersService } from '../services/careers.service';

@ApiTags('careers')
@Controller('careers')
export class CareersController {
  private readonly logger = new Logger(CareersController.name);

  constructor(private readonly careersService: CareersService) {}

  @Get('categories')
  @ApiOperation({ summary: 'List categories for published jobs' })
  async categories() {
    try {
      const categories = await this.careersService.listCategoriesPublic();
      return { categories };
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to load categories',
        e.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List published jobs (optional category filter)' })
  async listJobs(@Query('category') category?: string) {
    try {
      const jobs = await this.careersService.listPublicJobs(category);
      return { jobs };
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to load jobs',
        e.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('jobs/:slug')
  @ApiOperation({ summary: 'Get published job with screening questions' })
  async getJob(@Param('slug') slug: string) {
    try {
      return await this.careersService.getPublicJobBySlug(slug);
    } catch (e: any) {
      if (e.status === 404) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to load job',
        e.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('jobs/:slug/apply')
  @ApiOperation({ summary: 'Submit application (JSON + base64 attachments)' })
  async apply(
    @Param('slug') slug: string,
    @Body()
    body: {
      full_name: string;
      email: string;
      phone?: string;
      location?: string;
      linkedin_url?: string;
      portfolio_url?: string;
      cover_letter?: string;
      answers?: Record<string, string | string[] | number | boolean>;
      attachments?: Array<{
        purpose: string;
        filename: string;
        mime_type: string;
        data_base64: string;
      }>;
    },
  ) {
    try {
      if (!body?.full_name?.trim() || !body?.email?.trim()) {
        throw new HttpException(
          'full_name and email are required',
          HttpStatus.BAD_REQUEST,
        );
      }
      return await this.careersService.applyToJob(slug, body);
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Application failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
