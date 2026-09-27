import { Module } from '@nestjs/common';

/**
 * Video Tools module — groups all browser-based video tools.
 *
 * Video Converter uses FFmpeg WASM (client-side, ~33MB lazy load).
 * Video Recorder and Screen Recorder use native browser APIs (MediaRecorder,
 * getDisplayMedia). Files never uploaded to the server.
 *
 * NOTE: FFmpeg WASM requires COOP/COEP headers for SharedArrayBuffer.
 * These are set in Next.js middleware.ts scoped to /tools/video/* routes.
 */
@Module({})
export class VideoToolsModule {}
