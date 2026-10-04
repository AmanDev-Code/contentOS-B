import { Module } from '@nestjs/common';

/**
 * Image Tools module — groups all client-side image processing tools.
 *
 * All 49 image tools (conversion, compression, edit, utility) run 100%
 * client-side in the user's browser using Canvas API, ONNX WASM, or
 * Tesseract.js WASM. This module exists for:
 * - Tool registry grouping
 * - Rate limit enforcement (via ToolRateLimitGuard on the analytics endpoint)
 * - Analytics event tracking
 * - Future server-side helpers if needed
 */
@Module({})
export class ImageToolsModule {}
