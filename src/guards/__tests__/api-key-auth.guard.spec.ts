import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyAuthGuard } from '../api-key-auth.guard';
import { API_SCOPE_KEY } from '../../decorators/api-scope.decorator';
import type { ValidatedApiKey } from '../../services/api-key.service';

/**
 * Scope-enforcement tests for the Public API v1 guard, focused on the new
 * `accounts:write` scope (Sprint 1.8-D). Mirrors the api-key.service.spec.ts
 * style: tiny hand-rolled fakes, no Nest test harness.
 */

function makeContext(requiredScopes: string[]): {
  context: ExecutionContext;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {
    authorization: 'Bearer trnd_fake-key',
  };
  const request = { headers } as Record<string, unknown>;
  const response = { header: () => undefined };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { context, headers };
}

function makeGuard(validated: ValidatedApiKey, requiredScopes: string[]) {
  const apiKeyService = {
    validateKey: jest.fn(async () => validated),
  };
  const cacheService = {
    // first call in the hour -> 1 use, well under the limit
    incr: jest.fn(async () => 1),
  };
  const reflector = {
    getAllAndOverride: jest.fn(() => requiredScopes),
  } as unknown as Reflector;

  const guard = new ApiKeyAuthGuard(
    apiKeyService as never,
    cacheService as never,
    reflector,
  );
  return { guard, apiKeyService, cacheService, reflector };
}

const baseKey = (scopes: string[]): ValidatedApiKey => ({
  keyId: 'key-1',
  userId: 'user-1',
  scopes,
  rateLimitPerHour: 100,
});

describe('ApiKeyAuthGuard — accounts:write scope enforcement', () => {
  it('allows a key that holds accounts:write', async () => {
    const required = ['accounts:write'];
    const { context } = makeContext(required);
    const { guard, reflector } = makeGuard(
      baseKey(['accounts:read', 'accounts:write']),
      required,
    );
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(required);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a key missing accounts:write with 403', async () => {
    const required = ['accounts:write'];
    const { context } = makeContext(required);
    const { guard, reflector } = makeGuard(
      baseKey(['accounts:read']),
      required,
    );
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(required);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows accounts:read endpoints for a read-only key (no accounts:write needed)', async () => {
    const required = ['accounts:read'];
    const { context } = makeContext(required);
    const { guard, reflector } = makeGuard(
      baseKey(['accounts:read']),
      required,
    );
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(required);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('sets request.user to the key owner so reused services are scoped per-user', async () => {
    const required = ['accounts:write'];
    const { context } = makeContext(required);
    const { guard, reflector } = makeGuard(
      baseKey(['accounts:write']),
      required,
    );
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(required);

    await guard.canActivate(context);
    const req = context.switchToHttp().getRequest();
    expect(req.user?.id).toBe('user-1');
  });
});
