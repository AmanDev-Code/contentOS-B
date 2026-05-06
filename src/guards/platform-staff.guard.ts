import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PlatformAccessService } from '../services/platform-access.service';

/**
 * Super-admin (env) OR delegated row in `platform_admin_grants`.
 */
@Injectable()
export class PlatformStaffGuard implements CanActivate {
  constructor(private readonly platformAccess: PlatformAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user?.id) {
      throw new ForbiddenException('Authentication required');
    }

    const ok = await this.platformAccess.hasStaffAccess(user);
    if (!ok) {
      throw new ForbiddenException('Platform staff access required');
    }

    return true;
  }
}
