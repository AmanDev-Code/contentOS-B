import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { SupabaseService } from '../services/supabase.service';

interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  config: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

@ApiTags('admin')
@Controller('admin/feature-flags')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminFeatureFlagsController {
  constructor(private readonly supabaseService: SupabaseService) {}

  @Get()
  @ApiOperation({ summary: 'List all feature flags' })
  async listAll() {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('feature_flags')
      .select('*')
      .order('key', { ascending: true });

    if (error) {
      throw new HttpException(
        `Failed to fetch feature flags: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return { success: true, data: (data || []) as FeatureFlagRow[] };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new feature flag' })
  async create(
    @Body()
    body: {
      key: string;
      enabled?: boolean;
      config?: Record<string, any>;
    },
  ) {
    if (!body.key || typeof body.key !== 'string' || !body.key.trim()) {
      throw new HttpException('key is required', HttpStatus.BAD_REQUEST);
    }

    const client = this.supabaseService.getServiceClient();

    // Check if key already exists
    const { data: existing } = await client
      .from('feature_flags')
      .select('key')
      .eq('key', body.key.trim())
      .maybeSingle();

    if (existing) {
      throw new HttpException(
        `Feature flag "${body.key}" already exists`,
        HttpStatus.CONFLICT,
      );
    }

    const { data, error } = await client
      .from('feature_flags')
      .insert({
        key: body.key.trim(),
        enabled: body.enabled ?? false,
        config: body.config ?? {},
      })
      .select()
      .single();

    if (error) {
      throw new HttpException(
        `Failed to create feature flag: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return { success: true, data: data as FeatureFlagRow };
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Update a feature flag by key' })
  async update(
    @Param('key') key: string,
    @Body()
    body: {
      enabled?: boolean;
      config?: Record<string, any>;
    },
  ) {
    const client = this.supabaseService.getServiceClient();

    // Check if flag exists
    const { data: existing } = await client
      .from('feature_flags')
      .select('key')
      .eq('key', key)
      .maybeSingle();

    if (!existing) {
      throw new HttpException(
        `Feature flag "${key}" not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    const updatePayload: Record<string, any> = {};
    if (body.enabled !== undefined) updatePayload.enabled = body.enabled;
    if (body.config !== undefined) updatePayload.config = body.config;

    if (Object.keys(updatePayload).length === 0) {
      throw new HttpException('No fields to update', HttpStatus.BAD_REQUEST);
    }

    const { data, error } = await client
      .from('feature_flags')
      .update(updatePayload)
      .eq('key', key)
      .select()
      .single();

    if (error) {
      throw new HttpException(
        `Failed to update feature flag: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return { success: true, data: data as FeatureFlagRow };
  }
}
