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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import { BrandProfilesService } from '../services/brand-profiles.service';
import type { BrandProfileInput } from '../services/brand-profiles.service';
import { BrandKitExtractionService } from '../services/brand-kit-extraction.service';

interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

/**
 * Brand Kit MVP (Sprint 1.5, Stage A) — user-scoped CRUD for brand profiles.
 * No AI calls here; this only persists/serves the brand kit. The logo image is
 * uploaded by the frontend via the existing /media/upload pipeline and we just
 * store the returned URL in `logo_url`.
 */
@ApiTags('brand-profiles')
@Controller('brand-profiles')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class BrandProfilesController {
  constructor(
    private readonly brandProfilesService: BrandProfilesService,
    private readonly brandKitExtractionService: BrandKitExtractionService,
  ) {}

  @Post('extract')
  @ApiOperation({
    summary:
      'Smart Import: parse pasted text (ChatGPT brand kit, Tailwind/CSS, freeform) into brand fields via AI. Costs 0.5 credits. Does not save.',
  })
  async extract(@Req() req: AuthedRequest, @Body() body: { text: string }) {
    return this.brandKitExtractionService.extract(
      req.user.id,
      body?.text ?? '',
    );
  }

  @Get()
  @ApiOperation({ summary: "List the current user's brand profiles" })
  async list(@Req() req: AuthedRequest) {
    return this.brandProfilesService.list(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single brand profile by id' })
  async getById(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.brandProfilesService.getById(req.user.id, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a brand profile' })
  async create(@Req() req: AuthedRequest, @Body() body: BrandProfileInput) {
    return this.brandProfilesService.create(req.user.id, body);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a brand profile' })
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: BrandProfileInput,
  ) {
    return this.brandProfilesService.update(req.user.id, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a brand profile' })
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.brandProfilesService.remove(req.user.id, id);
  }
}
