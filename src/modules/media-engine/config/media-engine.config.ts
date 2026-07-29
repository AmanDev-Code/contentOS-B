import {
  CooldownConfig,
  CircuitBreakerConfig,
  DEFAULT_COOLDOWN_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from '../core';

/**
 * Media Engine Configuration.
 *
 * All values have sensible defaults. Override via environment variables
 * or ConfigService injection in the future.
 */
export interface MediaEngineConfig {
  cooldown: CooldownConfig;
  circuitBreaker: CircuitBreakerConfig;
  session: typeof DEFAULT_SESSION_CONFIG;
  /** Platforms to enable health checking for */
  healthCheckPlatforms: string[];
  /** Whether to enable URL-level caching */
  urlCacheEnabled: boolean;
}

export const DEFAULT_MEDIA_ENGINE_CONFIG: MediaEngineConfig = {
  cooldown: { ...DEFAULT_COOLDOWN_CONFIG },
  circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER_CONFIG },
  session: { ...DEFAULT_SESSION_CONFIG },
  healthCheckPlatforms: ['instagram'],
  urlCacheEnabled: true,
};
