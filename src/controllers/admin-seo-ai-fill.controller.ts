import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { SeoAiFillService } from '../services/seo-ai-fill.service';

@ApiTags('admin-seo-pages')
@Controller('admin/seo/ai-fill')
@ApiBearerAuth()
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
export class AdminSeoAiFillController {
  private readonly logger = new Logger(AdminSeoAiFillController.name);

  constructor(private readonly seoAiFillService: SeoAiFillService) {}

  @Post()
  @ApiOperation({ summary: 'AI-generate SEO fields for a marketing route' })
  async fill(
    @Body()
    body: {
      route: string;
      prompt?: string;
      primaryKeyword?: string;
    },
  ) {
    try {
      if (!body.route?.trim()) {
        throw new HttpException('route is required', HttpStatus.BAD_REQUEST);
      }
      return await this.seoAiFillService.generateSeoFields({
        route: body.route.trim(),
        prompt: body.prompt,
        primaryKeyword: body.primaryKeyword,
      });
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      this.logger.error(err?.message);
      throw new HttpException(
        err?.message || 'AI fill failed',
        err?.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
