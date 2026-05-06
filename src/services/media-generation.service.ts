import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import { MinioService } from './minio.service';
import { CacheService } from './cache.service';
import { OpenAIRateLimiterService } from './openai-rate-limiter.service';
import type { CarouselVisualStyle } from '../modules/post-ai/carousel-visual-style';
import type {
  CarouselNoteDensityLevel,
  CarouselDocumentTheme,
  CarouselSlideOutput,
  TocEntry,
} from '../modules/post-ai/custom-topic.schemas';
import { isNotebookPaperCarouselStyle } from '../modules/post-ai/carousel-visual-style';
import {
  expandNotebookStructuredRows,
  isCompositorCodeRow,
  unpackCompositorCodeRow,
} from '../modules/post-ai/notebook-compositor-lines';
import { DENSE_NOTEBOOK_LINE_STEP_PX } from '../modules/post-ai/notebook-dense-layout';
import {
  renderDocumentDeckSlide,
  type DocumentDeckMeta,
} from '../modules/post-ai/document-deck-renderer';

export interface ImageGenerationRequest {
  prompt: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792' | '1536x1024' | '1024x1536';
  quality?: 'low' | 'medium' | 'high' | 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  model?: 'dall-e-3' | 'gpt-image-1' | 'gpt-image-1-mini';
  /** When true, use `prompt` verbatim (carousel base prompt already finalized). */
  skipProductionPromptAugmentation?: boolean;
}

export interface CarouselSlide {
  headline: string;
  body: string;
  imagePrompt: string;
  /** Custom-topic carousel: prefer these for readable "notes" overlay lines when set. */
  bullets?: string[];
  /** Extra teaching bullets for dense notebook pages (merged into compositor rows). */
  denseBullets?: string[];
  /** Short Java/code excerpts — monospace band in dense notebook layout. */
  codeSnippets?: string[];
  notebookSections?: Array<{
    subheading?: string;
    lines: string[];
    bulletItems?: string[];
  }>;
  marginNotes?: string[];
}

export interface CarouselGenerationRequest {
  slides: CarouselSlide[];
  style?: 'professional' | 'creative' | 'minimal';
  includePdf?: boolean;
}

export interface CarouselGenerationBundle {
  imageBuffers: Buffer[];
  pdfBuffer?: Buffer;
}

@Injectable()
export class MediaGenerationService {
  private readonly logger = new Logger(MediaGenerationService.name);
  private readonly openaiApiKey: string;

  /** Current user ID for rate limiting (set per request context) */
  private currentUserId: string = 'anonymous';

  constructor(
    private readonly configService: ConfigService,
    private readonly minioService: MinioService,
    private readonly cacheService: CacheService,
    private readonly openaiRateLimiter: OpenAIRateLimiterService,
  ) {
    this.openaiApiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
  }

  /**
   * Set the current user ID for rate limiting context.
   * Should be called before generating images for a user.
   */
  setCurrentUserId(userId: string): void {
    this.currentUserId = userId || 'anonymous';
  }

  async generateSingleImage(request: ImageGenerationRequest): Promise<Buffer> {
    const cacheKey = this.buildImageCacheKey(request);
    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      this.logger.log('Cache HIT for image prompt');
      return Buffer.from(cached, 'base64');
    }

    const model =
      request.model ||
      this.configService.get<string>('MEDIA_IMAGE_MODEL') ||
      'gpt-image-1-mini';

    const optimizedPrompt = request.skipProductionPromptAugmentation
      ? request.prompt
      : this.buildProductionImagePrompt(request.prompt);
    this.logger.log(
      `Queueing image generation [${model}]: ${optimizedPrompt.substring(0, 60)}... userId=${this.currentUserId}`,
    );

    const isGptImage = model.startsWith('gpt-image');

    const body: Record<string, unknown> = {
      model,
      prompt: optimizedPrompt,
      n: 1,
      size: request.size || '1024x1024',
    };

    if (isGptImage) {
      const qMap: Record<string, string> = { hd: 'high', standard: 'medium' };
      body.quality =
        qMap[request.quality as string] || request.quality || 'medium';
      body.output_format = 'png';
    } else {
      body.quality = request.quality || 'hd';
      body.style = request.style || 'natural';
      body.response_format = 'b64_json';
    }

