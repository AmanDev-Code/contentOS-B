import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { BlogService } from '../services/blog.service';

/**
 * Platform admin OR user listed in `blog_editor_grants`.
 */
@Injectable()
export class BlogManagementGuard implements CanActivate {
  constructor(private readonly blogService: BlogService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.id) {
      throw new ForbiddenException('Authentication required');
    }
    const ok = await this.blogService.isBlogEditorOrAdmin(user);
    if (!ok) {
      throw new ForbiddenException('Blog management access required');
    }
    return true;
  }
}
