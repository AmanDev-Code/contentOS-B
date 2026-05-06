import { Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { isPlatformAdmin } from '../common/platform-admin';

@Injectable()
export class PlatformAccessService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
  ) {}

  isSuperAdmin(user: { id: string; email?: string }): boolean {
    return isPlatformAdmin(user);
  }

  async hasStaffAccess(user: {
    id: string;
    email?: string;
  }): Promise<boolean> {
    if (this.isSuperAdmin(user)) return true;
    const cacheKey = `platform_staff:${user.id}`;
    const cached = await this.cacheService.get(cacheKey);
    if (cached === '1') return true;
    if (cached === '0') return false;

    const { data } = await this.supabaseService
      .getServiceClient()
      .from('platform_admin_grants')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const ok = !!data;
    await this.cacheService.set(cacheKey, ok ? '1' : '0', 120);
    return ok;
  }

  async invalidateStaffCache(userId: string): Promise<void> {
    await this.cacheService.delete(`platform_staff:${userId}`);
  }
}
