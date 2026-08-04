/**
 * AutoCaptionModule — Self-contained NestJS module for the Auto Caption tool.
 *
 * Lightweight: imports only what it needs, no circular deps.
 * BullMQ queue registered here, worker runs in-process.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

import { CAPTION_QUEUE } from './config';

// Services
import {
  AutoCaptionService,
  CaptionOrchestratorService,
  CaptionUploadService,
  AssSubtitleService,
  FfmpegService,
} from './services';

// Engines
import {
  FasterWhisperEngine,
  ElevenLabsScribeEngine,
  DeepgramEngine,
  GoogleCloudSttEngine,
  AwsTranscribeEngine,
} from './engines';

// Workers
import { CaptionPipelineWorker } from './workers/caption-pipeline.worker';

// Controller
import { AutoCaptionController } from './controllers/auto-caption.controller';

// Shared services from parent
import { CacheService } from '../../../services/cache.service';
import { MinioService } from '../../../services/minio.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: CAPTION_QUEUE }),
  ],
  controllers: [AutoCaptionController],
  providers: [
    // Shared (provided locally — no global module dependency)
    CacheService,
    MinioService,
    ConfigService,

    // Engines (priority: ElevenLabs P0 → Deepgram P1 → Google P2 → AWS P3 → Sidecar P4)
    ElevenLabsScribeEngine,
    DeepgramEngine,
    GoogleCloudSttEngine,
    AwsTranscribeEngine,
    FasterWhisperEngine,

    // Services
    AutoCaptionService,
    CaptionOrchestratorService,
    CaptionUploadService,
    AssSubtitleService,
    FfmpegService,

    // Workers
    CaptionPipelineWorker,
  ],
  exports: [AutoCaptionService, CaptionOrchestratorService],
})
export class AutoCaptionModule implements OnModuleInit {
  constructor(private readonly uploadService: CaptionUploadService) {}

  async onModuleInit() {
    // Ensure MinIO bucket exists for caption uploads/outputs
    await this.uploadService.init();
  }
}
