import { Module } from '@nestjs/common';

/**
 * Audio Tools module — groups all browser-based audio tools.
 *
 * Audio Converter uses FFmpeg WASM (client-side, ~33MB lazy load).
 * Audio Recorder, TTS, and STT use native browser APIs (MediaRecorder,
 * Web Speech API). No server-side processing. Files never uploaded.
 *
 * NOTE: FFmpeg WASM requires COOP/COEP headers for SharedArrayBuffer.
 * These are set in Next.js middleware.ts scoped to /tools/audio/* routes.
 */
@Module({})
export class AudioToolsModule {}
