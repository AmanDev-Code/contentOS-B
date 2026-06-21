import { Injectable, Logger } from '@nestjs/common';
import {
  AiGatewayService,
  type ChatMessageContent,
} from './ai-gateway.service';
import {
  BrandProfilesService,
  type BrandProfile,
} from './brand-profiles.service';
import { parseJsonFromLlmPayload } from '../common/utils/parse-json-from-llm';

export interface BrandVisualAnalysis {
  logoDescription: string | null;
  referenceStyleDescription: string | null;
  compositePromptFragment: string;
  analyzedAt: string;
  analyzedImageCount: number;
}

const ANALYSIS_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

@Injectable()
export class BrandVisionAnalysisService {
  private readonly logger = new Logger(BrandVisionAnalysisService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly brandProfiles: BrandProfilesService,
  ) {}

  /**
   * Get the cached visual description or analyze brand images on demand.
   * Returns a text fragment ready to inject into image generation prompts.
   */
  async getOrAnalyze(
    userId: string,
    brand: BrandProfile,
  ): Promise<BrandVisualAnalysis | null> {
    const imageUrls = this.collectImageUrls(brand);
    if (imageUrls.length === 0) return null;

    const cached = this.getCached(brand);
    if (cached && cached.analyzedImageCount === imageUrls.length) {
      return cached;
    }

    try {
      const analysis = await this.analyzeWithVision(brand, imageUrls);
      await this.cacheAnalysis(userId, brand, analysis);
      return analysis;
    } catch (e) {
      this.logger.warn(
        `Brand vision analysis failed (non-blocking): ${(e as Error).message}`,
      );
      return cached ?? null;
    }
  }

  private collectImageUrls(brand: BrandProfile): string[] {
    const urls: string[] = [];
    if (brand.logo_url) urls.push(brand.logo_url);
    for (const asset of brand.assets ?? []) {
      if (
        asset.url &&
        (asset.kind === 'reference' ||
          asset.kind === 'style' ||
          asset.kind === 'screenshot' ||
          !asset.kind)
      ) {
        urls.push(asset.url);
      }
    }
    return urls;
  }

  private getCached(brand: BrandProfile): BrandVisualAnalysis | null {
    const meta = brand.metadata;
    const stored = meta?.brandVisualAnalysis as BrandVisualAnalysis | undefined;
    if (!stored?.analyzedAt) return null;
    const age = Date.now() - new Date(stored.analyzedAt).getTime();
    if (age > ANALYSIS_TTL_MS) return null;
    return stored;
  }

  private async cacheAnalysis(
    userId: string,
    brand: BrandProfile,
    analysis: BrandVisualAnalysis,
  ): Promise<void> {
    try {
      const existingMeta = brand.metadata ?? {};
      // Metadata-only patch — never overwrites logo/colors/assets/voice.
      // Scoped to this user's own brand row (per-user isolated).
      await this.brandProfiles.updateMetadata(userId, brand.id, {
        ...existingMeta,
        brandVisualAnalysis: analysis,
      });
    } catch (e) {
      this.logger.warn(
        `Failed to cache brand analysis: ${(e as Error).message}`,
      );
    }
  }

  private async analyzeWithVision(
    brand: BrandProfile,
    imageUrls: string[],
  ): Promise<BrandVisualAnalysis> {
    this.logger.log(
      `Analyzing ${imageUrls.length} brand image(s) with vision model for "${brand.name}"`,
    );

    const imageContent: ChatMessageContent = [];
    imageContent.push({
      type: 'text',
      text: [
        'You are a graphic designer describing these images so another designer can',
        'recreate the same visual style without seeing the originals.',
        '',
        'For the images, describe concretely:',
        '1. ICON/MARK (if any): Exact shape, symbol elements, typography style, colors, proportions.',
        '   Be specific: "upward arrow shape with a red-to-orange gradient and a dark metallic facet".',
        '2. COLOR PALETTE: Every color you can identify, with hex codes.',
        '3. VISUAL STYLE: Photography vs illustration, lighting, mood, texture, grain, contrast.',
        '4. COMPOSITION: Layout, spacing, balance, focal points.',
        '5. OVERALL FEELING: Premium/casual/playful/corporate/bold/minimal, etc.',
        '',
        `Name: "${brand.name}"`,
        brand.primary_color
          ? `Stated primary color: ${brand.primary_color}`
          : '',
        brand.secondary_color
          ? `Stated secondary color: ${brand.secondary_color}`
          : '',
        brand.accent_color ? `Stated accent color: ${brand.accent_color}` : '',
        '',
        'Return a JSON object with these fields:',
        '{"logoDescription": "concrete description of the icon/mark or null if none",',
        ' "referenceStyleDescription": "description of the overall visual style or null",',
        ' "compositePromptFragment": "a 2-4 sentence paragraph that can be inserted directly into an image generation prompt to reproduce this visual identity — include hex colors, mood, style, and key visual elements"}',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    for (const url of imageUrls) {
      imageContent.push({
        type: 'image_url',
        image_url: { url, detail: 'high' },
      });
    }

    const { content, model } = await this.aiGateway.chatCompletionRaw({
      category: 'vision',
      temperature: 0.3,
      maxTokens: 2048,
      jsonObject: true,
      timeoutMs: 60_000,
      messages: [
        {
          role: 'user',
          content: imageContent,
        },
      ],
    });

    this.logger.log(`Vision analysis completed using model: ${model}`);

    const parsed =
      (parseJsonFromLlmPayload(content) as Record<string, unknown>) ?? {};

    return {
      logoDescription:
        typeof parsed.logoDescription === 'string'
          ? parsed.logoDescription
          : null,
      referenceStyleDescription:
        typeof parsed.referenceStyleDescription === 'string'
          ? parsed.referenceStyleDescription
          : null,
      compositePromptFragment:
        typeof parsed.compositePromptFragment === 'string'
          ? parsed.compositePromptFragment
          : '',
      analyzedAt: new Date().toISOString(),
      analyzedImageCount: imageUrls.length,
    };
  }
}
