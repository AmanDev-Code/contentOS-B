import { Injectable, Logger } from '@nestjs/common';

import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerState,
  EngineType,
  REDIS_KEYS,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../core';
import { CacheService } from '../../../services/cache.service';

/**
 * Circuit Breaker — Stops using engines/sessions that are consistently failing.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, all requests short-circuit (fail fast)
 * - HALF-OPEN: After reset timeout, allow one test request through
 *
 * Stored per-engine in Redis so state persists across restarts.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly config: CircuitBreakerConfig;

  constructor(private readonly cache: CacheService) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG };
  }

  /**
   * Check if requests are allowed through the circuit.
   * Returns true if the circuit is CLOSED or HALF-OPEN (test request).
   */
  async isAllowed(engineType: EngineType): Promise<boolean> {
    const state = await this.getState(engineType);

    switch (state.state) {
      case 'closed':
        return true;

      case 'open': {
        // Check if reset timeout has elapsed → transition to half-open
        const elapsed = Date.now() - new Date(state.lastStateChange).getTime();
        if (elapsed >= this.config.resetTimeout) {
          await this.transitionTo(engineType, state, 'half-open');
          return true; // Allow one test request
        }
        return false;
      }

      case 'half-open':
        // Allow requests in half-open (testing if service recovered)
        return true;

      default:
        return true;
    }
  }

  /**
   * Record a successful request. May close the circuit if in half-open.
   */
  async recordSuccess(engineType: EngineType): Promise<void> {
    const state = await this.getState(engineType);

    if (state.state === 'half-open') {
      state.successes++;
      if (state.successes >= this.config.successThreshold) {
        await this.transitionTo(engineType, state, 'closed');
        this.logger.log(`Circuit CLOSED for engine: ${engineType} (recovered)`);
      } else {
        await this.saveState(engineType, state);
      }
    } else if (state.state === 'closed') {
      // Reset failure count on success in closed state
      if (state.failures > 0) {
        state.failures = 0;
        await this.saveState(engineType, state);
      }
    }
  }

  /**
   * Record a failed request. May open the circuit if threshold exceeded.
   */
  async recordFailure(engineType: EngineType): Promise<void> {
    const state = await this.getState(engineType);

    if (state.state === 'half-open') {
      // Any failure in half-open immediately reopens
      await this.transitionTo(engineType, state, 'open');
      this.logger.warn(`Circuit re-OPENED for engine: ${engineType} (failed in half-open)`);
    } else if (state.state === 'closed') {
      state.failures++;
      state.lastFailure = new Date().toISOString();

      if (state.failures >= this.config.failureThreshold) {
        await this.transitionTo(engineType, state, 'open');
        this.logger.warn(
          `Circuit OPENED for engine: ${engineType} after ${state.failures} failures`,
        );
      } else {
        await this.saveState(engineType, state);
      }
    }
    // If already open, nothing to do
  }

  /**
   * Get the current state of a circuit.
   */
  async getState(engineType: EngineType): Promise<CircuitBreakerState> {
    const key = `${REDIS_KEYS.CIRCUIT}:${engineType}`;
    const data = await this.cache.get(key);

    if (data) {
      return data as CircuitBreakerState;
    }

    // Default: closed circuit
    return {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastStateChange: new Date().toISOString(),
    };
  }

  /**
   * Manually reset a circuit to closed (admin action).
   */
  async reset(engineType: EngineType): Promise<void> {
    const state: CircuitBreakerState = {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastStateChange: new Date().toISOString(),
    };
    await this.saveState(engineType, state);
    this.logger.log(`Circuit manually RESET for engine: ${engineType}`);
  }

  /**
   * Get status of all tracked circuits.
   */
  async getAllStates(): Promise<Record<EngineType, CircuitBreakerState>> {
    const engines: EngineType[] = ['private-api', 'mobile-api', 'browser', 'embed', 'oembed'];
    const states: Record<string, CircuitBreakerState> = {};

    for (const engine of engines) {
      states[engine] = await this.getState(engine);
    }

    return states as Record<EngineType, CircuitBreakerState>;
  }

  private async transitionTo(
    engineType: EngineType,
    state: CircuitBreakerState,
    newState: CircuitState,
  ): Promise<void> {
    state.state = newState;
    state.lastStateChange = new Date().toISOString();

    if (newState === 'closed') {
      state.failures = 0;
      state.successes = 0;
    } else if (newState === 'half-open') {
      state.successes = 0;
    }

    await this.saveState(engineType, state);
  }

  private async saveState(engineType: EngineType, state: CircuitBreakerState): Promise<void> {
    const key = `${REDIS_KEYS.CIRCUIT}:${engineType}`;
    // TTL of 1 hour — stale circuits auto-reset
    await this.cache.set(key, state, 3600);
  }
}
