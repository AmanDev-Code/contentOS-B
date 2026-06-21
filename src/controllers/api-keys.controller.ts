import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { UserRateLimitGuard } from '../guards/user-rate-limit.guard';
import {
  ApiKeyService,
  API_SCOPES,
  type ApiScope,
} from '../services/api-key.service';
import { QuotaService } from '../services/quota.service';

interface SessionRequest {
  user?: { id: string };
}

/**
 * Dashboard-facing management of Public API v1 keys. Session (JWT) authed — the
 * keys themselves authenticate the public API, but you create/list/revoke them
 * from the logged-in app. The full key is returned ONCE on creation.
 */
@ApiTags('api-keys')
@Controller('api-keys')
@UseGuards(AuthGuard, UserRateLimitGuard)
export class ApiKeysController {
  private readonly logger = new Logger(ApiKeysController.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly quotaService: QuotaService,
  ) {}

  @Get('scopes')
  @ApiOperation({ summary: 'List available API key scopes' })
  getScopes() {
    return { scopes: API_SCOPES };
  }

  @Get()
  @ApiOperation({ summary: 'List your API keys (no secrets)' })
  async list(@Request() req: SessionRequest) {
    const userId = this.requireUser(req);
    const keys = await this.apiKeyService.listKeys(userId);
    return { keys };
  }

  @Post()
  @ApiOperation({
    summary: 'Create an API key. The plaintext key is returned ONCE.',
  })
  async create(
    @Request() req: SessionRequest,
    @Body()
    body: { name?: string; scopes?: string[]; expiresAt?: string | null },
  ) {
    const userId = this.requireUser(req);
    if (!body?.name || !body.name.trim()) {
      throw new BadRequestException('`name` is required.');
    }

    if (body.scopes) {
      const allowed = new Set<string>(API_SCOPES);
      const invalid = body.scopes.filter((s) => !allowed.has(s));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Invalid scope(s): ${invalid.join(', ')}. Allowed: ${API_SCOPES.join(', ')}.`,
        );
      }
    }

    let planType: string | undefined;
    try {
      const quota = await this.quotaService.getUserQuota(userId);
      planType = (quota as { planType?: string }).planType;
    } catch {
      planType = undefined;
    }

    const created = await this.apiKeyService.createKey(userId, {
      name: body.name.trim(),
      scopes: body.scopes,
      planType,
      expiresAt: body.expiresAt ?? null,
    });

    // Return plaintext ONCE alongside the safe record.
    const { plaintextKey, ...record } = created;
    return {
      apiKey: record,
      plaintextKey,
      warning:
        'Store this key now. For your security it will not be shown again.',
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke an API key' })
  async revoke(@Request() req: SessionRequest, @Param('id') id: string) {
    const userId = this.requireUser(req);
    const revoked = await this.apiKeyService.revokeKey(userId, id);
    if (!revoked) {
      throw new NotFoundException('API key not found or already revoked.');
    }
    return { success: true };
  }

  private requireUser(req: SessionRequest): string {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found.');
    return userId;
  }
}
