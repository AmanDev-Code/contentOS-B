import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOrApiKeyGuard } from '../guards/admin-or-apikey.guard';
import { RequireApiScope } from '../decorators/api-scope.decorator';
import { BlogService } from '../services/blog.service';

@ApiTags('admin-seo-pages')
@Controller('admin/seo/pages')
@ApiBearerAuth()
@UseGuards(AdminOrApiKeyGuard)
export class AdminSeoPagesController {
  private readonly logger = new Logger(AdminSeoPagesController.name);

  constructor(private readonly blogService: BlogService) {}

  @Get()
  @RequireApiScope('seo:read')
  @ApiOperation({ summary: 'List static page SEO rows' })
  async list() {
    try {
      return await this.blogService.listStaticPageSeo();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('one')
  @RequireApiScope('seo:read')
  @ApiOperation({ summary: 'Get SEO for one route (?route=/pricing)' })
  async one(@Query('route') route: string) {
    try {
      if (!route?.trim()) {
        throw new HttpException('route query required', HttpStatus.BAD_REQUEST);
      }
      return (await this.blogService.getStaticPageSeo(route)) || {};
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Put()
  @RequireApiScope('seo:write')
  @ApiOperation({ summary: 'Create or update static page SEO' })
  async upsert(@Body() body: Record<string, unknown>) {
    try {
      if (typeof body.route_path !== 'string' || !body.route_path.trim()) {
        throw new HttpException('route_path required', HttpStatus.BAD_REQUEST);
      }
      return await this.blogService.upsertStaticPageSeo(body as any);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Save failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete()
  @RequireApiScope('seo:write')
  @ApiOperation({ summary: 'Delete SEO row (?route=/pricing)' })
  async remove(@Query('route') route: string) {
    try {
      if (!route?.trim()) {
        throw new HttpException('route query required', HttpStatus.BAD_REQUEST);
      }
      return await this.blogService.deleteStaticPageSeo(route);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Delete failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
