import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { CaptionOrchestratorService } from '../modules/tools/auto-caption/services/caption-orchestrator.service';

/**
 * Admin endpoints for transcription engine health monitoring.
 * Shows which engines (ElevenLabs, Deepgram, Google STT, AWS Transcribe,
 * Faster-Whisper) are alive, dead, or in circuit-breaker cooldown.
 */
@ApiTags('admin-transcription')
@Controller('admin/transcription')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
export class AdminTranscriptionController {
  private readonly logger = new Logger(AdminTranscriptionController.name);

  constructor(
    private readonly orchestrator: CaptionOrchestratorService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Get health status of all transcription engines' })
  async health() {
    try {
      const engines = await this.orchestrator.getStatus();

      // Determine overall status
      const configuredEngines = engines.filter((e) => e.configured);
      const healthyEngines = configuredEngines.filter(
        (e) => e.healthy && !e.circuitOpen,
      );

      let overallStatus: 'healthy' | 'degraded' | 'critical';
      if (healthyEngines.length === 0) {
        overallStatus = 'critical';
      } else if (
        healthyEngines.length < configuredEngines.length ||
        engines[0]?.circuitOpen ||
        !engines[0]?.healthy
      ) {
        overallStatus = 'degraded';
      } else {
        overallStatus = 'healthy';
      }

      return {
        status: overallStatus,
        totalEngines: engines.length,
        configuredCount: configuredEngines.length,
        healthyCount: healthyEngines.length,
        engines: engines.map((e) => ({
          ...e,
          envConfigured: this.getEnvStatus(e.name),
        })),
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`Health check failed: ${error.message}`);
      throw new HttpException(
        error.message || 'Health check failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('circuits')
  @ApiOperation({ summary: 'Get circuit breaker states for all engines' })
  async circuits() {
    try {
      const engines = await this.orchestrator.getStatus();
      return {
        circuits: engines.map((e) => ({
          name: e.name,
          priority: e.priority,
          circuitOpen: e.circuitOpen,
          state: e.circuitOpen ? 'open' : 'closed',
        })),
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`Circuit check failed: ${error.message}`);
      throw new HttpException(
        error.message || 'Circuit check failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('circuits/:engine/reset')
  @ApiOperation({ summary: 'Reset a tripped circuit breaker for an engine' })
  async resetCircuit(@Param('engine') engine: string) {
    try {
      await this.orchestrator.resetCircuit(engine);
      return { success: true, engine, message: `Circuit reset for ${engine}` };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`Circuit reset failed for ${engine}: ${error.message}`);
      throw new HttpException(
        error.message || 'Circuit reset failed',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('test/:engine')
  @ApiOperation({
    summary: 'Run a live health probe against a specific engine',
  })
  async testEngine(@Param('engine') engine: string) {
    try {
      const result = await this.orchestrator.probeEngine(engine);
      return {
        engine,
        ...result,
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(`Engine probe failed for ${engine}: ${error.message}`);
      throw new HttpException(
        error.message || 'Engine probe failed',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Returns which ENV vars are configured (not the values — just ✓/✗).
   */
  private getEnvStatus(engineName: string): Record<string, boolean> {
    switch (engineName) {
      case 'elevenlabs-scribe':
        return { ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY };
      case 'deepgram-nova3':
        return { DEEPGRAM_API_KEY: !!process.env.DEEPGRAM_API_KEY };
      case 'google-cloud-stt':
        return {
          GOOGLE_CLOUD_STT_CREDENTIALS_PATH:
            !!process.env.GOOGLE_CLOUD_STT_CREDENTIALS_PATH,
        };
      case 'aws-transcribe':
        return {
          AWS_TRANSCRIBE_ACCESS_KEY_ID:
            !!process.env.AWS_TRANSCRIBE_ACCESS_KEY_ID,
          AWS_TRANSCRIBE_SECRET_ACCESS_KEY:
            !!process.env.AWS_TRANSCRIBE_SECRET_ACCESS_KEY,
          AWS_TRANSCRIBE_REGION: !!process.env.AWS_TRANSCRIBE_REGION,
          AWS_TRANSCRIBE_BUCKET: !!process.env.AWS_TRANSCRIBE_BUCKET,
        };
      case 'faster-whisper':
        return {
          TRANSCRIPTION_SIDECAR_URL: !!process.env.TRANSCRIPTION_SIDECAR_URL,
        };
      default:
        return {};
    }
  }
}
