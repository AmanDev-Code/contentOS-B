import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { SupabaseService } from '../services/supabase.service';
import { ProfileRepository } from '../repositories/profile.repository';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly profileRepository: ProfileRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No authentication token provided');
    }

    try {
      // Verify the JWT token with Supabase
      const {
        data: { user },
        error,
      } = await this.supabaseService.getClient().auth.getUser(token);

      if (error || !user) {
        throw new UnauthorizedException('Invalid or expired token');
      }

      // Add user info to request
      request.user = {
        id: user.id,
        email: user.email || '',
        role: user.role || 'user',
      };

      const accountStatus = await this.profileRepository.getAccountStatus(
        user.id,
      );
      if (accountStatus === 'suspended' || accountStatus === 'banned') {
        const method = request.method?.toUpperCase() || 'GET';
        if (!SAFE_READ_METHODS.has(method)) {
          throw new ForbiddenException(
            'This account cannot perform this action.',
          );
        }
      }

      return true;
    } catch (error) {
      console.error('Auth guard error:', error);
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