    // Use rate limiter with automatic retry for rate limit errors
    const base64Image = await this.openaiRateLimiter.executeWithRetry(
      this.currentUserId,
      async () => {
        const response = await axios.post(
          'https://api.openai.com/v1/images/generations',
          body,
          {
            headers: {
              Authorization: `Bearer ${this.openaiApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 90000,
          },
        );
        return response.data.data[0].b64_json as string;
      },
      `image-generation:${model}`,
    );

    await this.cacheService.set(cacheKey, base64Image, 6 * 60 * 60);
    return Buffer.from(base64Image, 'base64');
  }

  /**
   * Render one slide of an educational document-deck preset (`handwritten_notes` /
   * `structured_document`). Deterministic — never calls the OpenAI image API.
   * Outputs a 1080×1080 JPEG buffer. Pricing is unchanged
   * (`2 + 2.5 × slideCount`), cover + TOC counted toward the slide budget.
   */
  async generateDocumentDeckSlide(params: {
    slide: CarouselSlideOutput;
    pageNumber: number;
    totalPages: number;
    theme: CarouselDocumentTheme;
    meta: DocumentDeckMeta;
    /** Required when slide.sectionType === 'toc'. Ignored otherwise. */
    tocEntries?: TocEntry[];
  }): Promise<Buffer> {
    return renderDocumentDeckSlide(params);
  }

  /**
   * Custom-topic carousel: style-controlled base plate, then composited slide text
   * (title + bullets/body) so teaching content is readable even when the image model ignores scene briefs.
   */
  async generateCustomTopicCarouselSlide(
    slide: {
      title: string;
      body: string;
      bullets?: string[];
      imagePrompt: string;
      denseBullets?: string[];
      codeSnippets?: string[];
      notebookSections?: Array<{
        subheading?: string;
        lines: string[];
        bulletItems?: string[];
      }>;
      marginNotes?: string[];
    },
    opts: Pick<ImageGenerationRequest, 'size' | 'quality' | 'model'> & {
      visualStyle: CarouselVisualStyle;
      strictRetry?: boolean;
      /** Drives dense multi-block layout alongside notebook-visual styles */
      noteDensity?: CarouselNoteDensityLevel;
      slideIndex?: number;
      /** True when slide imagePrompt already carries legible handwritten lesson text (skip compositor). */
      skipTextOverlay?: boolean;
    },
  ): Promise<{ buffer: Buffer; overlayApplied: boolean }> {
    const skipOverlay = opts.skipTextOverlay === true;
    const fullPrompt = this.buildCustomTopicCarouselBasePrompt(
      slide.imagePrompt,
      opts.visualStyle,
      opts.strictRetry ?? false,
      skipOverlay,
    );

    const base = await this.generateSingleImage({
      prompt: fullPrompt,
      skipProductionPromptAugmentation: true,
      size: opts.size ?? '1024x1024',
      quality: opts.quality ?? 'medium',
      model: opts.model,
    });

    if (skipOverlay) {
      const buffer = await sharp(base)
        .resize(1024, 1024, { fit: 'cover' })
        .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { buffer, overlayApplied: false };
    }

    const mappedStyle: CarouselGenerationRequest['style'] =
      opts.visualStyle === 'diagram_clean'
        ? 'minimal'
        : opts.visualStyle === 'stock_visual'
          ? 'creative'
          : 'professional';

    let overlayProfile: 'linkedin_panel' | 'notebook_paper' | 'whiteboard' =
      'linkedin_panel';
    if (isNotebookPaperCarouselStyle(opts.visualStyle)) {
      overlayProfile = 'notebook_paper';
    } else if (opts.visualStyle === 'whiteboard_notes') {
      overlayProfile = 'whiteboard';
    }

    /** All ruled notebook paper carousels use the dense compositor (fills page; avoids 3-line cap). */
    const useDenseNotesLayout = overlayProfile === 'notebook_paper';

    const buffer = useDenseNotesLayout
      ? await this.renderDenseNotebookCarouselSlide({
          baseImage: base,
          slide,
          slideIndex: opts.slideIndex ?? 0,
        })
      : await this.renderSafeCarouselSlide(
          {
            headline: slide.title,
            body: slide.body,
            bullets: slide.bullets,
            imagePrompt: slide.imagePrompt,
            notebookSections: slide.notebookSections,
            marginNotes: slide.marginNotes,
          },
          base,
          mappedStyle,
          overlayProfile,
        );

    return { buffer, overlayApplied: true };
  }

  async generateCarouselImages(
    request: CarouselGenerationRequest,
  ): Promise<Buffer[]> {
    try {
      const total = request.slides.length;
      this.logger.log(`Generating carousel with ${total} slides`);

      const maxConcurrency = Number(
        this.configService.get<string>('MEDIA_CAROUSEL_CONCURRENCY') || 3,
      );
      const carouselModel =
        this.configService.get<string>('MEDIA_CAROUSEL_MODEL') ||
        this.configService.get<string>('MEDIA_IMAGE_MODEL') ||
        'gpt-image-1-mini';
      const carouselQuality =
        this.configService.get<string>('MEDIA_CAROUSEL_QUALITY') || 'medium';

      const generated: Buffer[] = [];

      for (let i = 0; i < total; i += maxConcurrency) {
        const batch = request.slides.slice(i, i + maxConcurrency);
        const results = await Promise.all(
          batch.map(async (slide) => {
            const raw = await this.generateSingleImage({
              prompt: slide.imagePrompt,
              size: '1024x1024',
              quality: carouselQuality as ImageGenerationRequest['quality'],
              model: carouselModel as ImageGenerationRequest['model'],
            });
            return this.renderSafeCarouselSlide(slide, raw, request.style);
          }),
        );
        generated.push(...results);
      }

      return generated;
    } catch (error) {
      this.logger.error('Failed to generate carousel images:', error.message);
      throw new Error(`Carousel generation failed: ${error.message}`);
    }
  }

  async generateCarouselPDF(
    request: CarouselGenerationRequest,
  ): Promise<Buffer> {
    try {
      this.logger.log('Generating carousel PDF using local renderer');
      const imageBuffers = await this.generateCarouselImages(request);
      return this.buildPdfFromImages(imageBuffers);
    } catch (error) {
      this.logger.error('Failed to generate carousel PDF:', error.message);
      throw new Error(`Carousel PDF generation failed: ${error.message}`);
    }
  }

  async generateCarouselBundle(
    request: CarouselGenerationRequest,
  ): Promise<CarouselGenerationBundle> {
    const imageBuffers = await this.generateCarouselImages(request);
    const pdfBuffer =
      request.includePdf === false
        ? undefined
        : await this.buildPdfFromImages(imageBuffers);
    return { imageBuffers, pdfBuffer };
  }

  private async renderSafeCarouselSlide(
    slide: CarouselSlide,
    baseImage: Buffer,
    style: CarouselGenerationRequest['style'] = 'professional',
    overlayProfile: 'linkedin_panel' | 'notebook_paper' | 'whiteboard' = 'linkedin_panel',
  ): Promise<Buffer> {
    const headline = this.sanitizeOverlayText(slide.headline || '');
    const body = this.sanitizeOverlayText(slide.body || '');
    const bullets = Array.isArray(slide.bullets)
      ? slide.bullets.map((b) => this.sanitizeOverlayText(String(b))).filter(Boolean)
      : [];

    const CANVAS = 1024;

    if (overlayProfile === 'notebook_paper' || overlayProfile === 'whiteboard') {
      return this.renderNotesStyleCarouselSlide({
        baseImage,
        headline,
        body,
        bullets,
        kind: overlayProfile,
        canvas: CANVAS,
      });
    }

    const overlayOpacity =
      style === 'creative' ? 0.28 : style === 'minimal' ? 0.2 : 0.35;

    const PAD_X = 72;
    const TEXT_W = CANVAS - PAD_X * 2;

    const HEAD_FONT = 48;
    const HEAD_LINE_H = 58;
    const BODY_FONT = 28;
    const BODY_LINE_H = 38;

    const headLines = this.wrapSvgText(headline, HEAD_FONT, TEXT_W, 2);
    const bodyLines = this.flattenBulletOrBodyLines(body, bullets, BODY_FONT, TEXT_W, 9);

    const GAP = 16;
    const contentH =
      headLines.length * HEAD_LINE_H + GAP + bodyLines.length * BODY_LINE_H;
    const BOX_PAD_Y = 32;
    const boxH = contentH + BOX_PAD_Y * 2;
    const BOX_BOTTOM_MARGIN = 80;
    const boxY = CANVAS - boxH - BOX_BOTTOM_MARGIN;
    const boxX = 40;
    const boxW = CANVAS - boxX * 2;

    let textY = boxY + BOX_PAD_Y + HEAD_LINE_H * 0.78;

    const tspans: string[] = [];
    for (const line of headLines) {
      tspans.push(
        `<text x="${PAD_X}" y="${Math.round(textY)}" fill="#ffffff" font-size="${HEAD_FONT}" font-weight="800" font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif">${this.escapeHtml(line)}</text>`,
      );
      textY += HEAD_LINE_H;
    }
    textY += GAP;
    for (const line of bodyLines) {
      tspans.push(
        `<text x="${PAD_X}" y="${Math.round(textY)}" fill="rgba(255,255,255,0.92)" font-size="${BODY_FONT}" font-weight="400" font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif">${this.escapeHtml(line)}</text>`,
      );
      textY += BODY_LINE_H;
    }

    const svg = `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="rgba(0,0,0,${overlayOpacity})"/>
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="24" fill="rgba(0,0,0,0.68)"/>
  ${tspans.join('\n  ')}
</svg>`;

    return sharp(baseImage)
      .resize(CANVAS, CANVAS, { fit: 'cover' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .sharpen()
      .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }

  private flattenBulletOrBodyLines(
    body: string,
    bullets: string[],
    fontSize: number,
    maxWidth: number,
    maxTotalLines: number,
  ): string[] {
    const lines: string[] = [];
    if (bullets.length >= 3) {
      for (const b of bullets.slice(0, 5)) {
        const prefixed = `• ${b}`;
        const wrapped = this.wrapSvgText(prefixed, fontSize, maxWidth, 3);
        for (const wl of wrapped) {
          lines.push(wl);
          if (lines.length >= maxTotalLines) return lines;
        }
      }
      return lines.length > 0 ? lines : this.wrapSvgText(body, fontSize, maxWidth, maxTotalLines);
    }
    return this.wrapSvgText(body, fontSize, maxWidth, maxTotalLines);
  }

  private async renderNotesStyleCarouselSlide(params: {
    baseImage: Buffer;
    headline: string;
    body: string;
    bullets: string[];
    kind: 'notebook_paper' | 'whiteboard';
    canvas: number;
  }): Promise<Buffer> {
    const { baseImage, headline, body, bullets, kind, canvas: CANVAS } = params;

    const paperFill = kind === 'whiteboard' ? '#ecfdf5' : '#fdf7ed';
    const ruleStroke = kind === 'whiteboard' ? '#d1fae5' : '#e8dfd0';
    const headlineFill = kind === 'whiteboard' ? '#064e3b' : '#0f172a';
    const bodyFill = kind === 'whiteboard' ? '#0f766e' : '#334155';

    const PAPER_MARGIN = 48;
    const paperX = PAPER_MARGIN;
    const paperY = 72;
    const paperW = CANVAS - PAPER_MARGIN * 2;
    const paperH = CANVAS - 120;
    const PAD_X_INNER = paperX + 44;
    const TEXT_W = paperW - 88;

    const HEAD_FONT = 44;
    const HEAD_LINE_H = 54;
    const BODY_FONT = 26;
    const BODY_LINE_H = 34;

    const headLines = this.wrapSvgText(headline, HEAD_FONT, TEXT_W, 3);
    const bodyLines = this.flattenBulletOrBodyLines(body, bullets, BODY_FONT, TEXT_W, 11);

    const GAP = 18;
    const contentTop = paperY + 36;

    let y = contentTop + HEAD_LINE_H * 0.82;
    const textNodes: string[] = [];

    for (const hline of headLines) {
      textNodes.push(
        `<text x="${PAD_X_INNER}" y="${Math.round(y)}" fill="${headlineFill}" font-size="${HEAD_FONT}" font-weight="800" font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif">${this.escapeHtml(hline)}</text>`,
      );
      y += HEAD_LINE_H;
    }

    y += GAP;
    for (const bline of bodyLines) {
      textNodes.push(
        `<text x="${PAD_X_INNER}" y="${Math.round(y)}" fill="${bodyFill}" font-size="${BODY_FONT}" font-weight="500" font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif">${this.escapeHtml(bline)}</text>`,
      );
      y += BODY_LINE_H;
      if (y > paperY + paperH - 40) break;
    }

    const ruleStartY = paperY + 110;
    const ruleEndY = paperY + paperH - 36;
    const ruleLines: string[] = [];
    if (kind === 'notebook_paper') {
      for (let ry = ruleStartY; ry < ruleEndY; ry += 40) {
        ruleLines.push(
          `<line x1="${paperX + 28}" y1="${ry}" x2="${
            paperX + paperW - 28
          }" y2="${ry}" stroke="${ruleStroke}" stroke-width="2" opacity="0.95"/>`,
        );
      }
    }

    const marginLine =
      kind === 'notebook_paper'
        ? `<line x1="${PAD_X_INNER - 28}" y1="${paperY + 28}" x2="${
            PAD_X_INNER - 28
          }" y2="${paperY + paperH - 36}" stroke="#f87171" stroke-width="3" opacity="0.55"/>`
        : '';

    const svg = `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="rgba(0,0,0,0.12)"/>
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="18" fill="${paperFill}" stroke="rgba(15,23,42,0.14)" stroke-width="5"/>
  ${ruleLines.join('\n  ')}
  ${marginLine}
  ${textNodes.join('\n  ')}
</svg>`;

    return sharp(baseImage)
      .resize(CANVAS, CANVAS, { fit: 'cover' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .sharpen()
      .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }

  /** Full-page ruled study notes — two columns, code bands, marginalia outside red rule, subtle ink jitter */
  private async renderDenseNotebookCarouselSlide(params: {
    baseImage: Buffer;
    slide: {
      title: string;
      body: string;
      bullets?: string[];
      denseBullets?: string[];
      codeSnippets?: string[];
      notebookSections?: CarouselSlide['notebookSections'];
      marginNotes?: string[];
    };
    slideIndex: number;
  }): Promise<Buffer> {
    const CANVAS = 1024;
    const { baseImage, slide, slideIndex } = params;

    const paperFill = '#fdf7ed';
    const ruleStroke = '#e8dfd0';
    const headlineFill = '#0f172a';

    const PAPER_MARGIN = 44;
    const paperX = PAPER_MARGIN;
    const paperY = 54;
    const paperW = CANVAS - PAPER_MARGIN * 2;
    const paperH = CANVAS - 106;
    const RED_MARGIN_X = paperX + 56;
    const MAIN_TEXT_X = RED_MARGIN_X + 16;
    const MARGIN_NOTE_W = 124;
    const MAIN_TEXT_RIGHT = paperX + paperW - MARGIN_NOTE_W - 22;
    const TEXT_W_MAIN = MAIN_TEXT_RIGHT - MAIN_TEXT_X;
    const COL_GUTTER = 16;
    const colW = Math.max(120, (TEXT_W_MAIN - COL_GUTTER) / 2);
    const col1X = MAIN_TEXT_X;
    const col2X = MAIN_TEXT_X + colW + COL_GUTTER;

    const LINE_STEP = DENSE_NOTEBOOK_LINE_STEP_PX;
    const HEAD_FONT = 35;
    const SUB_FONT = 21;
    const BODY_FONT = 19;
    const CODE_FONT = 17;

    const title = this.sanitizeOverlayText(slide.title || '');
    const titleLines = this.wrapSvgText(title, HEAD_FONT, TEXT_W_MAIN, 3);
    const inkFont = this.svgNotebookInkFamily();
    const monoFont = this.svgNotebookMonoFamily();

    const { mainRows, sidebarLabels } = expandNotebookStructuredRows(
      '',
      slide.notebookSections,
      slide.marginNotes,
      slide.denseBullets,
      slide.codeSnippets,
    );

    const rows: Array<{
      text: string;
      font: number;
      bold: boolean;
      underline: boolean;
      code: boolean;
    }> = [];

    for (const mr of mainRows) {
      if (isCompositorCodeRow(mr)) {
        rows.push({
          text: this.sanitizeOverlayText(unpackCompositorCodeRow(mr)),
          font: CODE_FONT,
          bold: false,
          underline: false,
          code: true,
        });
        continue;
      }
      const isSub = /^§\s/.test(mr);
      const stripped = mr.replace(/^§\s*/, '');
      rows.push({
        text: this.sanitizeOverlayText(stripped || mr),
        font: isSub ? SUB_FONT : BODY_FONT,
        bold: Boolean(isSub),
        underline: isSub,
        code: false,
      });
    }

    if (rows.length === 0 || !slide.notebookSections?.length) {
      const b = this.sanitizeOverlayText(slide.body || '').trim();
      if (b) {
        rows.push({
          text: b,
          font: BODY_FONT,
          bold: false,
          underline: false,
          code: false,
        });
      }
      for (const bb of slide.bullets || []) {
        const t = this.sanitizeOverlayText(String(bb)).trim();
        if (t)
          rows.push({
            text: `• ${t}`,
            font: BODY_FONT,
            bold: false,
            underline: false,
            code: false,
          });
      }
      for (const bb of slide.denseBullets || []) {
        const t = this.sanitizeOverlayText(String(bb)).trim();
        if (t)
          rows.push({
            text: `• ${t}`,
            font: BODY_FONT,
            bold: false,
            underline: false,
            code: false,
          });
      }
      for (const c of slide.codeSnippets || []) {
        const t = this.sanitizeOverlayText(String(c)).trim();
        if (t)
          rows.push({
            text: t,
            font: CODE_FONT,
            bold: false,
            underline: false,
            code: true,
          });
      }
    }

    type Viz = {
      text: string;
      font: number;
      bold: boolean;
      underline: boolean;
      code: boolean;
    };

    const wrappedVisual: Viz[] = [];
    for (const row of rows) {
      const maxW = row.code ? TEXT_W_MAIN : colW;
      const maxLn = row.code ? 14 : 8;
      const w = this.wrapSvgText(row.text, row.font, maxW, maxLn).map((t) => ({
        text: t,
        font: row.font,
        bold: row.bold,
        underline: row.underline,
        code: row.code,
      }));
      for (const x of w) wrappedVisual.push(x);
    }

    const ruleStartY = paperY + LINE_STEP + 24;
    const ruleEndY = paperY + paperH - LINE_STEP;

    const ruleGraphics: string[] = [];
    for (let ry = ruleStartY; ry <= ruleEndY; ry += LINE_STEP) {
      ruleGraphics.push(
        `<line x1="${MAIN_TEXT_X - 14}" y1="${ry}" x2="${MAIN_TEXT_RIGHT}" y2="${ry}" stroke="${ruleStroke}" stroke-width="1.5" opacity="0.92"/>`,
      );
    }
    ruleGraphics.unshift(
      `<line x1="${RED_MARGIN_X}" y1="${paperY + 20}" x2="${RED_MARGIN_X}" y2="${ruleEndY + 4}" stroke="#fb923c" stroke-width="3" opacity="0.52"/>`,
    );

    const textNodes: string[] = [];

    let yFree = paperY + 42;
    for (const tl of titleLines) {
      const n = this.handwritingNudge(slideIndex, textNodes.length, 0);
      const rot = this.handwritingRotateDeg(slideIndex, textNodes.length);
      textNodes.push(
        `<text transform="translate(${col1X + n.dx},${Math.round(
          yFree + HEAD_FONT * 0.78 + n.dy,
        )}) rotate(${rot})" fill="${headlineFill}" font-size="${HEAD_FONT}" font-weight="800" font-family="${inkFont}">${this.escapeHtml(
          tl,
        )}</text>`,
      );
      yFree += HEAD_FONT + 12;
    }

    let baseline = ruleStartY + LINE_STEP + Math.ceil((yFree - ruleStartY) / LINE_STEP) * LINE_STEP;
    baseline = Math.max(baseline, ruleStartY + LINE_STEP * 2);

    let globalLineIdx = 0;

    const pushInkOrMono = (viz: Viz, x: number, baseY: number, colKey: number) => {
      const nudge = viz.code
        ? { dx: 0, dy: 0 }
        : this.handwritingNudge(slideIndex, globalLineIdx, colKey);
      const rot = viz.code ? 0 : this.handwritingRotateDeg(slideIndex, globalLineIdx);
      const fam = viz.code ? monoFont : inkFont;
      const weight = viz.bold ? '700' : '500';
      const fill = viz.code ? '#0f172a' : viz.bold ? headlineFill : '#1e293b';
      const deco = viz.underline ? 'underline' : 'none';
      const sz = viz.font;
      const esc = this.escapeHtml(viz.text);
      if (viz.code) {
        textNodes.push(
          `<rect x="${x - 6}" y="${baseY - sz * 0.85}" width="${TEXT_W_MAIN + 15}" height="${
            LINE_STEP - 2
          }" rx="5" fill="rgba(241,245,249,0.72)" stroke="rgba(148,163,184,0.45)" stroke-width="1"/>`,
        );
      } else if (
        globalLineIdx + slideIndex !== 0 &&
        globalLineIdx % 11 === slideIndex % 4
      ) {
        textNodes.push(
          `<rect x="${x - 10}" y="${baseY - LINE_STEP + 10}" width="${
            colW + 18
          }" height="${LINE_STEP - 3}" rx="4" fill="#fef08a" opacity="0.34"/>`,
        );
      }
      textNodes.push(
        `<text transform="translate(${x + nudge.dx},${Math.round(
          baseY + sz * 0.72 + nudge.dy,
        )}) rotate(${rot})" fill="${fill}" font-size="${sz}" font-weight="${weight}" font-family="${fam}" text-decoration="${deco}">${esc}</text>`,
      );
      globalLineIdx++;
    };

    let wi = 0;
    while (wi < wrappedVisual.length && baseline <= ruleEndY - LINE_STEP) {
      const v = wrappedVisual[wi];
      if (v.code) {
        pushInkOrMono(v, MAIN_TEXT_X, baseline, 0);
        baseline += LINE_STEP;
        wi++;
        continue;
      }

      const chunk: Viz[] = [];
      while (wi < wrappedVisual.length && !wrappedVisual[wi].code) {
        chunk.push(wrappedVisual[wi]);
        wi++;
      }
      const mid = Math.ceil(chunk.length / 2);
      const lhs = chunk.slice(0, mid);
      const rhs = chunk.slice(mid);
      const pairRows = Math.max(lhs.length, rhs.length);
      for (let r = 0; r < pairRows; r++) {
        if (baseline > ruleEndY - LINE_STEP) break;
        const L = lhs[r];
        const R = rhs[r];
        if (L) pushInkOrMono(L, col1X, baseline, 1);
        if (R) pushInkOrMono(R, col2X, baseline, 2);
        baseline += LINE_STEP;
      }
    }

    const leftMarginalia = sidebarLabels.slice(0, 2);
    const rightMarginalia = sidebarLabels.slice(2);

    let mx = paperX + 8;
    let my = ruleStartY + LINE_STEP;
    for (const note of leftMarginalia) {
      if (my > ruleEndY - LINE_STEP * 5) break;
      const small = BODY_FONT - 6;
      const rot = -2.4 + (slideIndex % 3) * 0.35;
      const noteLines = this.wrapSvgText(note, small, RED_MARGIN_X - mx - 10, 5);
      for (const nl of noteLines) {
        textNodes.push(
          `<text transform="translate(${mx},${Math.round(
            my + small * 0.78,
          )}) rotate(${rot})" fill="#57534e" font-size="${small}" font-weight="600" font-style="italic" font-family="${inkFont}">${this.escapeHtml(
            nl,
          )}</text>`,
        );
        my += small * 1.12;
      }
      my += LINE_STEP * 0.55;
    }

    const doodle =
      slideIndex % 5 === 0
        ? `<path d="M ${MAIN_TEXT_RIGHT - 90} ${ruleStartY + LINE_STEP * 5} q 60 70 108 16" stroke="rgba(148,163,184,0.45)" stroke-width="2.1" fill="none"/>`
        : '';

    const marginNodes: string[] = [];
    let ny = ruleStartY + LINE_STEP * 2;
    for (const note of rightMarginalia) {
      if (ny > ruleEndY - LINE_STEP * 6) break;
      const small = BODY_FONT - 4;
      const noteLines = this.wrapSvgText(note, small, MARGIN_NOTE_W - 18, 5);
      const boxH =
        LINE_STEP * Math.min(10, Math.max(3.3, noteLines.length * 1.25));
      const boxX = MAIN_TEXT_RIGHT + 10;
      marginNodes.push(
        `<rect x="${boxX}" y="${ny}" width="${MARGIN_NOTE_W - 14}" height="${boxH}" rx="11" stroke="#94a3b8" stroke-width="1.6" fill="rgba(255,251,235,0.93)"/>`,
      );
      let ty = ny + small + 6;
      for (const nl of noteLines) {
        const rn = this.handwritingNudge(slideIndex, Math.round(ty), 3);
        marginNodes.push(
          `<text transform="translate(${boxX + 14 + rn.dx},${Math.round(
            ty + rn.dy,
          )}) rotate(${this.handwritingRotateDeg(slideIndex, Math.round(ty))})" fill="#475569" font-size="${small}" font-weight="600" font-style="italic" font-family="${inkFont}">${this.escapeHtml(
            nl,
          )}</text>`,
        );
        ty += small * 1.1;
      }
      ny += boxH + LINE_STEP * 1.05;
    }

    const grainId = `nbGrain${slideIndex}`;
    const defs = `<defs>
  <filter id="${grainId}" x="-10%" y="-10%" width="120%" height="120%">
    <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" stitchTiles="stitch" result="noise"/>
    <feColorMatrix in="noise" type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0.11 0"/>
  </filter>
</defs>`;

    const svg = `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
${defs}
  <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="rgba(0,0,0,0.10)"/>
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="18" fill="${paperFill}" stroke="rgba(15,23,42,0.12)" stroke-width="5"/>
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="18" fill="white" filter="url(#${grainId})" opacity="0.28"/>
  ${ruleGraphics.join('\n  ')}
  ${doodle}
  ${textNodes.join('\n  ')}
  ${marginNodes.join('\n  ')}
</svg>`;

    return sharp(baseImage)
      .resize(CANVAS, CANVAS, { fit: 'cover' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .sharpen()
      .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }

  /** System-safe handwriting stack — cursive + DejaVu fallback when novelty fonts are missing. */
  private svgNotebookInkFamily(): string {
    return '"Comic Neue", "Patrick Hand", "Segoe Print", "Segoe Script", "Apple Chancery", cursive, DejaVu Sans, sans-serif';
  }

  private svgNotebookMonoFamily(): string {
    return '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';
  }

  private handwritingRotateDeg(slideIndex: number, lineIndex: number): number {
    const s = (slideIndex * 1103 + lineIndex * 97) % 120;
    return Number(((s / 120) * 1.6 - 0.8).toFixed(3));
  }

  private handwritingNudge(
    slideIndex: number,
    lineIndex: number,
    col: number,
  ): { dx: number; dy: number } {
    const s = (slideIndex * 4243 + lineIndex * 131 + col * 17) % 900;
    return { dx: Math.round((s % 7) - 3), dy: Math.round(((s / 7) % 5) - 2) };
  }

  private wrapSvgText(
    text: string,
    fontSize: number,
    maxWidth: number,
    maxLines: number,
  ): string[] {
    const avgCharW = fontSize * 0.52;
    const maxChars = Math.floor(maxWidth / avgCharW);
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (test.length > maxChars && current) {
        lines.push(current);
        current = word;
        if (lines.length >= maxLines) break;
      } else {
        current = test;
      }
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (lines.length === maxLines && words.length > 0) {
      const last = lines[maxLines - 1];
      if (last.length > maxChars - 3) {
        lines[maxLines - 1] = last.slice(0, maxChars - 3) + '...';
      }
    }
    return lines.length > 0 ? lines : [''];
  }

  private buildImageCacheKey(request: ImageGenerationRequest): string {
    const hash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex')
      .slice(0, 24);
    return `media:image:${hash}`;
  }

  private buildCustomTopicCarouselBasePrompt(
    sceneBrief: string,
    style: CarouselVisualStyle,
    strictRetry: boolean,
    lessonTextInRaster = false,
  ): string {
    const brief = sceneBrief.trim();
    const clamp =
      strictRetry
        ? ' CRITICAL: Fill the entire square with flat study-surface only (paper/board). No food, dinner plates, trophies, or unrelated lifestyle stock props.'
        : '';

    switch (style) {
      case 'handwritten_notebook':
      case 'handwritten_notebook_dense':
        if (lessonTextInRaster) {
          return [
            'Square TOP-DOWN photograph of one ruled or subtly dotted cream notebook page on a desk, filling the frame.',
            'Dense realistic student handwriting (blue/black ink or pencil) covering the page — titles, bullets, short code or math lines, small diagrams — LEGIBLE at carousel resolution like real exam-prep notes.',
            'Natural layout: headings, indent levels, margin callouts, arrows; warm paper; soft overhead light; no unrelated stock props; no watermarks or brand marks.',
            `Lesson content to ink onto the page (stay faithful; expand slightly for fill if needed): ${brief}`,
            clamp,
          ].join(' ');
        }
        return [
          'Square TOP-DOWN photograph of a single notebook or desk-paper page filling the frame.',
          'Ruled or subtle dotted paper texture; warm off-white paper; soft natural desk lighting from above.',
          'Optional illegible graphite or marker doodles, soft smudges, empty diagram boxes — absolutely NO readable letters, digits, logos, or watermarks.',
          'No unrelated photoreal metaphor objects unless the user explicitly asked for them.',
          `Background scene brief: ${brief}`,
          clamp,
        ].join(' ');

      case 'whiteboard_notes':
        return [
          'Square straight-on photo of a classroom whiteboard OR light green chalkboard surface filling the frame.',
          'Faint dry-erase strokes, smudges, abstract curves only — NO readable text, numbers, logos, or watermarks.',
          `Board mood brief: ${brief}`,
          clamp,
        ].join(' ');

      case 'diagram_clean':
        return [
          'Square abstract technical diagram background with soft gradient, faint grid, unlabeled nodes/edges/flow shapes.',
          'Clean vector-like flat illustration; absolutely NO readable letters, digits, or brand marks.',
          `Composition brief: ${brief}`,
        ].join(' ');

      case 'stock_visual':
      default:
        return [
          'High-quality illustrative square LinkedIn-ready background.',
          'CRITICAL: No readable letters, digits, logos, watermarks.',
          `Scene brief: ${brief}`,
          clamp,
        ].join(' ');
    }
  }

  private buildProductionImagePrompt(prompt: string): string {
    const lower = prompt.toLowerCase();
    const notebookStudyStyle =
      /handwritten|hand-writing|notebook|notepad|lecture notes|study notes|sketch notes|whiteboard|\bdsa\b|leetcode|interview prep/.test(
        lower,
      );

    const preamble = notebookStudyStyle
      ? [
          'Create a square illustrative study-notes aesthetic background.',
          'Warm paper texture, subtle ruled lines, hand-drawn marker strokes and diagram shapes.',
          'Illegible scribbles or abstract curves only — absolutely NO readable letters, digits, logos, or watermarks.',
          'Educational mood: focused desk learning, interview preparation vibe.',
        ]
      : [
          'Create a high-quality, photorealistic LinkedIn visual.',
          'CRITICAL: Do NOT include any text, letters, numbers, logos, or watermarks inside the generated image.',
          'Use clean composition, balanced lighting, and professional business aesthetics.',
          'Avoid distorted objects and avoid surreal artifacts.',
        ];

    return [...preamble, `Scene brief: ${prompt}`].join(' ');
  }

  private async buildPdfFromImages(images: Buffer[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false, compress: true });
      const chunks: Buffer[] = [];
      const stream = new PassThrough();
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);

      doc.pipe(stream);
      for (const image of images) {
        doc.addPage({ size: [1024, 1024], margin: 0 });
        doc.image(image, 0, 0, { width: 1024, height: 1024 });
      }
      doc.end();
    });
  }

  /**
   * Build a carousel PDF from already-uploaded slide URLs (no OpenAI / slide regeneration).
   * Used when LinkedIn requires a document but `pdf_url` was never stored (e.g. async carousel
   * with includePdf: false).
   */
  async createCarouselPdfFromImageUrls(imageUrls: string[]): Promise<Buffer> {
    const urls = (imageUrls || []).filter(
      (u) => typeof u === 'string' && u.trim().length > 0,
    );
    if (urls.length === 0) {
      throw new Error('No valid carousel image URLs for PDF assembly');
    }

    const maxConcurrency = Number(
      this.configService.get<string>('MEDIA_CAROUSEL_FETCH_CONCURRENCY') || 3,
    );
    const buffers: Buffer[] = [];
    for (let i = 0; i < urls.length; i += maxConcurrency) {
      const batch = urls.slice(i, i + maxConcurrency);
      const batchIdxStart = i;
      const parts = await Promise.all(
        batch.map((url, j) =>
          this.fetchAndNormalizeSlideImageForPdf(url, batchIdxStart + j),
        ),
      );
      buffers.push(...parts);
    }

    return this.buildPdfFromImages(buffers);
  }

  private async fetchAndNormalizeSlideImageForPdf(
    url: string,
    slideIndex: number,
  ): Promise<Buffer> {
    try {
      const res = await axios.get(url.trim(), {
        responseType: 'arraybuffer',
        timeout: 90_000,
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const raw = Buffer.from(res.data as ArrayBuffer);
      return await sharp(raw)
        .rotate()
        .resize(1024, 1024, { fit: 'cover' })
        .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to fetch or normalize carousel slide ${slideIndex + 1} from ${url}: ${msg}`,
      );
      throw new Error(
        `Failed to load carousel slide ${slideIndex + 1} for PDF. Ensure slide URLs are reachable.`,
      );
    }
  }

  async optimizeImage(
    imageBuffer: Buffer,
    maxWidth = 1024,
    quality = 90,
  ): Promise<Buffer> {
    try {
      return await sharp(imageBuffer)
        .resize(maxWidth, maxWidth, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality })
        .toBuffer();
    } catch (error) {
      this.logger.error('Failed to optimize image:', error.message);
      throw new Error(`Image optimization failed: ${error.message}`);
    }
  }

  /**
   * Resize + watermark + **one** JPEG encode (free plan). Avoids optimize→watermark
   * double JPEG passes which heavily blurs the overlay.
   */
  async optimizeImageWithWatermark(
    imageBuffer: Buffer,
    maxWidth = 1024,
  ): Promise<Buffer> {
    const logoPath = path.join(
      process.cwd(),
      'assets',
      'brand',
      'logo-full-main.png',
    );
    if (!fs.existsSync(logoPath)) {
      this.logger.warn(
        `Brand watermark skipped: logo not found at ${logoPath}`,
      );
      return this.optimizeImage(imageBuffer, maxWidth);
    }

    const lanczos = sharp.kernel.lanczos3;

    try {
      // PNG intermediate: avoids JPEG→resize→JPEG before composite (double lossy encode on base).
      const { data: resizedBuf, info } = await sharp(imageBuffer)
        .resize(maxWidth, maxWidth, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 6 })
        .toBuffer({ resolveWithObject: true });

      const width = info.width || 1024;
      const height = info.height || 1024;

      const logoBuffer = fs.readFileSync(logoPath);

      const pct = 0.21;
      const minLogoPx = 168;
      const maxLogoPx = 236;
      const maxCanvasShare = 0.4;

      let targetLogoWidth = Math.round(width * pct);
      targetLogoWidth = Math.min(
        maxLogoPx,
        Math.max(minLogoPx, targetLogoWidth),
      );
      targetLogoWidth = Math.min(
        targetLogoWidth,
        Math.floor(width * maxCanvasShare),
      );
      targetLogoWidth = Math.max(56, targetLogoWidth);

      const hiW = Math.min(targetLogoWidth * 3, 900);
      const logoHi = await sharp(logoBuffer)
        .resize({
          width: hiW,
          kernel: lanczos,
          withoutEnlargement: false,
        })
        .ensureAlpha()
        .png()
        .toBuffer();

      const logoResized = await sharp(logoHi)
        .resize({
          width: targetLogoWidth,
          kernel: lanczos,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      const logoMeta = await sharp(logoResized).metadata();
      const lw = logoMeta.width || 0;
      const lh = logoMeta.height || 0;
      // Tight to bottom-right (avoid large %-based padding that “floats” the mark inward)
      const margin = 4;
      const left = Math.max(0, width - lw - margin);
      const top = Math.max(0, height - lh - margin);

      return await sharp(resizedBuf)
        .composite([{ input: logoResized, left, top }])
        .jpeg({
          quality: 85,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: '4:4:4',
        })
        .toBuffer();
    } catch (error) {
      this.logger.error('Watermark failed:', (error as Error).message);
      return this.optimizeImage(imageBuffer, maxWidth);
    }
  }

  async uploadToMinio(
    buffer: Buffer,
    fileName: string,
    contentType: string,
    userId: string,
  ): Promise<string> {
    try {
      const bucketName = 'contentos-media';
      const objectName = `${userId}/${Date.now()}-${fileName}`;

      await this.minioService.uploadFile(
        bucketName,
        objectName,
        buffer,
        contentType,
      );

      // Generate public URL
      const publicUrl = await this.minioService.getPublicUrl(
        bucketName,
        objectName,
      );

      return publicUrl;
    } catch (error) {
      this.logger.error('Failed to upload to MinIO:', error.message);
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  private escapeHtml(text: string): string {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  private sanitizeOverlayText(input: string): string {
    return String(input || '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E\n]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Rate limiting helper
  async checkRateLimit(userId: string, endpoint: string): Promise<boolean> {
    const key = `rate_limit:${userId}:${endpoint}`;
    const current = await this.cacheService.get(key);

    if (!current) {
      await this.cacheService.set(key, '1', 3600); // 1 hour
      return true;
    }

    const count = parseInt(current, 10);
    const maxRequests = this.getMaxRequestsForEndpoint(endpoint);

    if (count >= maxRequests) {
      return false;
    }

    await this.cacheService.set(key, (count + 1).toString(), 3600);
    return true;
  }

  private getMaxRequestsForEndpoint(endpoint: string): number {
    const limits = {
      'image-generation': 50,
      'carousel-generation': 20,
      'pdf-generation': 30,
    };
    return limits[endpoint] || 100;
  }
}
