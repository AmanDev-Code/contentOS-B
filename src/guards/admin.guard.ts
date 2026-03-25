import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const DEFAULT_ADMIN_USER_ID = 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
const DEFAULT_ADMIN_EMAIL = 'amanahuja@gmail.com';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const adminUserId = process.env.ADMIN_USER_ID || DEFAULT_ADMIN_USER_ID;
    const adminEmail = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;

    const isAdmin = user.id === adminUserId || user.email === adminEmail;

    if (!isAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
