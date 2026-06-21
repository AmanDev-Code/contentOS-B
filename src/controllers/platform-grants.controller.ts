import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';
import { SupabaseService } from '../services/supabase.service';
import { PlatformAccessService } from '../services/platform-access.service';

interface AuthReq extends Request {
  user: { id: string; email: string };
}

@ApiTags('platform-admin')
@Controller('platform-admin/grants')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class PlatformGrantsController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List delegated platform staff (super-admin only)' })
  async list() {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('platform_admin_grants')
      .select('user_id, granted_by, created_at')
      .order('created_at', { ascending: false });
    if (error) {
      throw new BadRequestException(error.message);
    }
    return { grants: data || [] };
  }

  @Post()
  @ApiOperation({ summary: 'Grant platform staff (super-admin only)' })
  async grant(@Request() req: AuthReq, @Body() body: { userId: string }) {
    const targetUserId = body?.userId?.trim();
    if (!targetUserId) {
      throw new BadRequestException('userId is required');
    }
    if (targetUserId === req.user.id) {
      throw new BadRequestException('Cannot grant yourself');
    }

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('platform_admin_grants')
      .upsert(
        {
          user_id: targetUserId,
          granted_by: req.user.id,
        },
        { onConflict: 'user_id' },
      );

    if (error) {
      throw new BadRequestException(error.message);
    }

    await this.platformAccess.invalidateStaffCache(targetUserId);
    return { success: true };
  }

  @Delete(':userId')
  @ApiOperation({ summary: 'Revoke platform staff (super-admin only)' })
  async revoke(@Param('userId') userId: string) {
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('platform_admin_grants')
      .delete()
      .eq('user_id', userId);

    if (error) {
      throw new BadRequestException(error.message);
    }

    await this.platformAccess.invalidateStaffCache(userId);
    return { success: true };
  }
}
