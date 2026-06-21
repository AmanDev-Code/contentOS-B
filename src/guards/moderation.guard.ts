import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ModerationService } from '../modules/moderation/moderation.service';
import { containsCussWord } from '../modules/moderation/cuss-words';
import type { AuthenticatedRequest } from './auth.guard';

/**
 * Runs BEFORE the credit pre-flight guard.
 * Guard ordering on the controller: AuthGuard → ModerationGuard → PaywallGuard.
 */
@Injectable()
export class ModerationGuard implements CanActivate {
  private readonly logger = new Logger(ModerationGuard.name);

  constructor(private readonly moderationService: ModerationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const body = request.body as Record<string, unknown> | undefined;

    const topic =
      (body?.topic as string | undefined) ?? (body?.text as string | undefined);

    if (!topic || typeof topic !== 'string') {
      return true;
    }

    const result = containsCussWord(topic);

    if (!result.hit) {
      return true;
    }

    const userId = request.user?.id;

    if (userId) {
      this.moderationService
        .recordStrike(userId, topic, result.matches, 'api')
        .catch((err) =>
          this.logger.error(
            `Failed to record moderation strike: ${err.message}`,
          ),
        );
    }

    throw new BadRequestException({
      statusCode: 400,
      code: 'profanity_blocked',
      message: 'Content contains inappropriate language',
    });
  }
}
