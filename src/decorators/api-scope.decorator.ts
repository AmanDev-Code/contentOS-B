import { SetMetadata } from '@nestjs/common';
import type { ApiScope } from '../services/api-key.service';

export const API_SCOPE_KEY = 'api_required_scopes';

/**
 * Declares the API-key scope(s) required to call an endpoint. The
 * `ApiKeyAuthGuard` reads this metadata and returns 403 when the authenticating
 * key lacks any of the listed scopes.
 */
export const RequireApiScope = (...scopes: ApiScope[]) =>
  SetMetadata(API_SCOPE_KEY, scopes);
