import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const ADMIN_USER_ID = 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
const ADMIN_EMAIL = 'amanahuja@gmail.com';

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

    const isAdmin = user.id === ADMIN_USER_ID || user.email === ADMIN_EMAIL;

    if (!isAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
