/**
 * CaptionOrchestratorService — Engine picker with circuit breaker.
 *
 * Priority order (user-defined):
 *   P0: ElevenLabs Scribe (user has full credits)
 *   P1: Deepgram Nova-3 ($0.0043/min — $200 credits)
 *   P2: Google Cloud STT ($0.006/min — $2000 credits)
 *   P3: AWS Transcribe ($0.006/min — existing AWS)
 *   P4: Self-hosted sidecar ($0/min — only if deployed)
 *
 * Tries engines in priority order. Skips unconfigured or circuit-open engines.
 * Lightweight: sorted list + Redis flags. No complex state machines.
 */

import { Injectable, Logger } from '@nestjs/common';

import { TranscriptionEngine, TranscriptResult } from '../types';
import { CacheService } from '../../../../services/cache.service';
import { CAPTION_REDIS } from '../config';
import { ElevenLabsScribeEngine } from '../engines/elevenlabs-scribe.engine';
import { DeepgramEngine } from '../engines/deepgram.engine';
import { GoogleCloudSttEngine } from '../engines/google-cloud-stt.engine';
import { AwsTranscribeEngine } from '../engines/aws-transcribe.engine';
import { FasterWhisperEngine } from '../engines/faster-whisper.engine';

interface CircuitState {
  failures: number;
  openUntil: number; // epoch ms, 0 = closed
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min

@Injectable()
export class CaptionOrchestratorService {
  private readonly logger = new Logger(CaptionOrchestratorService.name);
  private readonly engines: TranscriptionEngine[];

  constructor(
    private readonly cache: CacheService,
    private readonly elevenLabs: ElevenLabsScribeEngine,
    private readonly deepgram: DeepgramEngine,
    private readonly googleStt: GoogleCloudSttEngine,
    private readonly awsTranscribe: AwsTranscribeEngine,
    private readonly fasterWhisper: FasterWhisperEngine,
  ) {
    // Sort by priority (lower number = tried first)
    this.engines = [
      elevenLabs,    // P0 — user's primary choice
      deepgram,      // P1 — cheapest per-minute
      googleStt,     // P2 — $2000 GCP credits
      awsTranscribe, // P3 — existing AWS
      fasterWhisper, // P4 — self-hosted, only if sidecar deployed
    ].sort((a, b) => a.priority - b.priority);

    this.logger.log(
      `Transcription engines loaded: ${this.engines.map((e) => `${e.name}(P${e.priority})`).join(' → ')}`,
    );
  }

  /**
   * Transcribe audio using the healthiest available engine.
   * Falls through engines on failure. Throws if all fail.
   */
  async transcribe(audioPath: string, language?: string): Promise<TranscriptResult & { engine: string }> {
    const errors: string[] = [];

    for (const engine of this.engines) {
      // Skip engines that aren't configured (supports() checks for API keys)
      if (!engine.supports('audio/wav', 180)) continue;

      // Check circuit breaker
      const circuit = await this.getCircuit(engine.name);
      if (circuit.openUntil > Date.now()) {
        this.logger.debug(`Skipping ${engine.name} — circuit open until ${new Date(circuit.openUntil).toISOString()}`);
        continue;
      }

      try {
        this.logger.log(`Trying engine: ${engine.name}`);
        const result = await engine.transcribe(audioPath, language);
        // Success: reset circuit
        await this.recordSuccess(engine.name);
        this.logger.log(`✓ Transcribed via ${engine.name} in ${result.transcriptionMs}ms`);
        return { ...result, engine: engine.name };
      } catch (err: any) {
        const msg = err.message || 'unknown error';
        this.logger.warn(`✗ Engine ${engine.name} failed: ${msg}`);
        errors.push(`${engine.name}: ${msg}`);
        await this.recordFailure(engine.name);
      }
    }

    throw new Error(`All transcription engines failed: ${errors.join('; ')}`);
  }

  /**
   * Get health status of all engines (for admin dashboard).
   */
  async getStatus(): Promise<{ name: string; priority: number; configured: boolean; healthy: boolean; circuitOpen: boolean }[]> {
    const results: { name: string; priority: number; configured: boolean; healthy: boolean; circuitOpen: boolean }[] = [];
    for (const engine of this.engines) {
      const configured = engine.supports('audio/wav', 90);
      const circuit = await this.getCircuit(engine.name);
      const healthy = configured ? await engine.isHealthy() : false;
      results.push({
        name: engine.name,
        priority: engine.priority,
        configured,
        healthy,
        circuitOpen: circuit.openUntil > Date.now(),
      });
    }
    return results;
  }

  // ─── Circuit Breaker (simple Redis-backed) ──────────────────────────────

  private async getCircuit(engineName: string): Promise<CircuitState> {
    const key = `${CAPTION_REDIS.CIRCUIT}:${engineName}`;
    const data = await this.cache.get(key);
    if (data) return data as CircuitState;
    return { failures: 0, openUntil: 0 };
  }

  private async recordSuccess(engineName: string): Promise<void> {
    const key = `${CAPTION_REDIS.CIRCUIT}:${engineName}`;
    await this.cache.set(key, { failures: 0, openUntil: 0 }, 3600);
  }

  private async recordFailure(engineName: string): Promise<void> {
    const key = `${CAPTION_REDIS.CIRCUIT}:${engineName}`;
    const state = await this.getCircuit(engineName);
    state.failures++;

    if (state.failures >= FAILURE_THRESHOLD) {
      state.openUntil = Date.now() + COOLDOWN_MS;
      this.logger.warn(`Circuit OPEN for ${engineName} — cooldown ${COOLDOWN_MS / 1000}s`);
    }

    await this.cache.set(key, state, 3600);
  }

  /**
   * Admin: reset a tripped circuit breaker back to closed state.
   */
  async resetCircuit(engineName: string): Promise<void> {
    const engine = this.engines.find((e) => e.name === engineName);
    if (!engine) {
      throw new Error(`Unknown engine: ${engineName}`);
    }
    const key = `${CAPTION_REDIS.CIRCUIT}:${engineName}`;
    await this.cache.set(key, { failures: 0, openUntil: 0 }, 3600);
    this.logger.log(`Circuit RESET by admin for ${engineName}`);
  }

  /**
   * Admin: run a live health probe against a specific engine.
   */
  async probeEngine(engineName: string): Promise<{ healthy: boolean; configured: boolean; latencyMs: number; error?: string }> {
    const engine = this.engines.find((e) => e.name === engineName);
    if (!engine) {
      throw new Error(`Unknown engine: ${engineName}`);
    }
    const configured = engine.supports('audio/wav', 90);
    if (!configured) {
      return { healthy: false, configured: false, latencyMs: 0, error: 'Not configured (missing API key or ENV)' };
    }
    const start = Date.now();
    try {
      const healthy = await engine.isHealthy();
      return { healthy, configured: true, latencyMs: Date.now() - start };
    } catch (err: unknown) {
      const error = err as Error;
      return { healthy: false, configured: true, latencyMs: Date.now() - start, error: error.message };
    }
  }
}
