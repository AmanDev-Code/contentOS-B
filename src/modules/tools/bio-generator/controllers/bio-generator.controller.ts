/**
 * BioGeneratorController — Lightweight endpoints for the bio tool.
 *
 * POST /api/tools/bio-generator/generate — multi-platform bio generation.
 * POST /api/tools/bio-generator/score    — score a single bio on 5 dimensions.
 * GET  /api/tools/bio-generator/limits   — return per-IP quota state.
 *
 * All endpoints are public (no auth) — the free tool is the acquisition funnel.
 * Rate limiting: 15/hr per IP in production; unlimited in dev.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ToolCategoryMeta } from '../../../../decorators/tool-category.decorator';
import { ToolRateLimitGuard } from '../../../../guards/tool-rate-limit.guard';

import { FeedbackBioDto, GenerateBioDto, ScoreBioDto } from '../dto/generate.dto';
import { BioGeneratorService } from '../services/bio-generator.service';
import { BIO_PLATFORMS, BIO_TONES, PLATFORM_LIMITS, RATE_LIMITS } from '../config';

@Controller('api/tools/bio-generator')
export class BioGeneratorController {
  constructor(private readonly service: BioGeneratorService) {}

  /** POST /generate — main entry point (waits for every platform, then returns). */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ToolCategoryMeta('text-ai')
  @UseGuards(ToolRateLimitGuard)
  async generate(@Body() body: GenerateBioDto, @Req() req: FastifyRequest) {
    const ip = this.extractIp(req);
    try {
      const result = await this.service.generate(body, ip);
      return { success: true, ...result };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = e instanceof Error ? e.message : 'Bio generation failed';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * POST /generate-stream — Server-Sent Events endpoint.
   *
   * Streams per-platform results as each one completes, so a slow model on
   * one platform never blocks the fast ones from rendering. This is the same
   * pattern BioLoom uses (Vercel AI SDK's streamObject) — the client sees
   * cards fill in progressively instead of watching a spinner.
   *
   * Emits SSE events:
   *   - event: start     → { generationId, platforms }
   *   - event: platform  → { platform, result }        (once per platform, in completion order)
   *   - event: error     → { platform?, message, fatal }
   *   - event: end       → { generationId, model, durationMs, succeeded, failed }
   */
  @Post('generate-stream')
  @ToolCategoryMeta('text-ai')
  @UseGuards(ToolRateLimitGuard)
  async generateStream(
    @Body() body: GenerateBioDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ip = this.extractIp(req);

    // Fastify raw response — we write the SSE frames directly so Nest doesn't
    // try to buffer / JSON.stringify the response.
    const origin = (req.headers['origin'] as string) || '*';
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    // CORS headers — reply.hijack() bypasses NestJS's CORS middleware so we
    // must set them manually on the raw response.
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Fastify would otherwise send response headers itself once the handler returns,
    // so hijack the reply and flush headers up-front so the client starts receiving.
    reply.hijack();
    reply.raw.flushHeaders?.();

    // If the client disconnects mid-stream, stop pumping events.
    let clientClosed = false;
    reply.raw.on('close', () => {
      clientClosed = true;
    });

    const write = (event: string, data: unknown) => {
      if (clientClosed) return;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
    };

    // Keepalive comment every 15s so proxies + Cloudflare don't idle-kill the connection.
    const keepalive = setInterval(() => {
      if (!clientClosed) reply.raw.write(`: keepalive\n\n`);
    }, 15_000);

    try {
      for await (const event of this.service.generateStream(body, ip)) {
        if (clientClosed) break;
        write(event.type, event);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Bio generation failed';
      write('error', { type: 'error', message: msg, fatal: true });
    } finally {
      clearInterval(keepalive);
      if (!clientClosed) {
        reply.raw.write(`event: done\ndata: {"type":"done"}\n\n`);
        reply.raw.end();
      }
    }
  }

  /** POST /score — 5-dimension rubric + 3 tips for a single bio. */
  @Post('score')
  @HttpCode(HttpStatus.OK)
  @ToolCategoryMeta('text-ai')
  @UseGuards(ToolRateLimitGuard)
  async score(@Body() body: ScoreBioDto, @Req() req: FastifyRequest) {
    const ip = this.extractIp(req);
    try {
      const result = await this.service.score(body, ip);
      return { success: true, ...result };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = e instanceof Error ? e.message : 'Scoring failed';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /** GET /limits — surface remaining quota + metadata so the UI stays honest. */
  @Get('limits')
  async limits(@Req() req: FastifyRequest) {
    const ip = this.extractIp(req);
    const state = await this.service.checkIpLimit(ip);
    return {
      success: true,
      allowed: state.allowed,
      remaining: state.remaining,
      hourly: RATE_LIMITS.maxPerIpPerHour,
      platforms: BIO_PLATFORMS.map((p) => ({
        id: p,
        label: PLATFORM_LIMITS[p].label,
        maxChars: PLATFORM_LIMITS[p].maxChars,
        softFold: PLATFORM_LIMITS[p].softFold,
      })),
      tones: BIO_TONES,
    };
  }

  /**
   * POST /feedback — thumbs-up / thumbs-down on a specific generated bio.
   *
   * Anonymous (no auth). IP is hashed before storage. Counts are NOT
   * surfaced back to end users — only aggregates in the admin dashboard.
   * Same text-ai rate bucket so a script can't spam thumbs.
   */
  @Post('feedback')
  @HttpCode(HttpStatus.OK)
  @ToolCategoryMeta('text-ai')
  @UseGuards(ToolRateLimitGuard)
  async feedback(@Body() body: FeedbackBioDto, @Req() req: FastifyRequest) {
    const ip = this.extractIp(req);
    try {
      const result = await this.service.recordFeedback(body, ip);
      return { success: true, ...result };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = e instanceof Error ? e.message : 'Failed to record feedback';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private extractIp(req: FastifyRequest): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
    return req.ip;
  }
}
