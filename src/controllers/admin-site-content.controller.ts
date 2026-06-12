import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import {
  SiteContentService,
  type AnnouncementVariant,
} from '../services/site-content.service';
import type { PricingMeta } from '../config/pricing-features';

const VARIANTS = ['info', 'success', 'warning', 'error', 'promo'] as const;

class AnnouncementDto {
  @IsOptional() @IsString() message?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() detail?: string;
  @IsOptional() @IsIn(VARIANTS) variant?: AnnouncementVariant;
  @IsOptional() @IsString() linkUrl?: string;
  @IsOptional() @IsString() linkLabel?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() dismissible?: boolean;
  @IsOptional() @IsString() startsAt?: string | null;
  @IsOptional() @IsString() endsAt?: string | null;
  @IsOptional() @IsInt() sortOrder?: number;
}

class LegalDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() seoDescription?: string;
  @IsOptional() @IsString() version?: string;
  @IsOptional() @IsString() effectiveDate?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isPublished?: boolean;
}

class ContentDto {
  @IsObject() content!: Record<string, unknown>;
}

class PricingMetaDto {
  @IsObject() meta!: Partial<PricingMeta>;
}

/**
 * Admin write surface for the marketing CMS. Public reads live in
 * PublicSiteContentController. Writes require platform admin (AdminGuard).
 */
@Controller('admin/site-content')
@UseGuards(AuthGuard, AdminGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AdminSiteContentController {
  constructor(private readonly siteContent: SiteContentService) {}

  // --- Announcements ---------------------------------------------------------
  @Get('announcements')
  listAnnouncements() {
    return this.siteContent.adminListAnnouncements();
  }

  @Post('announcements')
  createAnnouncement(
    @Body() dto: AnnouncementDto,
    @Req() req: { user?: { id?: string } },
  ) {
    return this.siteContent.createAnnouncement(dto, req.user?.id);
  }

  @Put('announcements/:id')
  updateAnnouncement(@Param('id') id: string, @Body() dto: AnnouncementDto) {
    return this.siteContent.updateAnnouncement(id, dto);
  }

  @Delete('announcements/:id')
  async deleteAnnouncement(@Param('id') id: string) {
    await this.siteContent.deleteAnnouncement(id);
    return { ok: true as const };
  }

  // --- Legal pages -----------------------------------------------------------
  @Get('legal')
  listLegal() {
    return this.siteContent.adminListLegal();
  }

  @Get('legal/:slug')
  getLegal(@Param('slug') slug: string) {
    return this.siteContent.adminGetLegal(slug);
  }

  @Put('legal/:slug')
  upsertLegal(
    @Param('slug') slug: string,
    @Body() dto: LegalDto,
    @Req() req: { user?: { id?: string } },
  ) {
    return this.siteContent.upsertLegal(slug, dto, req.user?.id);
  }

  @Post('legal/:slug/reset')
  resetLegal(@Param('slug') slug: string) {
    return this.siteContent.resetLegal(slug);
  }

  // --- Marketing content blocks ---------------------------------------------
  @Get('content')
  listContent() {
    return this.siteContent.adminListContent();
  }

  @Put('content/:key')
  upsertContent(
    @Param('key') key: string,
    @Body() dto: ContentDto,
    @Req() req: { user?: { id?: string } },
  ) {
    return this.siteContent.upsertContent(key, dto.content, req.user?.id);
  }

  @Post('content/:key/reset')
  resetContent(@Param('key') key: string) {
    return this.siteContent.resetContent(key);
  }

  // --- Pricing display metadata ---------------------------------------------
  @Get('pricing-meta')
  getPricingMeta() {
    return this.siteContent.adminGetPricingMeta();
  }

  @Put('pricing-meta')
  upsertPricingMeta(
    @Body() dto: PricingMetaDto,
    @Req() req: { user?: { id?: string } },
  ) {
    return this.siteContent.upsertPricingMeta(dto.meta, req.user?.id);
  }

  @Post('pricing-meta/reset')
  resetPricingMeta() {
    return this.siteContent.resetPricingMeta();
  }
}
