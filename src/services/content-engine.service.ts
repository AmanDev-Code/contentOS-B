import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { SupabaseService } from './supabase.service';
import { AiGatewayService, AiGatewayError } from './ai-gateway.service';
import { PlatformPublishersService } from './platform-publishers.service';
import { ProfileRepository } from '../repositories/profile.repository';
import { LinkedInAuthService } from '../integrations/social/providers/linkedin/linkedin-auth.service';
import { MinioService } from './minio.service';
import {
  generateDiagram,
  generateOGImage,
  generatePlatformCoverImage,
  platformUsesImages,
  PLATFORM_IMAGE_CONFIGS,
  generateInlineImage,
  detectInlineImageStyle,
  extractInlineImageData,
  InlineImageStyle,
  shouldSkipImageForSection,
  buildImageDecisionPrompt,
  parseImageDecisionResponse,
  validateImageData,
  AIImageDecision,
} from '../utils/image-generation.util';

export interface GeneratePlanInput {
  primary_keyword: string;
  secondary_keywords?: string[];
  target_audience: string;
  business_type?: string;
  country?: string;
  language?: string;
  search_intent?: string;
  competitors?: string[];
  article_length?: number;
}

export interface ContentPlan {
  suggested_title: string;
  heading_structure: { level: 'h2' | 'h3'; text: string }[];
  recommended_word_count: number;
  content_angle: string;
  keyword_placement: string;
}

export interface GeneratedArticle {
  title: string;
  slug: string;
  subtitle: string;
  excerpt: string;
  body: string;
  tags: string[];
  seo_title: string;
  seo_description: string;
  seo_keywords: string;
  faq_json: { question: string; answer: string }[];
  reading_minutes: number;
  og_image_prompt: string;
  seo_score: number;
  aeo_score: number;
  geo_score: number;
  eeat_score: number;
  readability_score: number;
  quality_score: number;
  internal_link_suggestions: string[];
}

@Injectable()
export class ContentEngineService {
  private readonly logger = new Logger(ContentEngineService.name);
  private static readonly LINKEDIN_PLATFORMS = [
    'linkedin_post',
    'linkedin_article',
  ] as const;
  private static readonly TRNDINN_OAUTH_SOURCE = 'trndinn_oauth';
  private static readonly TOKEN_EXPIRY_SKEW_MS = 60_000;

  /**
   * Hard character limits for each platform.
   * These are ENFORCED after all generation and processing.
   * Limits are based on platform API limits and best practices.
   */
  private static readonly PLATFORM_CHARACTER_LIMITS: Record<string, number> = {
    // Auto-publish platforms
    linkedin_post: 3000,        // LinkedIn post limit is 3000 chars
    linkedin_article: 8000,     // ~1500-2000 words for readability
    devto: 20000,               // Dev.to has no hard limit, but 20k is reasonable
    hashnode: 20000,            // Similar to Dev.to
    medium: 15000,              // Medium articles ~3000 words max
    ghost: 15000,               // Ghost blog posts
    beehiiv: 10000,             // Newsletter format, shorter
    telegraph: 10000,           // Telegraph articles
    blogger: 15000,             // Blogger posts
    // Submit for review platforms
    hackernoon: 15000,          // Editorial content
    towards_ai: 15000,          // Technical articles
    analytics_vidhya: 15000,    // Data science articles
    freecodecamp: 15000,        // Tutorial content
    smashing_magazine: 15000,   // Web dev articles
    sitepoint: 15000,           // Technical tutorials
    readwrite: 12000,           // Tech news/analysis
    yourstory: 12000,           // Startup stories
    startuptalky: 12000,        // Startup content
    inc42: 12000,               // Indian startup ecosystem
    techstory: 12000,           // Tech stories
    // Discussion platforms
    reddit: 10000,              // Reddit self-post limit is 40k, but 10k is optimal
    indiehackers: 10000,        // Community posts
    producthunt_discussions: 5000, // Product Hunt discussions
    growthhackers: 8000,        // Growth marketing
    hackernews: 2000,           // HN prefers brief, link to full article
    huggingface_community: 8000, // ML community posts
    // Social/other platforms
    twitter_thread: 4000,       // ~15 tweets max (280 * 15)
    newsletter: 10000,          // Email newsletters
    substack: 12000,            // Substack posts
    facebook: 3000,             // Facebook posts
    instagram: 2200,            // Instagram caption limit
  };

  constructor(
    private readonly supabase: SupabaseService,
    private readonly aiGateway: AiGatewayService,
    private readonly platformPublishers: PlatformPublishersService,
    private readonly profileRepository: ProfileRepository,
    @Optional()
    @Inject(LinkedInAuthService)
    private readonly linkedInAuth?: LinkedInAuthService,
    @Optional()
    @Inject(MinioService)
    private readonly minioService?: MinioService,
  ) {}

  /**
   * Strip C2PA Content Credentials and other AI-provider metadata from images.
   * Re-encodes from decoded pixels so provider manifests (EXIF, XMP, IPTC, C2PA)
   * are not carried through. This prevents LinkedIn's "cr" badge detection.
   */
  private async stripAiMetadata(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const meta = await sharp(imageBuffer).metadata();
      const format = meta.format;
      if (format === 'jpeg' || format === 'jpg') {
        return sharp(imageBuffer)
          .rotate()
          .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
          .toBuffer();
      }
      return sharp(imageBuffer)
        .rotate()
        .png({ compressionLevel: 6 })
        .toBuffer();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`stripAiMetadata failed, using original buffer: ${msg}`);
      return imageBuffer;
    }
  }

  /**
   * Enforce hard character limits for a platform.
   * Truncates content intelligently at sentence/paragraph boundaries when possible.
   * This is the FINAL step before saving/publishing - ensures content never exceeds platform limits.
   */
  private enforceCharacterLimit(content: string, platform: string): string {
    const limit = ContentEngineService.PLATFORM_CHARACTER_LIMITS[platform];
    if (!limit || content.length <= limit) {
      return content;
    }

    const originalLength = content.length;
    this.logger.warn(`[${platform}] Content exceeds limit: ${originalLength} chars > ${limit} limit. Truncating...`);

    // Try to truncate at a good boundary
    let truncated = content.substring(0, limit);

    // For platforms with hashtags at the end, preserve them
    const hashtagMatch = content.match(/(\n+[-—]+\n+)?(\s*#\w+(\s+#\w+)*\s*)$/);
    const hashtagSection = hashtagMatch ? hashtagMatch[0] : '';
    const hashtagLength = hashtagSection.length;

    if (hashtagLength > 0 && hashtagLength < limit * 0.1) {
      // Preserve hashtags if they're less than 10% of the limit
      truncated = content.substring(0, limit - hashtagLength - 50); // Leave room for ellipsis
    }

    // Find the last complete sentence or paragraph
    const lastParagraphBreak = truncated.lastIndexOf('\n\n');
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('.\n'),
      truncated.lastIndexOf('! '),
      truncated.lastIndexOf('!\n'),
      truncated.lastIndexOf('? '),
      truncated.lastIndexOf('?\n'),
    );

    // Prefer paragraph break if it's not too far back (within 20% of limit)
    if (lastParagraphBreak > limit * 0.8) {
      truncated = truncated.substring(0, lastParagraphBreak);
    } else if (lastSentenceEnd > limit * 0.7) {
      truncated = truncated.substring(0, lastSentenceEnd + 1);
    }

    // Add ellipsis and hashtags back if applicable
    truncated = truncated.trim();
    if (!truncated.endsWith('.') && !truncated.endsWith('!') && !truncated.endsWith('?')) {
      truncated += '...';
    }

    if (hashtagLength > 0) {
      truncated += '\n\n' + hashtagSection.trim();
    }

    // Final safety check - hard cut if still over
    if (truncated.length > limit) {
      truncated = truncated.substring(0, limit - 3) + '...';
    }

    this.logger.log(`[${platform}] Truncated from ${originalLength} to ${truncated.length} chars`);
    return truncated;
  }

  /**
   * Get the character limit for a platform.
   * Returns undefined if no limit is defined.
   */
  private getPlatformCharacterLimit(platform: string): number | undefined {
    return ContentEngineService.PLATFORM_CHARACTER_LIMITS[platform];
  }

  /**
   * Extract JSON from AI response that may be wrapped in markdown code blocks.
   * Handles: ```json ... ```, ``` ... ```, or raw JSON.
   */
  private extractJsonFromAiResponse(content: string): string {
    if (!content) return content;
    let cleaned = content.trim();
    
    // First, try to find and extract content from markdown code blocks
    // Patterns to handle:
    // 1. ```json\n{...}\n```
    // 2. ```\n{...}\n```
    // 3. Text before/after the code block
    
    // Try to find code block with optional json language specifier
    const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
    const match = cleaned.match(codeBlockPattern);
    
    if (match && match[1]) {
      cleaned = match[1].trim();
    } else {
      // If no code block found, try stripping leading/trailing backticks anyway
      // This handles malformed wrappers like ```json\n{...} without closing ```
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
    }
    
    return cleaned.trim();
  }

  /**
   * Safely parse JSON from AI response, handling markdown wrapping.
   * Enhanced to handle malformed JSON with basic recovery.
   */
  private parseAiJson(content: string): any {
    const extracted = this.extractJsonFromAiResponse(content);
    try {
      return JSON.parse(extracted);
    } catch (error) {
      // Try to recover from common JSON errors
      this.logger.warn(
        `Initial JSON parse failed: ${(error as Error).message}. Attempting recovery...`,
      );

      // Attempt 1: Fix unterminated strings by closing them
      let fixed = extracted;
      try {
        // Find the position of the last valid JSON structure
        const lastValidBrace = extracted.lastIndexOf('}');
        if (lastValidBrace > 0) {
          fixed = extracted.substring(0, lastValidBrace + 1);
          return JSON.parse(fixed);
        }
      } catch (recoveryError) {
        this.logger.warn('JSON recovery attempt 1 failed');
      }

      // Attempt 2: Try to extract valid JSON up to the error position
      try {
        const errorMatch = (error as Error).message.match(/position (\d+)/);
        if (errorMatch) {
          const errorPos = parseInt(errorMatch[1], 10);
          // Try to find the last complete object before the error
          const beforeError = extracted.substring(0, errorPos);
          const lastBrace = beforeError.lastIndexOf('}');
          if (lastBrace > 0) {
            fixed = extracted.substring(0, lastBrace + 1);
            return JSON.parse(fixed);
          }
        }
      } catch (recoveryError2) {
        this.logger.warn('JSON recovery attempt 2 failed');
      }

      // If all recovery attempts fail, re-throw the original error
      throw error;
    }
  }

  // --- Dashboard ---

  async getDashboardStats() {
    const client = this.supabase.getServiceClient();

    const { data: posts } = await client
      .from('blog_posts')
      .select('id, status, quality_score, seo_score');

    const total = posts?.length ?? 0;
    const published =
      posts?.filter((p) => p.status === 'published').length ?? 0;
    const draft = posts?.filter((p) => p.status === 'draft').length ?? 0;
    const scheduled =
      posts?.filter((p) => p.status === 'scheduled').length ?? 0;

    const scores = posts?.filter((p) => p.seo_score != null) ?? [];
    const avgSeoScore =
      scores.length > 0
        ? Math.round(
            scores.reduce((s, p) => s + (p.seo_score ?? 0), 0) / scores.length,
          )
        : 0;

    const { count: clustersCount } = await client
      .from('content_clusters')
      .select('*', { count: 'exact', head: true });

    const { count: distributedCount } = await client
      .from('blog_distributions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published');

    const { data: recentPosts } = await client
      .from('blog_posts')
      .select('id, title, slug, status, updated_at, seo_score')
      .order('updated_at', { ascending: false })
      .limit(10);

    return {
      total_articles: total,
      published,
      draft,
      scheduled,
      avg_seo_score: avgSeoScore,
      clusters_count: clustersCount ?? 0,
      distributed_count: distributedCount ?? 0,
      recent_posts: recentPosts ?? [],
    };
  }

  // --- AI Content Generation ---

  async generatePlan(input: GeneratePlanInput): Promise<ContentPlan> {
    this.logger.log(`Generating content plan for: ${input.primary_keyword}`);

    const systemPrompt = `You are an expert SEO content strategist. Given keyword research input, produce a detailed content plan as JSON. The plan must be actionable and optimized for search visibility.

Respond ONLY with valid JSON matching this schema:
{
  "suggested_title": "string — compelling, keyword-rich article title",
  "heading_structure": [{ "level": "h2" | "h3", "text": "heading text" }],
  "recommended_word_count": number,
  "content_angle": "string — the unique angle/perspective for this article",
  "keyword_placement": "string — strategy for placing primary and secondary keywords"
}`;

    const userPrompt = `Create a content plan for the following:
- Primary Keyword: ${input.primary_keyword}
- Secondary Keywords: ${(input.secondary_keywords ?? []).join(', ') || 'none specified'}
- Target Audience: ${input.target_audience}
- Business Type: ${input.business_type ?? 'general'}
- Country: ${input.country ?? 'global'}
- Language: ${input.language ?? 'English'}
- Search Intent: ${input.search_intent ?? 'informational'}
- Competitors: ${(input.competitors ?? []).join(', ') || 'none specified'}
- Target Word Count: ${input.article_length ?? 2500}

Requirements:
1. Title must include the primary keyword naturally
2. Provide 7-12 headings (mix of H2 and H3) that cover the topic comprehensively
3. Include an FAQ section heading
4. The content angle should differentiate from typical results
5. Keyword placement strategy should be specific and actionable`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.7,
        maxTokens: 2000,
        timeoutMs: 30_000,
      });

      const parsed = this.parseAiJson(content);
      return {
        suggested_title:
          parsed.suggested_title || `Guide to ${input.primary_keyword}`,
        heading_structure: Array.isArray(parsed.heading_structure)
          ? parsed.heading_structure
          : [],
        recommended_word_count:
          parsed.recommended_word_count || input.article_length || 2500,
        content_angle: parsed.content_angle || '',
        keyword_placement: parsed.keyword_placement || '',
      };
    } catch (error) {
      this.logger.error(
        `Content plan generation failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to generate content plan: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async generateArticle(
    plan: ContentPlan,
    input: GeneratePlanInput,
  ): Promise<GeneratedArticle> {
    this.logger.log(`Generating article: ${plan.suggested_title}`);

    const headingsOutline = plan.heading_structure
      .map((h) => `${h.level === 'h2' ? '##' : '###'} ${h.text}`)
      .join('\n');

    const systemPrompt = `You are an expert content writer specializing in SEO-optimized long-form articles. Write in an expert, authoritative, human tone — never sound AI-generated. Use varied sentence lengths, rhetorical questions, and natural transitions. Include specific statistics, examples, and actionable advice.

Respond ONLY with valid JSON matching this schema:
{
  "title": "string",
  "slug": "string — URL-friendly slug",
  "subtitle": "string — compelling subtitle",
  "excerpt": "string — 150-200 char summary for previews",
  "body": "string — full article in Markdown format",
  "tags": ["string array — 3-7 relevant tags"],
  "seo_title": "string — 50-60 chars, keyword-rich",
  "seo_description": "string — 150-160 chars meta description",
  "seo_keywords": "string — comma-separated keywords",
  "faq_json": [{ "question": "string", "answer": "string" }],
  "reading_minutes": number,
  "og_image_prompt": "string — DALL-E prompt for the OG image",
  "internal_link_suggestions": ["string array — related topic slugs to link to"]
}`;

    const userPrompt = `Write a complete SEO-optimized article based on this plan:

TITLE: ${plan.suggested_title}
TARGET WORD COUNT: ${plan.recommended_word_count}
CONTENT ANGLE: ${plan.content_angle}
PRIMARY KEYWORD: ${input.primary_keyword}
SECONDARY KEYWORDS: ${(input.secondary_keywords ?? []).join(', ')}
TARGET AUDIENCE: ${input.target_audience}
SEARCH INTENT: ${input.search_intent ?? 'informational'}
KEYWORD PLACEMENT STRATEGY: ${plan.keyword_placement}

HEADING STRUCTURE TO FOLLOW:
${headingsOutline}

REQUIREMENTS:
1. Include the primary keyword in the title, first paragraph, and naturally 3-5 times throughout
2. Write ${plan.recommended_word_count} words minimum
3. Follow the heading structure exactly
4. Include 5-7 FAQ pairs that address real user questions (use "People Also Ask" style)
5. Add specific statistics, data points, and real-world examples
6. Write for ${input.target_audience} — match their expertise level and vocabulary
7. Include a compelling introduction with a hook
8. End with a clear conclusion and call-to-action
9. Use bullet points, numbered lists, and short paragraphs for scannability
10. The body must be in proper Markdown format with ## and ### headings`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.75,
        maxTokens: 8000,
        timeoutMs: 90_000,
      });

      const parsed = this.parseAiJson(content);

      const slug = (parsed.slug || plan.suggested_title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);

      const body = parsed.body || '';
      const wordCount = body.split(/\s+/).length;
      const readingMinutes =
        parsed.reading_minutes || Math.ceil(wordCount / 250);

      return {
        title: parsed.title || plan.suggested_title,
        slug,
        subtitle: parsed.subtitle || '',
        excerpt: parsed.excerpt || '',
        body,
        tags: Array.isArray(parsed.tags)
          ? parsed.tags
          : [input.primary_keyword],
        seo_title: parsed.seo_title || `${plan.suggested_title} | Trndinn`,
        seo_description: parsed.seo_description || '',
        seo_keywords: parsed.seo_keywords || input.primary_keyword,
        faq_json: Array.isArray(parsed.faq_json) ? parsed.faq_json : [],
        reading_minutes: readingMinutes,
        og_image_prompt:
          parsed.og_image_prompt ||
          `Modern illustration of ${input.primary_keyword}`,
        seo_score: 0,
        aeo_score: 0,
        geo_score: 0,
        eeat_score: 0,
        readability_score: 0,
        quality_score: 0,
        internal_link_suggestions: Array.isArray(
          parsed.internal_link_suggestions,
        )
          ? parsed.internal_link_suggestions
          : [],
      };
    } catch (error) {
      this.logger.error(
        `Article generation failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to generate article: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  // --- Clusters ---

  async listClusters() {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('content_clusters')
      .select(
        '*, content_cluster_articles(id, keyword, status, is_pillar, post_id)',
      )
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async getCluster(id: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('content_clusters')
      .select(
        '*, content_cluster_articles(*, blog_posts:post_id(id, title, slug, status))',
      )
      .eq('id', id)
      .single();

    if (error) throw new NotFoundException('Cluster not found');
    return data;
  }

  async createCluster(body: {
    name: string;
    pillar_keyword: string;
    description?: string;
  }) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('content_clusters')
      .insert({
        name: body.name,
        pillar_keyword: body.pillar_keyword,
        description: body.description ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async generateClusterSuggestions(id: string) {
    const cluster = await this.getCluster(id);

    const systemPrompt = `You are an SEO content strategist specializing in topic clusters and internal linking. Given a pillar keyword, suggest supporting articles that form a comprehensive topic cluster.

Respond ONLY with valid JSON matching this schema:
{
  "suggestions": [
    { "keyword": "string — target keyword for supporting article", "title_suggestion": "string — compelling title", "is_pillar": boolean, "sort_order": number }
  ]
}

The first item should be the pillar article (is_pillar: true). The rest are supporting articles (is_pillar: false).`;

    const userPrompt = `Generate a topic cluster for the pillar keyword: "${cluster.pillar_keyword}"
Cluster name: "${cluster.name}"
${cluster.description ? `Description: ${cluster.description}` : ''}

Requirements:
1. First item is the pillar article (comprehensive, 3000+ word guide)
2. Suggest 7-9 supporting articles that cover subtopics, use cases, comparisons, and how-tos
3. Each supporting keyword should be a long-tail variation or closely related subtopic
4. Titles should be compelling and click-worthy
5. Together they should cover the topic from every relevant angle`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.8,
        maxTokens: 2000,
        timeoutMs: 30_000,
      });

      const parsed = this.parseAiJson(content);
      const suggestions: {
        keyword: string;
        title_suggestion: string;
        is_pillar: boolean;
        sort_order: number;
      }[] = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.map((s: any, i: number) => ({
            keyword: s.keyword || cluster.pillar_keyword,
            title_suggestion: s.title_suggestion || s.keyword || '',
            is_pillar: s.is_pillar === true,
            sort_order: s.sort_order ?? i,
          }))
        : [];

      if (suggestions.length === 0) {
        throw new Error('AI returned no suggestions');
      }

      const client = this.supabase.getServiceClient();
      const { data, error } = await client
        .from('content_cluster_articles')
        .insert(suggestions.map((s) => ({ ...s, cluster_id: id })))
        .select();

      if (error) throw error;
      return data;
    } catch (error) {
      this.logger.error(
        `Cluster suggestion generation failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to generate cluster suggestions: ${error instanceof AiGatewayError ? error.message : (error as Error).message}`,
      );
    }
  }

  // --- Distributions ---

  async getDistributions(postId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('blog_distributions')
      .select('*')
      .eq('post_id', postId)
      .order('platform');

    if (error) throw error;
    return data ?? [];
  }

  async generateDistribution(postId: string, platform: string) {
    const client = this.supabase.getServiceClient();

    // Get the post content with slug for image naming
    const { data: post } = await client
      .from('blog_posts')
      .select('title, excerpt, body, tags, slug, content_category')
      .eq('id', postId)
      .single();

    if (!post) throw new NotFoundException('Post not found');

    // Generate platform-adapted content with enhanced prompts
    const adaptedResult = await this.adaptContentForPlatformEnhanced(post, platform);
    
    // Determine if this platform is manual-only
    const isManual = this.platformPublishers.isManualOnly(platform);

    // Generate cover image if platform uses images
    let coverImageUrl: string | undefined;
    const inlineImages: { position: number; url: string; alt: string; style: string }[] = [];
    
    if (platformUsesImages(platform) && this.minioService) {
      // Generate cover image
      try {
        const imageBuffer = await generatePlatformCoverImage({
          title: adaptedResult.platformTitle || post.title,
          platform,
          category: post.content_category || (post.tags?.[0] ?? undefined),
          excerpt: post.excerpt ?? undefined,
          hashtags: adaptedResult.hashtags,
        });

        const objectName = `blog/distribution/${post.slug || postId}/${platform}-cover-${Date.now()}.png`;
        await this.minioService.uploadFile(
          'contentos-media',
          objectName,
          imageBuffer,
          'image/png',
        );
        coverImageUrl = await this.minioService.getPublicUrl('contentos-media', objectName);
        this.logger.log(`Generated cover image for ${platform}: ${coverImageUrl}`);
      } catch (imgError) {
        this.logger.warn(`Failed to generate cover image for ${platform}: ${(imgError as Error).message}`);
      }

      // Generate inline images for long-form platforms
      if (this.isLongFormPlatform(platform)) {
        try {
          const generatedInlineImages = await this.generateInlineImagesForContent(
            adaptedResult.content,
            platform,
            post.slug || postId,
          );
          inlineImages.push(...generatedInlineImages);
          this.logger.log(`Generated ${inlineImages.length} inline images for ${platform}`);
        } catch (inlineError) {
          this.logger.warn(`Failed to generate inline images for ${platform}: ${(inlineError as Error).message}`);
        }
      }
    }

    // Insert inline images into the adapted content
    let finalContent = adaptedResult.content;
    
    // Special processing for LinkedIn articles: process image placeholders and strip markdown
    if (platform === 'linkedin_article') {
      finalContent = await this.processLinkedInArticleContent(finalContent, postId);
    } else if (inlineImages.length > 0) {
      finalContent = this.insertInlineImagesIntoContent(adaptedResult.content, inlineImages);
    }

    // CRITICAL: Enforce hard character limits as the FINAL step
    // This ensures content never exceeds platform limits regardless of generation
    finalContent = this.enforceCharacterLimit(finalContent, platform);

    // Calculate character count (after enforcement)
    const characterCount = finalContent.length;

    // Calculate simple engagement score based on content quality signals
    const engagementScore = this.calculateEngagementScore(finalContent, platform);

    const { data, error } = await client
      .from('blog_distributions')
      .upsert(
        {
          post_id: postId,
          platform,
          status: 'ready',
          adapted_content: finalContent,
          platform_title: adaptedResult.platformTitle,
          cover_image_url: coverImageUrl,
          inline_images: inlineImages,
          hashtags: adaptedResult.hashtags,
          character_count: characterCount,
          seo_score: adaptedResult.seoScore,
          engagement_score: engagementScore,
          is_manual: isManual,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'post_id,platform' },
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Generate diverse inline images for article content using AI-driven decisions
   */
  private async generateInlineImagesForContent(
    content: string,
    platform: string,
    slugOrId: string,
  ): Promise<{ position: number; url: string; alt: string; style: string }[]> {
    const images: { position: number; url: string; alt: string; style: string }[] = [];
    
    if (!this.minioService) return images;

    // Split content into sections by headings
    const sections = content.split(/(?=^##\s)/m).filter(s => s.trim());
    
    // Select candidate sections for inline images (not all sections)
    const candidateIndices = this.selectSectionsForImages(sections);
    
    // Process each candidate section with AI decision
    for (let i = 0; i < candidateIndices.length && images.length < 3; i++) {
      const sectionIndex = candidateIndices[i];
      const section = sections[sectionIndex];
      if (!section) continue;

      // Extract section title
      const titleMatch = section.match(/^##\s*(.+)$/m);
      const sectionTitle = titleMatch ? titleMatch[1].trim() : `Section ${sectionIndex + 1}`;
      
      // Quick check: skip sections that typically don't need images
      if (shouldSkipImageForSection(sectionTitle)) {
        this.logger.debug(`[${platform}] Skipping image for section "${sectionTitle}" - matches skip pattern`);
        continue;
      }
      
      // Use AI to decide if and what image to generate
      let decision: AIImageDecision;
      try {
        decision = await this.getAIImageDecision(sectionTitle, section);
      } catch (err) {
        this.logger.warn(`[${platform}] AI image decision failed for "${sectionTitle}": ${(err as Error).message}`);
        continue;
      }
      
      if (!decision.shouldGenerateImage) {
        this.logger.debug(`[${platform}] AI decided no image for "${sectionTitle}": ${decision.reason}`);
        continue;
      }
      
      // Validate and sanitize the data
      const validatedData = validateImageData(decision.style!, decision.data);
      
      try {
        const imageBuffer = await generateInlineImage({
          title: decision.title || sectionTitle,
          style: decision.style!,
          platform,
          data: validatedData,
          sectionNumber: sectionIndex + 1,
        });

        const objectName = `blog/distribution/${slugOrId}/${platform}-inline-${images.length + 1}-${Date.now()}.png`;
        await this.minioService.uploadFile(
          'contentos-media',
          objectName,
          imageBuffer,
          'image/png',
        );
        const imageUrl = await this.minioService.getPublicUrl('contentos-media', objectName);

        // Calculate position (character index after the section heading)
        let position = 0;
        for (let j = 0; j <= sectionIndex; j++) {
          position += sections[j]?.length || 0;
        }
        // Position after the first paragraph of the section
        const firstParagraphEnd = section.indexOf('\n\n', section.indexOf('\n') + 1);
        if (firstParagraphEnd > 0) {
          position = position - section.length + firstParagraphEnd;
        }

        images.push({
          position,
          url: imageUrl,
          alt: `${decision.style!.charAt(0).toUpperCase() + decision.style!.slice(1)}: ${decision.title || sectionTitle}`,
          style: decision.style!,
        });
        
        this.logger.log(`[${platform}] Generated ${decision.style} image for "${sectionTitle}": ${decision.reason}`);
      } catch (err) {
        this.logger.warn(`Failed to generate inline image for section "${sectionTitle}": ${(err as Error).message}`);
      }
    }

    return images;
  }

  /**
   * Use AI to decide if and what image to generate for a section
   */
  private async getAIImageDecision(sectionTitle: string, sectionContent: string): Promise<AIImageDecision> {
    const prompt = buildImageDecisionPrompt(sectionTitle, sectionContent);
    
    try {
      const { content: aiResponse } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert at analyzing content and deciding what visual images would add value. Respond with JSON only.' 
          },
          { role: 'user', content: prompt },
        ],
        jsonObject: true,
        category: 'text',
        maxTokens: 500,
      });
      
      return parseImageDecisionResponse(aiResponse);
    } catch (err) {
      this.logger.warn(`AI image decision call failed: ${(err as Error).message}`);
      return { shouldGenerateImage: false, reason: 'AI call failed' };
    }
  }

  /**
   * Select candidate sections for inline images (AI will filter further)
   * Returns more candidates than needed since AI will decide which actually get images
   */
  private selectSectionsForImages(sections: string[]): number[] {
    if (sections.length <= 2) return [];
    if (sections.length <= 4) return [1, 2]; // Give AI 2 candidates
    if (sections.length <= 6) return [1, 2, 3, 4]; // Give AI 4 candidates
    
    // For longer articles, pick candidates spread throughout (skip first and last)
    const candidates: number[] = [];
    const step = Math.floor((sections.length - 2) / 5); // Aim for ~5 candidates
    for (let i = 1; i < sections.length - 1 && candidates.length < 6; i += Math.max(1, step)) {
      candidates.push(i);
    }
    return candidates;
  }

  /**
   * Insert inline images into content at appropriate positions
   */
  private insertInlineImagesIntoContent(
    content: string,
    images: { position: number; url: string; alt: string; style: string }[],
  ): string {
    if (images.length === 0) return content;

    // Sort images by position descending so we can insert from end to start
    const sortedImages = [...images].sort((a, b) => b.position - a.position);
    
    let result = content;
    for (const img of sortedImages) {
      // Find a good insertion point (after a paragraph break)
      let insertPos = img.position;
      
      // Look for the next paragraph break after the position
      const nextBreak = result.indexOf('\n\n', insertPos);
      if (nextBreak !== -1 && nextBreak - insertPos < 500) {
        insertPos = nextBreak + 2;
      }
      
      // Create markdown image with alt text
      const imageMarkdown = `\n\n![${img.alt}](${img.url})\n\n`;
      
      result = result.slice(0, insertPos) + imageMarkdown + result.slice(insertPos);
    }

    return result;
  }

  private calculateEngagementScore(content: string, platform: string): number {
    let score = 50;

    // Check for engagement elements
    const hasQuestion = /\?/.test(content);
    const hasHashtags = /#\w+/.test(content);
    const hasCTA = /\b(comment|share|follow|subscribe|click|read more|learn more|check out)\b/i.test(content);
    const hasEmoji = /[\u{1F300}-\u{1F9FF}]/u.test(content);
    const hasNumbers = /\d+%|\d+x|\$\d+|\d+ (tips|ways|steps|reasons)/i.test(content);
    const hasHook = content.split('\n')[0]?.length < 150;

    if (hasQuestion) score += 10;
    if (hasHashtags) score += 8;
    if (hasCTA) score += 12;
    if (hasNumbers) score += 10;
    if (hasHook) score += 10;

    // Platform-specific adjustments
    if (platform === 'linkedin_post' || platform === 'linkedin_article') {
      if (hasEmoji) score -= 5;
    }
    if (platform === 'twitter_thread') {
      if (hasEmoji) score += 5;
    }
    if (platform === 'reddit' || platform === 'hackernews') {
      if (hasCTA) score -= 10;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Returns true when content appears to be cut off mid-sentence or is incomplete.
   * Enhanced heuristics:
   * 1. Last character check (original)
   * 2. Incomplete markdown structures (unclosed code blocks, lists)
   * 3. Ends with common truncation patterns
   */
  private isContentTruncated(content: string): boolean {
    const trimmed = content.trimEnd();
    if (!trimmed) return false;

    // Check for incomplete markdown code blocks
    const codeBlockOpens = (trimmed.match(/```/g) || []).length;
    if (codeBlockOpens % 2 !== 0) return true;

    // Check for common truncation patterns (mid-word, mid-sentence indicators)
    const truncationPatterns = [
      /\s+t$/i, // ends with " t" (common truncation)
      /\s+th$/i, // ends with " th"
      /\s+the$/i, // ends with " the"
      /\s+a$/i, // ends with " a"
      /\s+an$/i, // ends with " an"
      /\s+and$/i, // ends with " and"
      /\s+or$/i, // ends with " or"
      /\s+to$/i, // ends with " to"
      /\s+in$/i, // ends with " in"
      /\s+of$/i, // ends with " of"
      /\s+for$/i, // ends with " for"
      /\s+with$/i, // ends with " with"
      /\s+is$/i, // ends with " is"
      /\s+are$/i, // ends with " are"
      /\s+was$/i, // ends with " was"
      /\s+be$/i, // ends with " be"
      /\s+that$/i, // ends with " that"
      /\s+this$/i, // ends with " this"
      /\s+which$/i, // ends with " which"
      /\s+can$/i, // ends with " can"
      /\s+will$/i, // ends with " will"
      /[,;:]\s*$/, // ends with comma, semicolon, or colon
      /\s+-\s*$/, // ends with " - " (incomplete list item)
    ];

    for (const pattern of truncationPatterns) {
      if (pattern.test(trimmed)) return true;
    }

    const lastChar = trimmed[trimmed.length - 1];
    const sentenceEnders = new Set(['.', '!', '?', ')', ']', '"', "'", '`', '-', '*', '_']);
    // Also accept markdown HR (---) and code-fence close (```)
    if (trimmed.endsWith('---') || trimmed.endsWith('```')) return false;
    return !sentenceEnders.has(lastChar);
  }

  /**
   * Check if generated content meets minimum length requirements.
   * Returns true if content is too short and needs regeneration.
   */
  private isContentTooShort(content: string, minExpectedLength: number): boolean {
    const actualLength = content.length;
    // Allow 30% tolerance below minimum (some adaptation may legitimately be shorter)
    const threshold = Math.floor(minExpectedLength * 0.7);
    return actualLength < threshold;
  }

  /**
   * Long-form platforms need considerably more output tokens.
   * Increased to 16000 for long-form to ensure full article generation.
   * Short-form platforms (twitter threads, linkedin posts, etc.) are fine with fewer.
   */
  private getMaxTokensForPlatform(platform: string): number {
    const longFormPlatforms = new Set([
      'devto',
      'medium',
      'hashnode',
      'beehiiv',
      'ghost',
      'blogger',
      'telegraph',
      'hackernoon',
      'linkedin_article',
      'newsletter',
      'substack',
    ]);
    // 16000 tokens ≈ 12000 words output capacity for long-form
    return longFormPlatforms.has(platform) ? 16000 : 4500;
  }

  private isLongFormPlatform(platform: string): boolean {
    return this.getMaxTokensForPlatform(platform) >= 8000;
  }

  /**
   * Split a large article body into logical sections of up to maxChars each.
   * Prefers splitting on ## headings, then paragraph breaks (\n\n), then hard-cuts.
   */
  private splitIntoSections(body: string, maxChars = 6000): string[] {
    if (body.length <= maxChars) return [body];

    const sections: string[] = [];
    // Try to split on H2 headings first
    const h2Parts = body.split(/(?=^## )/m);
    let current = '';
    for (const part of h2Parts) {
      if ((current + part).length <= maxChars) {
        current += part;
      } else {
        if (current.trim()) sections.push(current.trim());
        // Part itself might exceed maxChars — split on paragraph breaks
        if (part.length <= maxChars) {
          current = part;
        } else {
          const paragraphs = part.split(/\n\n+/);
          current = '';
          for (const para of paragraphs) {
            if ((current + '\n\n' + para).length <= maxChars) {
              current = current ? current + '\n\n' + para : para;
            } else {
              if (current.trim()) sections.push(current.trim());
              // Paragraph itself may exceed limit — hard-cut at word boundary
              if (para.length <= maxChars) {
                current = para;
              } else {
                let remaining = para;
                while (remaining.length > maxChars) {
                  const cutAt = remaining.lastIndexOf(' ', maxChars);
                  const boundary = cutAt > maxChars * 0.5 ? cutAt : maxChars;
                  sections.push(remaining.slice(0, boundary).trim());
                  remaining = remaining.slice(boundary).trim();
                }
                current = remaining;
              }
            }
          }
        }
      }
    }
    if (current.trim()) sections.push(current.trim());
    return sections.filter((s) => s.length > 0);
  }

  /**
   * For large articles, process section batches sequentially and merge results.
   * Returns a synthesised platform-native content string.
   */
  private async processBatchedContent(
    post: {
      title: string;
      excerpt: string | null;
      body: string | null;
      tags: string[] | null;
      content_category?: string | null;
    },
    platform: string,
    sections: string[],
    systemPrompt: string,
  ): Promise<{ content: string; platformTitle?: string; hashtags: string[]; seoScore: number }> {
    const title = post.title;
    const tags = post.tags ?? [];
    const maxTokens = this.getMaxTokensForPlatform(platform);
    const totalSections = sections.length;

    this.logger.log(
      `[distribution] Batching ${totalSections} sections for ${platform} (total body chars: ${(post.body ?? '').length})`,
    );

    const sectionResults: string[] = [];
    let platformTitle: string | undefined;
    let hashtags: string[] = [];
    let seoScore = 70;

    // Calculate expected section length - be more aggressive about minimum output
    const totalBodyLength = (post.body ?? '').length;
    const avgSectionLength = Math.floor(totalBodyLength / totalSections);
    // Require at least 90% of input section length as output (increased from 85%)
    const minSectionOutput = Math.max(Math.floor(avgSectionLength * 0.9), 3000);

    for (let i = 0; i < totalSections; i++) {
      const section = sections[i];
      const isFirst = i === 0;
      const isLast = i === totalSections - 1;

      // Calculate section-specific minimum based on actual section length
      const sectionMinOutput = Math.max(Math.floor(section.length * 0.9), 2500);

      const batchPrompt = isFirst
        ? `Adapt this article section for ${platform}.

=== ARTICLE METADATA ===
ORIGINAL TITLE: ${title}
CATEGORY: ${post.content_category || 'General'}
TAGS: ${tags.join(', ')}
TOTAL SECTIONS: ${totalSections} (processing section 1 of ${totalSections})

=== LENGTH REQUIREMENTS ===
⚠️ INPUT SECTION LENGTH: ${section.length.toLocaleString()} characters
⚠️ MINIMUM OUTPUT REQUIRED: ${sectionMinOutput.toLocaleString()} characters
⚠️ DO NOT SUMMARIZE — adapt ALL content with FULL details

=== CONTENT SECTION ${i + 1}/${totalSections} ===
${section}

=== INSTRUCTIONS ===
- Adapt the FULL content of this section — include ALL details, examples, statistics, and key points
- Your output MUST be at least ${sectionMinOutput.toLocaleString()} characters
- Add platform-specific formatting (Dev.to frontmatter for first section, etc.)
- Complete every sentence — never end mid-word
${isLast ? '- This is the FINAL section. Write a strong conclusion with CTA.' : '- More sections follow. Write the opening/introduction. Do NOT write a conclusion yet.'}

Output JSON:
{
  "content": "The FULL adapted content for this section (${sectionMinOutput.toLocaleString()}+ chars)",
  "platformTitle": "Platform-optimized title",
  "hashtags": ["tag1", "tag2", "tag3", "tag4"],
  "seoScore": 75
}`
        : `Continue adapting the same article for ${platform}.

=== LENGTH REQUIREMENTS ===
⚠️ INPUT SECTION LENGTH: ${section.length.toLocaleString()} characters
⚠️ MINIMUM OUTPUT REQUIRED: ${sectionMinOutput.toLocaleString()} characters
⚠️ DO NOT SUMMARIZE — adapt ALL content with FULL details

=== CONTENT SECTION ${i + 1}/${totalSections} ===
${section}

=== INSTRUCTIONS ===
- Adapt the FULL content of this section — include ALL details, examples, statistics, and key points
- Your output MUST be at least ${sectionMinOutput.toLocaleString()} characters
- If this section has comparison tables, include them fully formatted
- If this section has FAQs, include ALL questions and answers
- Complete every sentence — never end mid-word
${isLast ? '- This is the FINAL section. Write a strong conclusion with CTA.' : '- More sections follow. Do NOT write a conclusion yet.'}

Output JSON:
{
  "content": "The FULL adapted content for this section (${sectionMinOutput.toLocaleString()}+ chars, continuation, no title repeat)",
  "platformTitle": null,
  "hashtags": [],
  "seoScore": 0
}`;

      const { content: aiResponse } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: batchPrompt },
        ],
        category: 'seo_generation',
        temperature: 0.75,
        maxTokens,
        timeoutMs: 180_000, // Increased timeout for longer sections
      });

      let sectionContent = '';
      let parsedOk = false;
      try {
        const cleaned = this.extractJsonFromAiResponse(aiResponse);
        const parsed = JSON.parse(cleaned);
        if (typeof parsed.content === 'string' && parsed.content.trim()) {
          sectionContent = parsed.content;
          parsedOk = true;
        } else {
          this.logger.warn(
            `[distribution] Batch ${i + 1}/${totalSections} parsed JSON missing content field for ${platform}; raw response withheld`,
          );
        }
        if (isFirst) {
          platformTitle = parsed.platformTitle ?? undefined;
          hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];
          seoScore = typeof parsed.seoScore === 'number' ? parsed.seoScore : 70;
        }
      } catch {
        this.logger.warn(
          `[distribution] Batch ${i + 1}/${totalSections} JSON parse failed for ${platform}; section content will be empty`,
        );
      }

      // Check for truncation OR content being too short
      const isTruncated = this.isContentTruncated(sectionContent);
      const isTooShort = sectionContent.length < sectionMinOutput * 0.7; // 70% threshold

      if (isTruncated || isTooShort) {
        const reason = isTruncated ? 'truncated' : `too short (${sectionContent.length} chars vs ${sectionMinOutput} min)`;
        this.logger.warn(`[distribution] Batch ${i + 1} ${reason} for ${platform}; retrying continuation`);
        try {
          const continuationPrompt = isTruncated
            ? 'The previous response was cut off mid-sentence. Continue from EXACTLY where it stopped and complete ALL remaining content, then close the JSON properly. Do not restart.'
            : `The previous response was too short (${sectionContent.length} chars). The section needs at least ${sectionMinOutput} chars. Please regenerate with FULL details — include ALL examples, statistics, and explanations from the original. Do NOT summarize.`;

          const { content: cont } = await this.aiGateway.chatCompletionRaw({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: batchPrompt },
              { role: 'assistant', content: aiResponse },
              {
                role: 'user',
                content: continuationPrompt,
              },
            ],
            category: 'seo_generation',
            temperature: 0.75,
            maxTokens: Math.round(maxTokens * 0.75), // More tokens for continuation
            timeoutMs: 90_000,
          });

          if (isTruncated) {
            // For truncation, try to merge
            const mergedRaw = aiResponse + cont;
            try {
              const mc = this.extractJsonFromAiResponse(mergedRaw);
              const mp = JSON.parse(mc);
              if (typeof mp.content === 'string' && mp.content.trim()) sectionContent = mp.content;
            } catch {
              if (!parsedOk) {
                try {
                  const cc = this.extractJsonFromAiResponse(cont);
                  const cp = JSON.parse(cc);
                  if (typeof cp.content === 'string' && cp.content.trim() && !this.isContentTruncated(cp.content)) sectionContent = cp.content;
                } catch { /* keep existing */ }
              }
            }
          } else {
            // For too-short content, try to use the new response if it's longer
            try {
              const cc = this.extractJsonFromAiResponse(cont);
              const cp = JSON.parse(cc);
              if (typeof cp.content === 'string' && cp.content.trim() && cp.content.length > sectionContent.length) {
                sectionContent = cp.content;
                this.logger.log(`[distribution] Batch ${i + 1} retry produced longer content: ${sectionContent.length} chars`);
              }
            } catch { /* keep existing */ }
          }
        } catch (retryErr) {
          this.logger.warn(`[distribution] Batch ${i + 1} continuation failed: ${(retryErr as Error).message}`);
        }
      }

      // Log section output length for debugging
      this.logger.log(
        `[distribution] Batch ${i + 1}/${totalSections} for ${platform}: input=${section.length} chars, output=${sectionContent.length} chars`,
      );

      sectionResults.push(sectionContent.trim());
    }

    // Merge all sections with a blank line separator
    const mergedContent = sectionResults.join('\n\n');

    // Log final merged content length
    this.logger.log(
      `[distribution] Merged ${totalSections} sections for ${platform}: total output=${mergedContent.length} chars (original body=${totalBodyLength} chars)`,
    );

    // Sanitize hashtags for platform requirements
    const sanitizedHashtags = this.sanitizeHashtagsForPlatform(hashtags, platform);

    return { content: mergedContent, platformTitle, hashtags: sanitizedHashtags, seoScore };
  }

  private async adaptContentForPlatformEnhanced(
    post: {
      title: string;
      excerpt: string | null;
      body: string | null;
      tags: string[] | null;
      content_category?: string | null;
    },
    platform: string,
  ): Promise<{
    content: string;
    platformTitle?: string;
    hashtags: string[];
    seoScore: number;
  }> {
    const title = post.title;
    const excerpt = post.excerpt ?? '';
    const body = post.body ?? excerpt;
    const tags = post.tags ?? [];

    const platformRules = this.getEnhancedPlatformRules(platform);
    const originalLength = body.length;
    const minExpectedLength = Math.max(
      Math.floor(originalLength * 0.85),
      this.isLongFormPlatform(platform) ? 8000 : 2000,
    );
    const maxTokens = this.getMaxTokensForPlatform(platform);
    const charLimit = this.getPlatformCharacterLimit(platform) || 15000;

    // CRITICAL FIX: Generate content as PLAIN MARKDOWN (not JSON) to avoid truncation
    // JSON output causes AI to truncate content inside the "content" field
    const contentSystemPrompt = `You are an expert content strategist adapting articles for ${platform}.

OUTPUT FORMAT: Raw markdown ONLY. Do NOT wrap in JSON. Do NOT use code blocks around the entire output.

CRITICAL CHARACTER LIMIT: ${charLimit.toLocaleString()} characters maximum for ${platform}.
This is a HARD LIMIT. Content will be truncated if it exceeds this.

CRITICAL ANTI-REPETITION RULES:
1. NEVER repeat a section heading or topic
2. Each idea, statistic, or example appears EXACTLY ONCE
3. If you've already covered a point, do NOT mention it again
4. Check your output before finishing - remove any duplicates

QUALITY OVER QUANTITY:
- Concise, valuable content beats long, repetitive content
- Every paragraph should add new information
- Cut fluff and filler phrases
- Stay WELL UNDER the character limit

Platform rules:
${platformRules}

SEO Guidelines:
- Proper heading hierarchy (H2 > H3)
- Keywords in headings and first paragraph
- Demonstrate expertise and authority

URL RESTRICTIONS (CRITICAL - violations cause publish failures):
- DO NOT include YouTube URLs or embeds (youtube.com, youtu.be)
- DO NOT use placeholder/dummy URLs (example.com, yoursite.com, placeholder.com, test.com, foo.com, bar.com)
- DO NOT invent fake URLs — only include real, verifiable links
- DO NOT use platform-specific embed tags ({% youtube %}, {% embed %}, etc.) unless the platform explicitly supports them
- If referencing external content, describe it in text rather than embedding
- INTERNAL LINKS: Always use full absolute URLs for Trndinn links (e.g., https://trndinn.com/features, https://trndinn.com/pricing, https://trndinn.com/auth) — NEVER use relative paths like /features or /pricing as they won't work on external platforms`;

    const contentUserPrompt = `Adapt this article for ${platform}.

OUTPUT: Raw markdown only - NO JSON wrapper, NO code blocks around the output.

ORIGINAL TITLE: ${title}
CATEGORY: ${post.content_category || 'General'}

CHARACTER LIMIT: ${charLimit.toLocaleString()} characters maximum. Quality over quantity.

=== ORIGINAL CONTENT (CONDENSE AND ADAPT - DO NOT REPEAT SECTIONS) ===
${body}

=== REQUIREMENTS ===
- Adapt the content for ${platform} audience and format
- Each section/topic appears ONCE only - no repetition
- STAY UNDER ${charLimit.toLocaleString()} characters - be concise
- Complete every sentence - never end mid-word
- Follow the platform-specific formatting rules`;

    try {
      // STEP 1: Generate content as plain markdown (not JSON)
      let generatedContent = '';

      if (body.length > 8000) {
        // For long articles, generate iteratively by sections
        generatedContent = await this.generateContentIteratively(
          contentSystemPrompt,
          body,
          title,
          platform,
          post.content_category,
          minExpectedLength,
          maxTokens,
        );
      } else {
        // Single-pass for shorter articles
        const { content: rawContent } = await this.aiGateway.chatCompletionRaw({
          messages: [
            { role: 'system', content: contentSystemPrompt },
            { role: 'user', content: contentUserPrompt },
          ],
          category: 'seo_generation',
          temperature: 0.7,
          maxTokens,
          timeoutMs: 180_000,
        });

        generatedContent = this.cleanMarkdownOutput(rawContent);

        // Continue only if truncated (cut off mid-sentence)
        if (this.isContentTruncated(generatedContent)) {
          this.logger.warn(`[${platform}] Content truncated (${generatedContent.length} chars). Continuing...`);
          generatedContent = await this.continueMarkdownGeneration(
            contentSystemPrompt,
            generatedContent,
            body,
            minExpectedLength,
            maxTokens,
          );
        }
        
        // Apply universal deduplication
        generatedContent = this.deduplicateContent(generatedContent, platform);
      }

      // STEP 2: Generate metadata separately (quick call, small output)
      const { platformTitle, hashtags, seoScore } = await this.generateContentMetadata(
        title,
        generatedContent,
        tags,
        platform,
      );

      this.logger.log(`[${platform}] Generated ${generatedContent.length} chars`);

      // Post-process: convert any relative URLs to absolute
      generatedContent = this.convertRelativeUrlsToAbsolute(generatedContent);

      // Post-process: strip markdown syntax for LinkedIn posts (short-form only)
      if (platform === 'linkedin_post') {
        generatedContent = this.stripMarkdownForLinkedIn(generatedContent);
      }

      // Post-process: strip markdown syntax for Medium (WYSIWYG editor doesn't render markdown)
      if (platform === 'medium') {
        generatedContent = this.stripMarkdownForMedium(generatedContent);
      }

      return { content: generatedContent, platformTitle, hashtags, seoScore };
    } catch (error) {
      this.logger.error(`[${platform}] Adaptation failed: ${(error as Error).message}`);
      const fallbackHashtags = this.sanitizeHashtagsForPlatform(
        tags.slice(0, 5).map((t) => t.replace(/\s+/g, '')),
        platform
      );
      return {
        content: this.convertRelativeUrlsToAbsolute(this.fallbackAdaptContent(post, platform)),
        hashtags: fallbackHashtags,
        seoScore: 50,
      };
    }
  }

  /**
   * Clean markdown output - remove JSON wrappers if AI added them despite instructions
   */
  private cleanMarkdownOutput(raw: string): string {
    let content = raw.trim();

    // Remove markdown code block wrapper
    if (content.startsWith('```markdown') || content.startsWith('```md')) {
      content = content.replace(/^```(?:markdown|md)\n?/, '').replace(/\n?```$/, '');
    } else if (content.startsWith('```') && !content.startsWith('```json')) {
      content = content.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    // If AI wrapped in JSON despite instructions, extract content field
    if (content.startsWith('{') && content.includes('"content"')) {
      try {
        const cleaned = this.extractJsonFromAiResponse(content);
        const parsed = JSON.parse(cleaned);
        if (parsed.content && typeof parsed.content === 'string') {
          content = parsed.content;
        }
      } catch {
        // Not valid JSON, use as-is
      }
    }

    return content.trim();
  }

  /**
   * Convert relative URLs (e.g., /auth, /pricing) to absolute URLs with trndinn.com domain.
   * This ensures links work as proper backlinks when published on external platforms.
   */
  private convertRelativeUrlsToAbsolute(content: string): string {
    const baseUrl = 'https://trndinn.com';

    // Match markdown links with relative paths: [text](/path)
    content = content.replace(
      /\[([^\]]*)\]\(\/([\w\-\/\?\#\&\=\.]+)\)/g,
      (_, text, path) => `[${text}](${baseUrl}/${path})`,
    );

    // Match bare href-style relative URLs in any remaining HTML: href="/path"
    content = content.replace(
      /href=["']\/([\w\-\/\?\#\&\=\.]+)["']/g,
      (_, path) => `href="${baseUrl}/${path}"`,
    );

    // Match plain relative URLs that appear after parentheses or standalone: (e.g., (/features))
    content = content.replace(
      /\(\/([\w\-\/]+)\)/g,
      (_, path) => `(${baseUrl}/${path})`,
    );

    return content;
  }

  /**
   * Clean content for LinkedIn — remove markdown syntax but PRESERVE structure.
   * LinkedIn's article editor does NOT render markdown — it shows raw symbols.
   * The editor has its own toolbar for formatting (B, I, lists, headings).
   * 
   * PRESERVES:
   * - ALL-CAPS section headings
   * - Em-dash dividers (———)
   * - Bullet points (•)
   * - [IMAGE: ...] placeholders (converted to clear format)
   * 
   * REMOVES:
   * - Markdown heading markers (#, ##, etc.)
   * - Bold/italic markers (**, *, __, _)
   * - Markdown image syntax ![](...)
   * - Code blocks and backticks
   */
  private stripMarkdownForLinkedIn(content: string): string {
    // Remove markdown image syntax: ![alt](url) → just remove entirely (images are added separately)
    content = content.replace(/!\[[^\]]*\]\([^)]+\)/g, '');

    // Remove heading markers: # Heading → Heading (but preserve the text)
    content = content.replace(/^#{1,6}\s+/gm, '');

    // Remove bold markers: **text** → text
    content = content.replace(/\*\*([^*]+)\*\*/g, '$1');
    content = content.replace(/__([^_]+)__/g, '$1');

    // Remove italic markers: *text* → text (but not bullet points)
    content = content.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1');
    content = content.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1');

    // Convert markdown links [text](url) → text (url)
    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Convert markdown bullet points to clean bullets (preserve existing • bullets)
    content = content.replace(/^[-*]\s+/gm, '• ');

    // Remove code backticks
    content = content.replace(/`([^`]+)`/g, '$1');

    // Remove code blocks
    content = content.replace(/```[\s\S]*?```/g, '');

    // PRESERVE em-dash dividers (———) - don't remove them
    // Convert markdown horizontal rules (---, ***, ___) to em-dash dividers
    content = content.replace(/^[-*_]{3,}\s*$/gm, '———');

    // Collapse excessive blank lines (more than 2) to max 2
    content = content.replace(/\n{3,}/g, '\n\n');

    // Clean up any double spaces
    content = content.replace(/  +/g, ' ');

    return content.trim();
  }

  /**
   * Strip markdown syntax from Medium content for clean copy/paste.
   * Medium's editor is WYSIWYG and does NOT render markdown when pasting.
   * 
   * PRESERVES:
   * - Em-dash dividers (———)
   * - Bullet points (•)
   * - Plain text structure
   * 
   * CONVERTS:
   * - Headers to plain text with spacing
   * - Images to [Image: alt] with URL on next line
   * - Links to text (url) format
   * 
   * REMOVES:
   * - Markdown heading markers (#, ##, etc.)
   * - Bold/italic markers (**, *, __, _)
   * - Code blocks and backticks
   */
  private stripMarkdownForMedium(content: string): string {
    // Convert headers to plain text with line breaks for visual separation
    // ## Header -> \nHeader\n (preserves structure without markdown)
    content = content.replace(/^#{1,6}\s+(.+)$/gm, '\n$1\n');

    // Remove bold markers: **text** → text
    content = content.replace(/\*\*([^*]+)\*\*/g, '$1');
    content = content.replace(/__([^_]+)__/g, '$1');

    // Remove italic markers: *text* → text (but not bullet points)
    content = content.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1');
    content = content.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1');

    // Convert markdown images to readable format with URL
    // ![alt](url) → \n[Image: alt]\nurl\n
    content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '\n[Image: $1]\n$2\n');

    // Convert markdown links [text](url) → text (url)
    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Convert markdown bullet points to clean bullets
    content = content.replace(/^[-*]\s+/gm, '• ');

    // Remove code backticks
    content = content.replace(/`([^`]+)`/g, '$1');

    // Remove code blocks entirely (Medium doesn't support code well anyway)
    content = content.replace(/```[\s\S]*?```/g, '');

    // Convert markdown horizontal rules (---, ***, ___) to em-dash dividers
    content = content.replace(/^[-*_]{3,}\s*$/gm, '\n———\n');

    // Collapse excessive blank lines (more than 2) to max 2
    content = content.replace(/\n{3,}/g, '\n\n');

    // Clean up any double spaces
    content = content.replace(/  +/g, ' ');

    return content.trim();
  }

  /**
   * Process LinkedIn article content: strip markdown, generate inline images,
   * deduplicate sections, and consolidate hashtags.
   * This is called specifically for linkedin_article platform after content generation.
   */
  private async processLinkedInArticleContent(
    content: string,
    postId: string,
  ): Promise<string> {
    // First, strip markdown while preserving structure
    let processedContent = this.stripMarkdownForLinkedIn(content);

    // Deduplicate repeated sections (detect ALL-CAPS headings that appear multiple times)
    processedContent = this.deduplicateLinkedInSections(processedContent);

    // Consolidate all hashtags to the very end
    processedContent = this.consolidateHashtagsToEnd(processedContent);

    // Find all [IMAGE: ...] placeholders
    const imagePlaceholderRegex = /\[IMAGE:\s*([^\]]+)\]/g;
    const placeholders: { match: string; description: string }[] = [];
    let match;

    while ((match = imagePlaceholderRegex.exec(processedContent)) !== null) {
      placeholders.push({
        match: match[0],
        description: match[1].trim(),
      });
    }

    if (placeholders.length === 0) {
      return processedContent;
    }

    // Limit to 3 images max
    const limitedPlaceholders = placeholders.slice(0, 3);
    
    // Remove excess placeholders beyond the first 3
    if (placeholders.length > 3) {
      for (let i = 3; i < placeholders.length; i++) {
        processedContent = processedContent.replace(placeholders[i].match, '');
      }
      this.logger.log(`[linkedin_article] Removed ${placeholders.length - 3} excess image placeholders`);
    }

    this.logger.log(`[linkedin_article] Found ${limitedPlaceholders.length} image placeholders to generate`);

    // Generate images for each placeholder
    for (const placeholder of limitedPlaceholders) {
      try {
        // Create an optimized prompt for the image
        const imagePrompt = this.createLinkedInImagePrompt(placeholder.description);
        
        this.logger.log(`[linkedin_article] Generating image: "${placeholder.description}"`);

        // Generate the image using existing infrastructure
        const { b64 } = await this.aiGateway.generateImageB64({
          prompt: imagePrompt,
          size: '1792x1024', // Landscape format for LinkedIn articles
          quality: 'standard',
          timeoutMs: 120_000,
        });

        // Upload to storage
        const client = this.supabase.getServiceClient();
        await this.ensureBlogImagesBucket();

        const imageId = crypto.randomUUID();
        const filename = `linkedin-article-images/${postId}/${imageId}.png`;
        const rawBuffer = Buffer.from(b64, 'base64');
        // Strip C2PA/EXIF metadata to prevent LinkedIn "cr" badge detection
        const buffer = await this.stripAiMetadata(rawBuffer);

        const { error: uploadErr } = await client.storage
          .from('blog-images')
          .upload(filename, buffer, {
            contentType: 'image/png',
            upsert: true,
          });

        if (uploadErr) {
          this.logger.warn(`[linkedin_article] Image upload failed: ${uploadErr.message}`);
          // Replace with simple format for manual addition
          processedContent = processedContent.replace(
            placeholder.match,
            `\n[Image: ${placeholder.description}]\n(Image generation failed - add manually)\n`,
          );
          continue;
        }

        // Get public URL
        const { data: urlData } = client.storage
          .from('blog-images')
          .getPublicUrl(filename);

        const imageUrl = urlData?.publicUrl || '';

        // Replace placeholder with simplified image block (just description + URL)
        const imageBlock = `\n[Image: ${placeholder.description}]\n${imageUrl}\n`;
        processedContent = processedContent.replace(placeholder.match, imageBlock);

        this.logger.log(`[linkedin_article] Image generated and uploaded: ${imageUrl}`);
      } catch (error) {
        this.logger.error(`[linkedin_article] Image generation failed for "${placeholder.description}": ${(error as Error).message}`);
        // Replace with simple format for manual addition
        processedContent = processedContent.replace(
          placeholder.match,
          `\n[Image: ${placeholder.description}]\n(Image generation failed - add manually)\n`,
        );
      }
    }

    return processedContent;
  }

  /**
   * Deduplicate repeated sections in LinkedIn article content.
   * Detects ALL-CAPS headings that appear multiple times and keeps only the first occurrence.
   */
  private deduplicateLinkedInSections(content: string): string {
    // Split content into sections by dividers (———)
    const dividerRegex = /———/g;
    const sections = content.split(dividerRegex);
    
    // Track seen headings (ALL-CAPS lines at the start of sections)
    const seenHeadings = new Set<string>();
    const deduplicatedSections: string[] = [];
    
    for (const section of sections) {
      const trimmedSection = section.trim();
      if (!trimmedSection) continue;
      
      // Extract the first line to check if it's an ALL-CAPS heading
      const lines = trimmedSection.split('\n');
      const firstLine = lines[0]?.trim() || '';
      
      // Check if first line is an ALL-CAPS heading (at least 3 words, all caps)
      const isAllCapsHeading = /^[A-Z][A-Z\s\d\-:,!?']+$/.test(firstLine) && 
                               firstLine.length > 10 &&
                               firstLine.split(/\s+/).length >= 2;
      
      if (isAllCapsHeading) {
        // Normalize heading for comparison (remove extra spaces, punctuation)
        const normalizedHeading = firstLine.replace(/[^A-Z\s]/g, '').replace(/\s+/g, ' ').trim();
        
        if (seenHeadings.has(normalizedHeading)) {
          // Skip this duplicate section
          this.logger.log(`[linkedin_article] Removing duplicate section: "${firstLine}"`);
          continue;
        }
        
        seenHeadings.add(normalizedHeading);
      }
      
      deduplicatedSections.push(trimmedSection);
    }
    
    // Rejoin sections with dividers
    return deduplicatedSections.join('\n\n———\n\n');
  }

  /**
   * Consolidate all hashtags to the very end of the content.
   * Finds all #hashtag patterns, removes them from the body, dedupes, and adds once at the end.
   */
  private consolidateHashtagsToEnd(content: string): string {
    // Find all hashtags in the content
    const hashtagRegex = /#[A-Za-z][A-Za-z0-9_]*/g;
    const allHashtags: string[] = [];
    let match;
    
    while ((match = hashtagRegex.exec(content)) !== null) {
      allHashtags.push(match[0]);
    }
    
    if (allHashtags.length === 0) {
      return content;
    }
    
    // Remove all hashtags from the content
    let cleanedContent = content.replace(hashtagRegex, '');
    
    // Clean up any lines that are now empty or just whitespace after hashtag removal
    cleanedContent = cleanedContent.replace(/^\s*\n/gm, '\n');
    
    // Collapse excessive blank lines
    cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n');
    
    // Dedupe hashtags (case-insensitive) and limit to 5
    const seenLower = new Set<string>();
    const uniqueHashtags: string[] = [];
    
    for (const tag of allHashtags) {
      const lower = tag.toLowerCase();
      if (!seenLower.has(lower)) {
        seenLower.add(lower);
        uniqueHashtags.push(tag);
      }
    }
    
    // Limit to 5 hashtags
    const finalHashtags = uniqueHashtags.slice(0, 5);
    
    // Ensure content ends with a divider before hashtags
    cleanedContent = cleanedContent.trim();
    if (!cleanedContent.endsWith('———')) {
      cleanedContent += '\n\n———';
    }
    
    // Add hashtags at the very end
    cleanedContent += '\n\n' + finalHashtags.join(' ');
    
    this.logger.log(`[linkedin_article] Consolidated ${allHashtags.length} hashtags to ${finalHashtags.length} unique at end`);
    
    return cleanedContent;
  }

  /**
   * Create an optimized image prompt for LinkedIn article images.
   * Transforms descriptive alt text into a detailed image generation prompt.
   */
  private createLinkedInImagePrompt(description: string): string {
    // Base style for professional LinkedIn images
    const baseStyle = 'Professional, clean, modern business illustration style. High quality, suitable for LinkedIn article. No text overlays.';
    
    // Detect image type and enhance prompt accordingly
    const lowerDesc = description.toLowerCase();
    
    if (lowerDesc.includes('chart') || lowerDesc.includes('comparison') || lowerDesc.includes('graph')) {
      return `${baseStyle} Create a clean, professional infographic or data visualization showing: ${description}. Use a modern color palette with blues and greens. Abstract representation, not actual data.`;
    }
    
    if (lowerDesc.includes('dashboard') || lowerDesc.includes('interface') || lowerDesc.includes('screenshot')) {
      return `${baseStyle} Create a stylized, abstract representation of a modern software dashboard or interface showing: ${description}. Clean UI design, minimal, professional.`;
    }
    
    if (lowerDesc.includes('infographic') || lowerDesc.includes('workflow') || lowerDesc.includes('process')) {
      return `${baseStyle} Create a professional infographic or workflow diagram illustrating: ${description}. Use icons and visual elements, modern flat design style.`;
    }
    
    if (lowerDesc.includes('team') || lowerDesc.includes('people') || lowerDesc.includes('collaboration')) {
      return `${baseStyle} Create an illustration of professional business people or team collaboration showing: ${description}. Diverse, modern, corporate setting.`;
    }
    
    // Default: general professional illustration
    return `${baseStyle} Create a professional illustration for a LinkedIn article about: ${description}. Modern, clean, business-appropriate visual.`;
  }

  /**
   * Generate long content iteratively by processing sections.
   * 
   * IMPORTANT: This function is resilient to section failures. If a section fails
   * after retries, it will:
   * 1. Return partial content from successfully generated sections (if any)
   * 2. Only throw if NO sections were generated successfully
   * 
   * This prevents throwing away good content (e.g., 19k chars from sections 1+2)
   * when a later section fails due to timeouts or model errors.
   */
  private async generateContentIteratively(
    systemPrompt: string,
    originalBody: string,
    title: string,
    platform: string,
    category: string | null | undefined,
    minExpectedLength: number,
    maxTokens: number,
  ): Promise<string> {
    const sections = this.splitIntoSections(originalBody, 4000);
    const totalSections = sections.length;
    const charLimit = this.getPlatformCharacterLimit(platform) || 15000;
    
    // Calculate per-section target based on total limit
    const perSectionLimit = Math.floor(charLimit / totalSections);

    this.logger.log(`[${platform}] Generating iteratively: ${totalSections} sections, original=${originalBody.length} chars, charLimit=${charLimit}`);
    sections.forEach((s, i) => this.logger.log(`[${platform}] Section ${i + 1} input: ${s.length} chars`));

    const results: string[] = [];
    let lastSuccessfulSectionIndex = -1;

    for (let i = 0; i < totalSections; i++) {
      const section = sections[i];
      const isFirst = i === 0;
      const isLast = i === totalSections - 1;

      // Calculate target output for this section based on platform limit
      const sectionTargetOutput = Math.min(perSectionLimit, 4000);

      const isDevTo = platform === 'devto';
      
      // Build list of headings already covered to prevent repetition
      const coveredHeadings = results.length > 0 
        ? this.extractHeadings(results.join('\n\n')).slice(0, 10).join(', ')
        : '';
      
      const sectionPrompt = isFirst
        ? `Adapt this article for ${platform}. Section 1 of ${totalSections}.

OUTPUT: Raw markdown only (NO JSON).
TARGET: ~${sectionTargetOutput.toLocaleString()} characters for this section.
TOTAL LIMIT: ${charLimit.toLocaleString()} characters for entire article.

TITLE: ${title}
CATEGORY: ${category || 'General'}

ANTI-REPETITION: Each heading/topic appears ONCE in the entire article. Do NOT repeat content.

SECTION TO ADAPT:
${section}

Write the introduction and this section. ${isLast ? 'Include conclusion.' : 'Do NOT write conclusion - more sections follow.'}`
        : `Continue adapting for ${platform}. Section ${i + 1} of ${totalSections}.

OUTPUT: Raw markdown only (NO JSON).
TARGET: ~${sectionTargetOutput.toLocaleString()} characters for this section.
TOTAL LIMIT: ${charLimit.toLocaleString()} characters for entire article.${isDevTo ? `

CRITICAL: Do NOT add any YAML frontmatter (no --- blocks). The frontmatter was already written in section 1.` : ''}

ALREADY COVERED (DO NOT REPEAT): ${coveredHeadings || 'None yet'}

PREVIOUS CONTENT ENDED WITH:
...${results[results.length - 1]?.slice(-200) || ''}

NEXT SECTION TO ADAPT:
${section}

Continue seamlessly. Do NOT repeat any headings or content from previous sections. ${isLast ? 'This is the FINAL section - include brief conclusion.' : 'Do NOT write conclusion yet.'}`;

      this.logger.log(`[${platform}] Generating section ${i + 1}/${totalSections}...`);
      
      // Wrap section generation in try-catch to handle failures gracefully
      let cleaned: string | null = null;
      const maxSectionRetries = 3;
      
      for (let sectionRetry = 0; sectionRetry < maxSectionRetries; sectionRetry++) {
        try {
          // Exponential backoff: 0ms, 2s, 4s
          if (sectionRetry > 0) {
            const backoffMs = Math.pow(2, sectionRetry) * 1000;
            this.logger.log(`[${platform}] Section ${i + 1} retry ${sectionRetry}/${maxSectionRetries - 1} after ${backoffMs}ms backoff...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
          
          const { content: sectionContent, model } = await this.aiGateway.chatCompletionRaw({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: sectionPrompt },
            ],
            category: 'seo_generation',
            temperature: 0.7,
            maxTokens: Math.min(maxTokens, 8000),
            timeoutMs: 120_000,
          });

          this.logger.log(`[${platform}] Section ${i + 1} raw response: ${sectionContent.length} chars from model ${model}`);

          cleaned = this.cleanMarkdownOutput(sectionContent);
          this.logger.log(`[${platform}] Section ${i + 1} after cleaning: ${cleaned.length} chars`);

          // Check if section is truncated (but don't force minimum length - quality over quantity)
          const isTruncated = this.isContentTruncated(cleaned);
          
          if (isTruncated) {
            this.logger.warn(`[${platform}] Section ${i + 1} truncated, attempting continuation...`);
            
            // Try one continuation for truncated content
            try {
              const { content: cont } = await this.aiGateway.chatCompletionRaw({
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: sectionPrompt },
                  { role: 'assistant', content: cleaned },
                  { role: 'user', content: `Continue from exactly where you stopped. Complete the current sentence/paragraph. Do NOT repeat any content.` },
                ],
                category: 'seo_generation',
                temperature: 0.7,
                maxTokens: 2000,
                timeoutMs: 60_000,
              });
              
              const contCleaned = this.cleanMarkdownOutput(cont);
              this.logger.log(`[${platform}] Section ${i + 1} continuation: +${contCleaned.length} chars`);
              cleaned = cleaned + '\n\n' + contCleaned;
            } catch (contError) {
              this.logger.warn(`[${platform}] Section ${i + 1} continuation failed: ${(contError as Error).message}`);
            }
          }
          
          // Section succeeded, break out of retry loop
          break;
        } catch (sectionError) {
          const errorMsg = (sectionError as Error).message;
          this.logger.error(`[${platform}] Section ${i + 1} attempt ${sectionRetry + 1}/${maxSectionRetries} failed: ${errorMsg}`);
          
          // If this was the last retry, cleaned stays null
          if (sectionRetry === maxSectionRetries - 1) {
            this.logger.error(`[${platform}] Section ${i + 1} FAILED after ${maxSectionRetries} retries`);
          }
        }
      }

      // Handle section result
      if (cleaned !== null && cleaned.length > 0) {
        results.push(cleaned);
        lastSuccessfulSectionIndex = i;
        this.logger.log(`[${platform}] Section ${i + 1}/${totalSections} DONE: ${cleaned.length} chars (target: ${sectionTargetOutput})`);
      } else {
        // Section failed - decide whether to continue or return partial content
        this.logger.error(`[${platform}] Section ${i + 1}/${totalSections} FAILED - no content generated`);
        
        if (results.length > 0) {
          // We have partial content - return it instead of throwing everything away
          const partialMerged = results.join('\n\n');
          this.logger.warn(`[${platform}] Returning partial content: ${partialMerged.length} chars from ${results.length}/${totalSections} sections (sections 1-${lastSuccessfulSectionIndex + 1} succeeded, section ${i + 1} failed)`);
          
          // Add a note that content is incomplete (will be cleaned up by the caller if needed)
          const incompleteNote = `\n\n---\n\n*Note: This article was partially generated. Some sections may be incomplete due to processing limitations.*`;
          
          return partialMerged + incompleteNote;
        } else {
          // No content at all - throw to trigger fallback
          throw new Error(`Failed to generate any content: section ${i + 1} failed and no previous sections succeeded`);
        }
      }
    }

    const rawMerged = results.join('\n\n');
    this.logger.log(`[${platform}] Total merged: ${rawMerged.length} chars`);

    // Apply platform-specific sanitization
    let merged = rawMerged;
    
    // For Dev.to: strip any duplicate YAML frontmatter blocks
    if (platform === 'devto') {
      merged = this.sanitizeDevToFrontmatter(merged);
      if (merged !== rawMerged) {
        this.logger.log(`[devto] Sanitized frontmatter — content reduced from ${rawMerged.length} to ${merged.length} chars`);
      }
    }
    
    // Apply universal deduplication for all platforms
    merged = this.deduplicateContent(merged, platform);
    
    return merged;
  }

  /**
   * Universal content deduplication that works for all platforms.
   * Removes duplicate sections based on heading similarity.
   */
  private deduplicateContent(content: string, platform: string): string {
    // Extract all headings (markdown ## or ALL-CAPS for LinkedIn)
    const isLinkedIn = platform.startsWith('linkedin');
    const headingRegex = isLinkedIn 
      ? /^([A-Z][A-Z\s\d\-:,!?']{10,})$/gm  // ALL-CAPS headings
      : /^#{1,3}\s+(.+)$/gm;  // Markdown headings
    
    const seenHeadings = new Set<string>();
    const lines = content.split('\n');
    const resultLines: string[] = [];
    let skipUntilNextHeading = false;
    let duplicatesRemoved = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = isLinkedIn 
        ? line.match(/^([A-Z][A-Z\s\d\-:,!?']{10,})$/)
        : line.match(/^#{1,3}\s+(.+)$/);
      
      if (headingMatch) {
        const heading = headingMatch[1].trim();
        const normalizedHeading = heading.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        
        if (seenHeadings.has(normalizedHeading)) {
          // Skip this duplicate section
          skipUntilNextHeading = true;
          duplicatesRemoved++;
          this.logger.log(`[${platform}] Removing duplicate section: "${heading}"`);
          continue;
        }
        
        seenHeadings.add(normalizedHeading);
        skipUntilNextHeading = false;
      }
      
      if (!skipUntilNextHeading) {
        resultLines.push(line);
      }
    }
    
    if (duplicatesRemoved > 0) {
      this.logger.log(`[${platform}] Removed ${duplicatesRemoved} duplicate sections`);
    }
    
    // Clean up excessive blank lines
    let result = resultLines.join('\n');
    result = result.replace(/\n{4,}/g, '\n\n\n');
    
    return result;
  }

  /**
   * Strip duplicate YAML frontmatter blocks from Dev.to content.
   *
   * Iterative section generation can produce multiple `---...---` blocks (one per section).
   * Dev.to only accepts a single frontmatter block at the very top.
   * This method:
   *  1. Extracts every `---...---` block from the content.
   *  2. Keeps only the first one (or re-builds a clean one from it).
   *  3. Sanitizes the tags field — removes hyphens and ensures alphanumeric-only tokens.
   *  4. Returns: clean frontmatter + remaining body with all other frontmatter stripped.
   */
  private sanitizeDevToFrontmatter(content: string): string {
    // Match all YAML frontmatter blocks (--- ... ---) anywhere in the content
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/gm;
    const allMatches: { full: string; body: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = frontmatterRegex.exec(content)) !== null) {
      allMatches.push({ full: m[0], body: m[1], index: m.index });
    }

    if (allMatches.length === 0) {
      // No frontmatter at all — nothing to sanitize
      return content;
    }

    // Use the first frontmatter block as the canonical one
    const firstBlock = allMatches[0];

    // Sanitize the tags line: replace hyphens inside tag tokens, keep alphanumeric
    let sanitizedBody = firstBlock.body.replace(
      /^(tags\s*:\s*)(.+)$/m,
      (_line, prefix: string, tagsPart: string) => {
        // Support both YAML array style [tag1, tag2] and comma-separated string
        const isArrayStyle = tagsPart.trim().startsWith('[');
        const rawTags = isArrayStyle
          ? tagsPart.replace(/[\[\]]/g, '').split(',')
          : tagsPart.split(',');
        const cleanTags = rawTags
          .map((t) => t.trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
          .filter((t) => t.length > 0)
          .slice(0, 4); // Dev.to max 4 tags
        return `${prefix}${cleanTags.join(', ')}`;
      },
    );

    // Force published: true — AI often generates published: false which overrides the API param
    if (/^published\s*:/m.test(sanitizedBody)) {
      sanitizedBody = sanitizedBody.replace(/^published\s*:.*$/m, 'published: true');
    } else {
      sanitizedBody = `published: true\n${sanitizedBody}`;
    }

    const cleanFrontmatter = `---\n${sanitizedBody}\n---`;

    // Remove ALL frontmatter blocks from the body, then prepend the single clean one
    let body = content;
    // Remove blocks from last to first so indices stay valid
    for (let i = allMatches.length - 1; i >= 0; i--) {
      const block = allMatches[i];
      body = body.slice(0, block.index) + body.slice(block.index + block.full.length);
    }

    // Trim any leading whitespace/newlines that were between/around the blocks
    body = body.replace(/^\s+/, '');

    return `${cleanFrontmatter}\n\n${body}`;
  }

  /**
   * Continue markdown generation if initial output was truncated.
   * Only continues if content appears cut off mid-sentence.
   */
  private async continueMarkdownGeneration(
    systemPrompt: string,
    currentContent: string,
    _originalBody: string,
    _minExpectedLength: number,
    maxTokens: number,
  ): Promise<string> {
    // Only continue if actually truncated (cut off mid-sentence)
    if (!this.isContentTruncated(currentContent)) {
      return currentContent;
    }
    
    let content = currentContent;
    const maxAttempts = 2; // Reduced from 5 - don't over-continue
    
    for (let attempt = 0; attempt < maxAttempts && this.isContentTruncated(content); attempt++) {
      this.logger.log(`[continuation] Attempt ${attempt + 1}/${maxAttempts}: completing truncated content`);

      const continuationPrompt = `Your previous output was cut off mid-sentence. Continue from exactly where you stopped:
...${content.slice(-200)}

Complete the current thought and finish the article naturally. Do NOT repeat any content.
OUTPUT: Raw markdown continuation only.`;

      try {
        const { content: cont, model } = await this.aiGateway.chatCompletionRaw({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'assistant', content: content },
            { role: 'user', content: continuationPrompt },
          ],
          category: 'seo_generation',
          temperature: 0.7,
          maxTokens: Math.min(maxTokens, 4000),
          timeoutMs: 60_000,
        });

        const contCleaned = this.cleanMarkdownOutput(cont);
        this.logger.log(`[continuation] Attempt ${attempt + 1} got ${contCleaned.length} chars from ${model}`);
        
        if (contCleaned.length < 50) {
          this.logger.warn(`[continuation] Very short response, stopping`);
          break;
        }
        
        content = content + '\n\n' + contCleaned;
      } catch (err) {
        this.logger.warn(`Continuation ${attempt + 1} failed: ${(err as Error).message}`);
        break;
      }
    }

    this.logger.log(`[continuation] Final: ${content.length} chars`);
    return content;
  }

  /**
   * Generate metadata (title, hashtags, score) separately from content
   */
  private async generateContentMetadata(
    originalTitle: string,
    content: string,
    tags: string[],
    platform: string,
  ): Promise<{ platformTitle?: string; hashtags: string[]; seoScore: number }> {
    const defaultHashtags = tags.slice(0, 5).map(t => `#${t.replace(/\s+/g, '')}`);

    try {
      const { content: metaResponse } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: 'Generate metadata as JSON only. Be concise.' },
          {
            role: 'user',
            content: `Generate metadata for this ${platform} article:

TITLE: ${originalTitle}
CONTENT PREVIEW: ${content.slice(0, 500)}...
TAGS: ${tags.join(', ')}

Output JSON:
{"platformTitle": "optimized title", "hashtags": ["tag1", "tag2"], "seoScore": 75}`,
          },
        ],
        category: 'seo_generation',
        temperature: 0.3,
        maxTokens: 300,
        timeoutMs: 20_000,
      });

      const cleaned = this.extractJsonFromAiResponse(metaResponse);
      const parsed = JSON.parse(cleaned);

      // Sanitize hashtags for platform-specific requirements
      let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags : defaultHashtags;
      hashtags = this.sanitizeHashtagsForPlatform(hashtags, platform);

      return {
        platformTitle: parsed.platformTitle || undefined,
        hashtags,
        seoScore: typeof parsed.seoScore === 'number' ? parsed.seoScore : 70,
      };
    } catch {
      return { platformTitle: undefined, hashtags: this.sanitizeHashtagsForPlatform(defaultHashtags, platform), seoScore: 70 };
    }
  }

  /**
   * Sanitize hashtags based on platform-specific requirements
   * - Dev.to: Only alphanumeric characters allowed (no hyphens, underscores, or special chars)
   * - Hashnode: Similar restrictions
   * - LinkedIn/Twitter: More permissive but still sanitize
   */
  private sanitizeHashtagsForPlatform(hashtags: string[], platform: string): string[] {
    return hashtags.map(tag => {
      // Remove # prefix if present
      let cleaned = tag.startsWith('#') ? tag.slice(1) : tag;
      
      // Platform-specific sanitization
      if (platform === 'devto' || platform === 'hashnode') {
        // Dev.to and Hashnode only allow alphanumeric characters
        // Remove hyphens, underscores, spaces, and any non-alphanumeric chars
        cleaned = cleaned.replace(/[-_\s]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      } else {
        // For other platforms, just remove spaces and special chars but keep it readable
        cleaned = cleaned.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '');
      }
      
      // Ensure tag is not empty and has reasonable length
      if (cleaned.length === 0) return null;
      if (cleaned.length > 30) cleaned = cleaned.slice(0, 30);
      
      return cleaned;
    }).filter((tag): tag is string => tag !== null && tag.length > 0);
  }

  /**
   * Extract headings from markdown content
   */
  private extractHeadings(content: string): string[] {
    const headings: string[] = [];
    for (const line of content.split('\n')) {
      if (/^#{1,3}\s+/.test(line)) headings.push(line.trim());
    }
    return headings;
  }

  private getEnhancedPlatformRules(platform: string): string {
    const rules: Record<string, string> = {
      // ===== TIER 1: AUTO-PUBLISH PLATFORMS =====
      linkedin_article: `LinkedIn Article (MAX 8000 characters / ~1500 words)

FORMAT (LinkedIn editor is WYSIWYG - NO markdown rendering):
• Headings: ALL-CAPS on own line (e.g., "WHY THIS MATTERS")
• Dividers: ——— between sections
• Lists: • for bullets, 1. 2. 3. for numbered
• Links: plain text with URL in parentheses
• NO markdown: NO #, **, *, [text](url)

STRUCTURE (4-6 sections, each appears ONCE):
1. Hook paragraph (2-3 sentences)
2. ——— + SECTION HEADING + content + [IMAGE: description]
3. Repeat for 3-5 more sections
4. ——— + THE BOTTOM LINE + closing
5. ——— + 3-5 hashtags at very end

IMAGES: Include exactly 2-3 [IMAGE: description] placeholders

CRITICAL: Never repeat a section. Each point appears once only. STAY UNDER 8000 CHARACTERS.`,

      linkedin_post: `LinkedIn Post (MAX 3000 characters - HARD LIMIT)

FORMAT:
• Hook first line (bold statement or question)
• Personal tone, short paragraphs (2-3 sentences each)
• 1-2 data points or examples
• End with question for comments
• 3-5 hashtags at end
• NO emojis overload

STRUCTURE:
1. Hook (1-2 lines)
2. Context (2-3 short paragraphs)
3. Key insight or takeaway
4. Question for engagement
5. Hashtags

CRITICAL: MUST be under 3000 characters total. Be concise.`,

      medium: `Medium Article (MAX 15000 characters / ~2500 words)

Medium uses a WYSIWYG editor that does NOT render markdown. Write in PLAIN TEXT only.

FORMAT (NO MARKDOWN):
• Write section headings on their own line (no # symbols)
• Use • for bullet points (not - or *)
• Use ——— for section dividers (not ---)
• NO **bold** or *italic* markers - just write plain text
• NO [text](url) links - write: text (url)
• NO ![](url) images - write: [Image: description] then URL on next line

STRUCTURE:
1. TL;DR or Key Takeaways (3-5 bullets with •)
2. Engaging intro (different angle than original)
3. 4-6 main sections with clear headings (plain text, no #)
4. Conclusion with reflection or CTA

EXAMPLE FORMAT:
TL;DR

• First key point here
• Second key point here
• Third key point here

———

Why This Matters

Opening paragraph that hooks the reader...

———

The First Major Point

Content explaining this point...

[Image: Chart showing comparison]
https://example.com/image.png

TONE: Conversational, editorial, storytelling approach.

CRITICAL: NO MARKDOWN SYNTAX. Write everything in plain text. Never repeat sections.`,

      devto: `Dev.to Article (MAX 20000 characters)

FRONTMATTER (exactly once, at top):
---
title: Your Title Here
published: false
tags: tag1, tag2, tag3, tag4
---

TAGS: alphanumeric only, lowercase, max 4 (e.g., "socialmedia" not "social-media")

FORMAT: Standard markdown
• ## for H2, ### for H3
• Code blocks with syntax highlighting
• Bullet lists for key points

STRUCTURE:
1. Brief intro
2. Prerequisites (if technical)
3. Main content sections
4. Key takeaways or "What I learned"
5. Next steps or resources

URL RULES:
• NO YouTube embeds or liquid tags
• NO placeholder URLs (example.com, test.com)
• Use full URLs: https://trndinn.com/features (not /features)

CRITICAL: Only ONE frontmatter block. Never repeat sections.`,

      hashnode: `Hashnode Article (MAX 20000 characters)

FORMAT: Standard markdown
• ## for H2, ### for H3
• Code blocks with language tags
• Tables where helpful

STRUCTURE:
1. Brief intro with value proposition
2. Prerequisites section (if technical)
3. Main tutorial/explanation sections
4. Code examples with explanations
5. Further Reading section

TONE: Developer-friendly, tutorial-like, clear explanations.

CRITICAL: Never repeat sections. Each concept explained once.`,

      ghost: `Ghost Blog (MAX 15000 characters)

FORMAT: Standard markdown
• ## for H2, ### for H3
• Short paragraphs
• Bullet lists for scanability

STRUCTURE:
1. Compelling intro
2. 4-6 main sections
3. Clear CTA at end

TONE: Clean, professional, SEO-optimized.

CRITICAL: Never repeat sections.`,

      beehiiv: `Beehiiv Newsletter (MAX 10000 characters / ~1500 words)

FORMAT: Simple, scannable
• Bold headers for sections
• Short paragraphs (2-3 sentences)
• Bullet points for takeaways

STRUCTURE:
1. Hook that creates curiosity
2. Main content (3-4 sections)
3. Clear CTA
4. P.S. line with bonus insight

TONE: Personal, direct, like writing to a friend.`,

      telegraph: `Telegraph Article (MAX 10000 characters)
• Clean, minimal formatting
• Short paragraphs
• Basic formatting only (bold, italic, links)
• No images or complex media
• Strong opening that delivers value immediately`,

      blogger: `Blogger Post (MAX 15000 characters)
• SEO-optimized headings
• Proper H2/H3 structure
• Conversational but informative
• Internal linking suggestions`,

      // ===== TIER 2: SUBMIT FOR REVIEW PLATFORMS =====
      hackernoon: `HackerNoon (MAX 15000 characters)
• Tech editorial style
• TL;DR at top
• Narrative hook in first paragraph
• Data points and statistics
• Actionable takeaways
• 3-5 relevant tags`,

      towards_ai: `Towards AI (MAX 15000 characters)
• AI/ML focused, technical accuracy
• Clear explanations for practitioners
• Python code snippets if relevant
• Practical applications
• Research references`,

      analytics_vidhya: `Analytics Vidhya (MAX 15000 characters)
• Data science/ML focused
• Step-by-step tutorials preferred
• Code examples with explanations
• Visualizations described
• Practical use cases
• Clear prerequisites section`,

      freecodecamp: `freeCodeCamp Tutorial (MAX 15000 characters)
• Educational, step-by-step
• "What You'll Learn" section
• Prerequisites section
• Working code examples
• "Next Steps" at end`,

      smashing_magazine: `Smashing Magazine (MAX 15000 characters)
• Web development/design focus
• In-depth technical content
• Code examples with explanations
• Best practices highlighted
• Accessibility considerations
• Performance tips where relevant`,

      sitepoint: `SitePoint (MAX 15000 characters)
• Web development tutorials
• Clear, structured format
• Code examples with syntax highlighting
• Step-by-step instructions
• Browser compatibility notes
• Links to documentation`,

      readwrite: `ReadWrite (MAX 12000 characters)
• Tech industry analysis
• News-style opening
• Expert quotes or data
• Industry trends
• Future implications
• Balanced perspective`,

      yourstory: `YourStory (MAX 12000 characters)
• Startup/entrepreneur focus
• Founder journey narrative
• Problem-solution format
• Metrics and traction
• Lessons learned
• Indian market context if relevant`,

      startuptalky: `StartupTalky (MAX 12000 characters)
• Startup ecosystem focus
• Business model analysis
• Growth strategies
• Funding/investment angle
• Market opportunity
• Competitive landscape`,

      inc42: `Inc42 (MAX 12000 characters)
• Indian startup ecosystem
• Data-driven insights
• Funding news angle
• Market analysis
• Founder perspectives
• Policy/regulatory context`,

      techstory: `TechStory (MAX 12000 characters)
• Tech news format
• Startup coverage
• Product launches
• Industry trends
• Expert commentary
• Future outlook`,

      // ===== TIER 3: DISCUSSION PLATFORMS =====
      reddit: `Reddit Post (MAX 10000 characters)
CRITICAL: Value-first, NO self-promotion
1. Hook (finding or question)
2. Brief context
3. Key insights (bullets)
4. 2-3 discussion questions
Suggest: 3 relevant subreddits

TONE: Authentic, community-focused, no marketing speak.`,

      indiehackers: `Indie Hackers Post (MAX 10000 characters)
Format: Problem → What I Built → Key Learnings → What's Next → Questions
• Founder journey style
• Specific metrics if available
• Transparent about challenges
• Revenue/growth numbers
• Tech stack mentioned`,

      producthunt_discussions: `Product Hunt Discussion (MAX 5000 characters)
• Product-focused insights
• Maker perspective
• Community value
• Ask for feedback
• Share learnings
• Engage authentically`,

      growthhackers: `GrowthHackers (MAX 8000 characters)
• Growth marketing focus
• Experiment results
• Metrics and data
• Actionable tactics
• A/B test insights
• Scalable strategies`,

      hackernews: `Hacker News (MAX 2000 characters)
• Factual, concise title
• NO marketing language
• Technical focus
• Brief context comment
• Link to full article
• Invite technical discussion`,

      huggingface_community: `Hugging Face Community (MAX 8000 characters)
• ML/AI model focus
• Technical implementation
• Code snippets
• Model performance
• Use cases
• Community collaboration`,

      // ===== SOCIAL PLATFORMS =====
      twitter_thread: `Twitter/X Thread (MAX 4000 characters total / 10-15 tweets)
• Each tweet UNDER 280 chars
• Number: 1/, 2/, etc.
• First tweet = hook
• Last tweet = CTA
• Separate tweets with ---
• 2-3 hashtags on last tweet only`,

      newsletter: `Email Newsletter (MAX 10000 characters)
• Personal, direct tone
• Short paragraphs
• Clear sections
• Single CTA
• P.S. line`,

      substack: `Substack (MAX 12000 characters)
• Personal, opinionated voice
• Personal anecdotes
• Conversational tone
• Subscribe/share CTA`,

      facebook: `Facebook Post (MAX 3000 characters)
• Conversational
• Question to drive comments
• Emoji sparingly
• Engagement prompt at end
• Tag relevant pages if applicable`,

      instagram: `Instagram Carousel (MAX 2200 characters for caption)
• [Slide N - Topic] format
• First slide = hook
• Last slide = CTA
• Under 50 words per slide
• 5-10 slides total
• Hashtags in first comment (not caption)`,
    };

    return rules[platform] || `Adapt for ${platform}. Keep core message, match platform conventions. Max 10000 characters.`;
  }

  private fallbackAdaptContent(
    post: {
      title: string;
      excerpt: string | null;
      body: string | null;
      tags: string[] | null;
    },
    platform: string,
  ): string {
    const title = post.title;
    const excerpt = post.excerpt ?? '';
    const body = post.body ?? excerpt;
    const tags = post.tags ?? [];
    const hashtags = tags
      .slice(0, 5)
      .map((t) => `#${t.replace(/\s+/g, '')}`)
      .join(' ');

    switch (platform) {
      case 'linkedin_article':
        return `${title}\n\n${body.replace(/^#{1,3}\s+/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')}\n\n---\n${hashtags}`;
      case 'linkedin_post':
        return `${title}\n\n${excerpt.slice(0, 1200)}\n\n${hashtags}`;
      case 'twitter_thread':
        return this.generateFallbackTwitterThread(title, excerpt, body, tags);
      default:
        return `${title}\n\n${body.slice(0, 3000)}`;
    }
  }

  private generateFallbackTwitterThread(
    title: string,
    _excerpt: string,
    body: string,
    tags: string[],
  ): string {
    const hashtags = tags
      .slice(0, 3)
      .map((t) => `#${t.replace(/\s+/g, '')}`)
      .join(' ');
    const sentences = body
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 20)
      .slice(0, 8);
    const tweets: string[] = [`🧵 ${title}\n\nA thread 👇`];
    sentences.forEach((sentence, i) => {
      tweets.push(`${i + 2}/ ${sentence.trim().slice(0, 250)}`);
    });
    tweets.push(
      `${tweets.length + 1}/ That's it! If you found this useful:\n\n• Repost to share with others\n• Follow for more insights\n\n${hashtags}`,
    );
    return tweets.join('\n\n---\n\n');
  }

  // --- Platform Accounts ---

  private isTrndinnOAuthCredentials(
    credentials: Record<string, any> | null | undefined,
  ): boolean {
    return (
      credentials?.source === ContentEngineService.TRNDINN_OAUTH_SOURCE &&
      typeof credentials?.user_id === 'string' &&
      credentials.user_id.length > 0
    );
  }

  private async fetchLinkedInUserinfo(accessToken: string): Promise<{
    sub: string;
    name?: string;
    given_name?: string;
  }> {
    const resp = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      throw new BadRequestException(
        `LinkedIn userinfo failed (${resp.status})`,
      );
    }
    return resp.json();
  }

  private async fetchLinkedInAuthorUrn(accessToken: string): Promise<string> {
    const data = await this.fetchLinkedInUserinfo(accessToken);
    if (!data?.sub) {
      throw new BadRequestException('Failed to resolve LinkedIn author URN');
    }
    return `urn:li:person:${data.sub}`;
  }

  private async getValidLinkedInAccessToken(userId: string): Promise<string> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    const expiresAt = profile.linkedin_expires_at
      ? new Date(profile.linkedin_expires_at)
      : null;
    const stillValid =
      !expiresAt ||
      expiresAt.getTime() >
        Date.now() + ContentEngineService.TOKEN_EXPIRY_SKEW_MS;

    if (stillValid) {
      return profile.linkedin_access_token;
    }

    if (!profile.linkedin_refresh_token) {
      throw new BadRequestException(
        'LinkedIn token expired. Reconnect in Settings.',
      );
    }
    if (!this.linkedInAuth) {
      throw new BadRequestException(
        'LinkedIn token expired. Reconnect in Settings.',
      );
    }

    const refreshed = await this.linkedInAuth.refreshTokens(
      profile.linkedin_refresh_token,
    );
    await this.profileRepository.updateLinkedinTokens(
      userId,
      refreshed.accessToken,
      refreshed.refreshToken ?? profile.linkedin_refresh_token,
      refreshed.expiresAt,
    );
    return refreshed.accessToken;
  }

  private async resolveLinkedInCredentials(
    credentials: Record<string, any>,
  ): Promise<{ access_token: string; author_urn: string; org_id?: string }> {
    if (!this.isTrndinnOAuthCredentials(credentials)) {
      return credentials as {
        access_token: string;
        author_urn: string;
        org_id?: string;
      };
    }

    const userId = credentials.user_id as string;
    const accessToken = await this.getValidLinkedInAccessToken(userId);
    const authorUrn = await this.fetchLinkedInAuthorUrn(accessToken);
    return {
      access_token: accessToken,
      author_urn: authorUrn,
      org_id: credentials.org_id,
    };
  }

  async getLinkedInOAuthStatus(userId: string) {
    const profile = await this.profileRepository.findById(userId);
    const connected = !!profile?.linkedin_access_token;
    if (!connected) {
      return {
        connected: false,
        profileName: null,
        authorUrn: null,
        expiresAt: null,
        tokenExpired: false,
        enabledPlatforms: [] as string[],
        distributionEnabled: false,
      };
    }

    const client = this.supabase.getServiceClient();
    const { data: accounts } = await client
      .from('platform_accounts')
      .select('platform, is_connected, credentials')
      .in('platform', [...ContentEngineService.LINKEDIN_PLATFORMS]);

    const enabledPlatforms = (accounts ?? [])
      .filter(
        (account: any) =>
          account.is_connected &&
          this.isTrndinnOAuthCredentials(account.credentials) &&
          account.credentials.user_id === userId,
      )
      .map((account: any) => account.platform as string);

    try {
      const accessToken = await this.getValidLinkedInAccessToken(userId);
      const userinfo = await this.fetchLinkedInUserinfo(accessToken);
      return {
        connected: true,
        profileName:
          userinfo.name || userinfo.given_name || profile?.full_name || null,
        authorUrn: `urn:li:person:${userinfo.sub}`,
        expiresAt: profile?.linkedin_expires_at ?? null,
        tokenExpired: false,
        enabledPlatforms,
        distributionEnabled: enabledPlatforms.length > 0,
      };
    } catch (error) {
      this.logger.warn(
        `LinkedIn OAuth status check failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        connected: true,
        profileName: profile?.full_name ?? null,
        authorUrn: null,
        expiresAt: profile?.linkedin_expires_at ?? null,
        tokenExpired: true,
        enabledPlatforms,
        distributionEnabled: enabledPlatforms.length > 0,
      };
    }
  }

  async enableLinkedInOAuthDistribution(userId: string) {
    const status = await this.getLinkedInOAuthStatus(userId);
    if (!status.connected) {
      throw new BadRequestException('Connect LinkedIn in Settings first');
    }
    if (status.tokenExpired) {
      throw new BadRequestException(
        'LinkedIn token expired. Reconnect in Settings.',
      );
    }

    const accountName = status.profileName || 'Trndinn LinkedIn';
    const credentials = {
      source: ContentEngineService.TRNDINN_OAUTH_SOURCE,
      user_id: userId,
    };

    const results: Awaited<
      ReturnType<typeof this.upsertPlatformAccountRecord>
    >[] = [];
    for (const platform of ContentEngineService.LINKEDIN_PLATFORMS) {
      const result = await this.upsertPlatformAccountRecord(platform, {
        account_name: accountName,
        credentials,
        notes: 'Connected via Trndinn OAuth',
        is_connected: true,
        last_tested_at: new Date().toISOString(),
        last_test_result: 'Connected via Trndinn OAuth',
      });
      results.push(result);
    }

    return { success: true, platforms: results };
  }

  private async upsertPlatformAccountRecord(
    platform: string,
    body: {
      account_name: string;
      credentials: Record<string, any>;
      notes?: string | null;
      is_connected?: boolean;
      last_tested_at?: string | null;
      last_test_result?: string | null;
    },
  ) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('platform_accounts')
      .upsert(
        {
          platform,
          account_name: body.account_name,
          credentials: body.credentials,
          notes: body.notes ?? null,
          is_connected: body.is_connected ?? false,
          last_tested_at: body.last_tested_at ?? null,
          last_test_result: body.last_test_result ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'platform' },
      )
      .select()
      .single();

    if (error) throw error;
    return { ...data, credentials: this.maskCredentials(data.credentials) };
  }

  async listPlatformAccounts() {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('platform_accounts')
      .select('*')
      .order('platform');

    if (error) throw error;

    return (data ?? []).map((account: any) => ({
      ...account,
      credentials: this.maskCredentials(account.credentials),
    }));
  }

  async upsertPlatformAccount(
    platform: string,
    body: {
      account_name: string;
      credentials: Record<string, any>;
      notes?: string;
    },
    userId?: string,
  ) {
    if (
      ContentEngineService.LINKEDIN_PLATFORMS.includes(platform as any) &&
      (this.isTrndinnOAuthCredentials(body.credentials) ||
        body.credentials?.source === ContentEngineService.TRNDINN_OAUTH_SOURCE)
    ) {
      if (!userId) {
        throw new BadRequestException(
          'User ID required for Trndinn OAuth credentials',
        );
      }
      if (body.credentials?.user_id && body.credentials.user_id !== userId) {
        throw new BadRequestException('Invalid Trndinn OAuth credentials');
      }
      const status = await this.getLinkedInOAuthStatus(userId);
      if (!status.connected || status.tokenExpired) {
        throw new BadRequestException(
          'LinkedIn is not connected or token expired',
        );
      }
      return this.upsertPlatformAccountRecord(platform, {
        account_name:
          body.account_name || status.profileName || 'Trndinn LinkedIn',
        credentials: {
          source: ContentEngineService.TRNDINN_OAUTH_SOURCE,
          user_id: userId,
        },
        notes: body.notes ?? 'Connected via Trndinn OAuth',
        is_connected: true,
        last_tested_at: new Date().toISOString(),
        last_test_result: 'Connected via Trndinn OAuth',
      });
    }

    return this.upsertPlatformAccountRecord(platform, {
      account_name: body.account_name,
      credentials: body.credentials,
      notes: body.notes ?? null,
    });
  }

  async testPlatformConnection(platform: string) {
    const client = this.supabase.getServiceClient();
    const { data: account } = await client
      .from('platform_accounts')
      .select('*')
      .eq('platform', platform)
      .single();

    if (!account) throw new NotFoundException('Platform account not found');

    const credentials = account.credentials as Record<string, any>;
    let testResult: { success: boolean; message: string };

    try {
      const resolvedCredentials =
        ContentEngineService.LINKEDIN_PLATFORMS.includes(platform as any) &&
        this.isTrndinnOAuthCredentials(credentials)
          ? await this.resolveLinkedInCredentials(credentials)
          : credentials;
      testResult = await this.runConnectionTest(platform, resolvedCredentials);
    } catch (e: any) {
      testResult = {
        success: false,
        message: e.message || 'Connection test failed',
      };
    }

    await client
      .from('platform_accounts')
      .update({
        is_connected: testResult.success,
        last_tested_at: new Date().toISOString(),
        last_test_result: testResult.message,
        updated_at: new Date().toISOString(),
      })
      .eq('platform', platform);

    return testResult;
  }

  async deletePlatformAccount(platform: string) {
    const client = this.supabase.getServiceClient();
    const { error } = await client
      .from('platform_accounts')
      .delete()
      .eq('platform', platform);

    if (error) throw error;
    return { success: true };
  }

  private async runConnectionTest(
    platform: string,
    credentials: Record<string, any>,
  ): Promise<{ success: boolean; message: string }> {
    switch (platform) {
      case 'devto': {
        if (!credentials.api_key)
          return { success: false, message: 'API key is required' };
        const resp = await fetch('https://dev.to/api/articles/me?per_page=1', {
          headers: { 'api-key': credentials.api_key },
        });
        if (resp.ok)
          return { success: true, message: 'Connected to Dev.to successfully' };
        return { success: false, message: `Dev.to returned ${resp.status}` };
      }

      case 'hashnode': {
        if (!credentials.token)
          return { success: false, message: 'Token is required' };
        const resp = await fetch('https://gql.hashnode.com', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: credentials.token,
          },
          body: JSON.stringify({ query: '{ me { id username } }' }),
        });
        if (resp.ok)
          return {
            success: true,
            message: 'Connected to Hashnode successfully',
          };
        return { success: false, message: `Hashnode returned ${resp.status}` };
      }

      case 'medium': {
        if (!credentials.token)
          return { success: false, message: 'Token is required' };
        const resp = await fetch('https://api.medium.com/v1/me', {
          headers: { Authorization: `Bearer ${credentials.token}` },
        });
        if (resp.ok)
          return { success: true, message: 'Connected to Medium successfully' };
        return { success: false, message: `Medium returned ${resp.status}` };
      }

      case 'linkedin_article':
      case 'linkedin_post': {
        if (!credentials.access_token)
          return { success: false, message: 'Access token is required' };
        const resp = await fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { Authorization: `Bearer ${credentials.access_token}` },
        });
        if (resp.ok) {
          const message = credentials.author_urn
            ? `Connected to LinkedIn (${credentials.author_urn})`
            : 'Connected to LinkedIn successfully';
          return { success: true, message };
        }
        return { success: false, message: `LinkedIn returned ${resp.status}` };
      }

      // ===== NEW TIER 1 PLATFORMS =====
      case 'ghost': {
        if (!credentials.admin_api_key || !credentials.api_url) {
          return {
            success: false,
            message: 'Admin API key and API URL are required',
          };
        }
        try {
          const [id, secret] = credentials.admin_api_key.split(':');
          if (!id || !secret) {
            return {
              success: false,
              message: 'Invalid API key format. Expected: id:secret',
            };
          }
          const apiUrl = credentials.api_url.replace(/\/$/, '');
          const resp = await fetch(`${apiUrl}/ghost/api/admin/site/`, {
            headers: { 'Content-Type': 'application/json' },
          });
          if (resp.ok)
            return {
              success: true,
              message: 'Connected to Ghost successfully',
            };
          return { success: false, message: `Ghost returned ${resp.status}` };
        } catch (e: any) {
          return {
            success: false,
            message: `Ghost connection failed: ${e.message}`,
          };
        }
      }

      case 'beehiiv': {
        if (!credentials.api_key || !credentials.publication_id) {
          return {
            success: false,
            message: 'API key and Publication ID are required',
          };
        }
        try {
          const resp = await fetch(
            `https://api.beehiiv.com/v2/publications/${credentials.publication_id}`,
            {
              headers: { Authorization: `Bearer ${credentials.api_key}` },
            },
          );
          if (resp.ok)
            return {
              success: true,
              message: 'Connected to Beehiiv successfully',
            };
          return { success: false, message: `Beehiiv returned ${resp.status}` };
        } catch (e: any) {
          return {
            success: false,
            message: `Beehiiv connection failed: ${e.message}`,
          };
        }
      }

      case 'telegraph': {
        if (!credentials.access_token) {
          return { success: false, message: 'Access token is required' };
        }
        try {
          const resp = await fetch('https://api.telegra.ph/getAccountInfo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: credentials.access_token }),
          });
          const data = await resp.json();
          if (data.ok)
            return {
              success: true,
              message: `Connected to Telegraph as ${data.result?.short_name || 'user'}`,
            };
          return {
            success: false,
            message: data.error || 'Telegraph connection failed',
          };
        } catch (e: any) {
          return {
            success: false,
            message: `Telegraph connection failed: ${e.message}`,
          };
        }
      }

      case 'blogger': {
        if (!credentials.oauth_token || !credentials.blog_id) {
          return {
            success: false,
            message: 'OAuth token and Blog ID are required',
          };
        }
        try {
          const resp = await fetch(
            `https://www.googleapis.com/blogger/v3/blogs/${credentials.blog_id}`,
            {
              headers: { Authorization: `Bearer ${credentials.oauth_token}` },
            },
          );
          if (resp.ok)
            return {
              success: true,
              message: 'Connected to Blogger successfully',
            };
          return { success: false, message: `Blogger returned ${resp.status}` };
        } catch (e: any) {
          return {
            success: false,
            message: `Blogger connection failed: ${e.message}`,
          };
        }
      }

      // ===== TIER 2 & 3: MANUAL PLATFORMS =====
      case 'hackernoon':
      case 'towards_ai':
      case 'analytics_vidhya':
      case 'freecodecamp':
      case 'smashing_magazine':
      case 'sitepoint':
      case 'readwrite':
      case 'yourstory':
      case 'startuptalky':
      case 'inc42':
      case 'techstory':
      case 'producthunt_discussions':
      case 'growthhackers':
      case 'huggingface_community': {
        return {
          success: true,
          message: 'Manual submission platform — no API connection needed',
        };
      }

      case 'substack':
      case 'indiehackers':
      case 'hackernews': {
        if (!credentials.email || !credentials.password) {
          return { success: false, message: 'Email and password are required' };
        }
        return {
          success: true,
          message: 'Credentials format validated (Playwright-based publishing)',
        };
      }

      case 'reddit': {
        if (!credentials.client_id || !credentials.client_secret) {
          return {
            success: false,
            message: 'Client ID and secret are required',
          };
        }
        return {
          success: true,
          message: 'Reddit credentials format validated',
        };
      }

      case 'twitter_thread': {
        if (!credentials.api_key || !credentials.api_secret) {
          return { success: false, message: 'API key and secret are required' };
        }
        return {
          success: true,
          message: 'Twitter/X credentials format validated',
        };
      }

      case 'newsletter': {
        if (!credentials.api_key || !credentials.provider) {
          return {
            success: false,
            message: 'Provider and API key are required',
          };
        }
        return {
          success: true,
          message: `Newsletter (${credentials.provider}) credentials validated`,
        };
      }

      case 'facebook': {
        if (!credentials.page_id || !credentials.access_token) {
          return {
            success: false,
            message: 'Page ID and access token are required',
          };
        }
        return {
          success: true,
          message: 'Facebook credentials format validated',
        };
      }

      case 'instagram': {
        if (!credentials.business_account_id || !credentials.access_token) {
          return {
            success: false,
            message: 'Business account ID and access token are required',
          };
        }
        return {
          success: true,
          message: 'Instagram credentials format validated',
        };
      }

      default:
        return { success: false, message: `Unsupported platform: ${platform}` };
    }
  }

  private maskCredentials(creds: Record<string, any>): Record<string, any> {
    if (!creds || typeof creds !== 'object') return {};
    const masked: Record<string, any> = {};
    for (const [key, value] of Object.entries(creds)) {
      if (
        typeof value === 'string' &&
        (key.includes('key') ||
          key.includes('token') ||
          key.includes('secret') ||
          key.includes('password'))
      ) {
        masked[key] =
          value.length > 4
            ? '•'.repeat(value.length - 4) + value.slice(-4)
            : '••••';
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  // --- Enhanced Distribution ---

  // Platform tier definitions for UI organization
  static readonly PLATFORM_TIERS = {
    auto: [
      'devto',
      'hashnode',
      'ghost',
      'beehiiv',
      'linkedin_article',
      'linkedin_post',
      'telegraph',
      'blogger',
      'medium', // Deprecated API, but keep for manual fallback
    ],
    submit: [
      'hackernoon',
      'towards_ai',
      'analytics_vidhya',
      'freecodecamp',
      'smashing_magazine',
      'sitepoint',
      'readwrite',
      'yourstory',
      'startuptalky',
      'inc42',
      'techstory',
    ],
    discussion: [
      'reddit',
      'indiehackers',
      'producthunt_discussions',
      'growthhackers',
      'hackernews',
      'huggingface_community',
    ],
    legacy: [
      'twitter_thread',
      'newsletter',
      'substack',
      'facebook',
      'instagram',
    ],
  };

  getPlatformTiers() {
    return ContentEngineService.PLATFORM_TIERS;
  }

  async adaptContentForAllPlatforms(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post } = await client
      .from('blog_posts')
      .select('title, excerpt, body, tags')
      .eq('id', postId)
      .single();

    if (!post) throw new NotFoundException('Post not found');

    const allPlatforms = [
      ...ContentEngineService.PLATFORM_TIERS.auto,
      ...ContentEngineService.PLATFORM_TIERS.submit,
      ...ContentEngineService.PLATFORM_TIERS.discussion,
    ];

    const results: {
      tier: string;
      platform: string;
      status: 'success' | 'failed';
      error?: string;
    }[] = [];

    // Process platforms in batches to avoid overwhelming the AI service
    const batchSize = 3;
    for (let i = 0; i < allPlatforms.length; i += batchSize) {
      const batch = allPlatforms.slice(i, i + batchSize);
      const batchPromises = batch.map(async (platform) => {
        try {
          await this.generateDistribution(postId, platform);
          const tier = ContentEngineService.PLATFORM_TIERS.auto.includes(
            platform,
          )
            ? 'auto'
            : ContentEngineService.PLATFORM_TIERS.submit.includes(platform)
              ? 'submit'
              : 'discussion';
          return { tier, platform, status: 'success' as const };
        } catch (e: any) {
          const tier = ContentEngineService.PLATFORM_TIERS.auto.includes(
            platform,
          )
            ? 'auto'
            : ContentEngineService.PLATFORM_TIERS.submit.includes(platform)
              ? 'submit'
              : 'discussion';
          return {
            tier,
            platform,
            status: 'failed' as const,
            error: e.message,
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const summary = {
      total: results.length,
      success: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'failed').length,
      by_tier: {
        auto: results.filter((r) => r.tier === 'auto'),
        submit: results.filter((r) => r.tier === 'submit'),
        discussion: results.filter((r) => r.tier === 'discussion'),
      },
    };

    return { results, summary };
  }

  async generateAllPlatformContent(postId: string) {
    const client = this.supabase.getServiceClient();
    const { data: accounts } = await client
      .from('platform_accounts')
      .select('platform')
      .eq('is_connected', true);

    const platforms = (accounts ?? []).map((a: any) => a.platform);
    if (platforms.length === 0) {
      throw new BadRequestException(
        'No connected platform accounts. Configure accounts first.',
      );
    }

    const results: any[] = [];
    for (const platform of platforms) {
      try {
        const dist = await this.generateDistribution(postId, platform);
        results.push(dist);
      } catch (e: any) {
        results.push({ platform, status: 'failed', error: e.message });
      }
    }
    return results;
  }

  async publishToPlatform(postId: string, platform: string) {
    const client = this.supabase.getServiceClient();

    const { data: account } = await client
      .from('platform_accounts')
      .select('*')
      .eq('platform', platform)
      .single();

    if (!account || !account.is_connected) {
      throw new BadRequestException(`Platform ${platform} is not connected`);
    }

    const { data: dist } = await client
      .from('blog_distributions')
      .select('*')
      .eq('post_id', postId)
      .eq('platform', platform)
      .single();

    if (!dist || !dist.adapted_content) {
      throw new BadRequestException(
        'No generated content to publish. Generate content first.',
      );
    }

    const { data: post } = await client
      .from('blog_posts')
      .select('title, slug, tags')
      .eq('id', postId)
      .single();

    if (!post) {
      throw new NotFoundException('Blog post not found');
    }

    const rawCredentials = account.credentials as Record<string, any>;
    const credentials =
      ContentEngineService.LINKEDIN_PLATFORMS.includes(platform as any) &&
      this.isTrndinnOAuthCredentials(rawCredentials)
        ? await this.resolveLinkedInCredentials(rawCredentials)
        : rawCredentials;
    const canonicalUrl = `https://trndinn.com/blog/${post.slug}`;
    const tags = (post.tags as string[]) ?? [];

    this.logger.log(`Publishing to ${platform} for post "${post.title}"`);

    const result = await this.platformPublishers.publish(
      platform,
      credentials,
      dist.adapted_content,
      post.title,
      canonicalUrl,
      tags,
      dist.cover_image_url ?? undefined,
    );

    if (result.success) {
      const { data, error } = await client
        .from('blog_distributions')
        .update({
          status: 'published',
          published_url: result.url ?? null,
          published_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('post_id', postId)
        .eq('platform', platform)
        .select()
        .single();

      if (error) throw error;
      this.logger.log(`Published to ${platform} successfully: ${result.url}`);
      return data;
    } else {
      await client
        .from('blog_distributions')
        .update({
          status: 'failed',
          last_error: result.error ?? 'Unknown publishing error',
          updated_at: new Date().toISOString(),
        })
        .eq('post_id', postId)
        .eq('platform', platform);

      this.logger.warn(`Publishing to ${platform} failed: ${result.error}`);
      throw new BadRequestException(
        result.error || `Failed to publish to ${platform}`,
      );
    }
  }

  async markAsPublished(
    postId: string,
    platform: string,
    publishedUrl: string,
  ) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('blog_distributions')
      .update({
        status: 'published',
        published_url: publishedUrl,
        published_at: new Date().toISOString(),
        canonical_url: publishedUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('post_id', postId)
      .eq('platform', platform)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateDistribution(
    postId: string,
    platform: string,
    body: Record<string, any>,
  ) {
    const client = this.supabase.getServiceClient();
    const update: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.adapted_content !== undefined)
      update.adapted_content = body.adapted_content;
    if (body.status !== undefined) update.status = body.status;
    if (body.published_url !== undefined) {
      update.published_url = body.published_url;
      update.canonical_url = body.published_url;
    }
    if (body.published_at !== undefined)
      update.published_at = body.published_at;

    const { data, error } = await client
      .from('blog_distributions')
      .update(update)
      .eq('post_id', postId)
      .eq('platform', platform)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // --- Quality Scores ---

  async getScores(postId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('blog_posts')
      .select(
        'seo_score, aeo_score, geo_score, eeat_score, readability_score, quality_score',
      )
      .eq('id', postId)
      .single();

    if (error) throw new NotFoundException('Post not found');
    return data;
  }

  async calculateScores(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post } = await client
      .from('blog_posts')
      .select(
        'body, title, seo_title, seo_description, seo_keywords, tags, faq_json',
      )
      .eq('id', postId)
      .single();

    if (!post) throw new NotFoundException('Post not found');

    const body = post.body ?? '';

    const systemPrompt = `You are an expert content quality analyst. Analyze the provided article and score it across five dimensions. Be strict and realistic — most content scores between 50-85.

Respond ONLY with valid JSON matching this schema:
{
  "seo_score": number (0-100),
  "aeo_score": number (0-100),
  "geo_score": number (0-100),
  "eeat_score": number (0-100),
  "readability_score": number (0-100)
}

Scoring criteria:
- SEO Score: keyword density/placement, heading hierarchy, meta title/description quality, internal linking potential, image alt potential, URL structure
- AEO Score (Answer Engine Optimization): direct answer paragraphs, FAQ quality/quantity, definition blocks, structured lists/tables, featured-snippet readiness
- GEO Score (Generative Engine Optimization): citations/sources, unique statistics, original insights, entity coverage, claim specificity
- E-E-A-T Score: author expertise signals, experience markers, trustworthiness indicators, source citations, specificity of advice
- Readability Score: sentence length variety, vocabulary level, paragraph length, subheading frequency, use of transitions, scanability`;

    const userPrompt = `Analyze this article:

TITLE: ${post.title ?? ''}
SEO TITLE: ${post.seo_title ?? 'not set'}
SEO DESCRIPTION: ${post.seo_description ?? 'not set'}
SEO KEYWORDS: ${post.seo_keywords ?? 'not set'}
TAGS: ${(post.tags ?? []).join(', ')}
HAS FAQ: ${post.faq_json ? 'yes' : 'no'}
WORD COUNT: ${body.split(/\s+/).length}

ARTICLE BODY (first 4000 chars):
${body.slice(0, 4000)}`;

    let seo_score: number;
    let aeo_score: number;
    let geo_score: number;
    let eeat_score: number;
    let readability_score: number;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_analysis',
        temperature: 0.3,
        maxTokens: 500,
        timeoutMs: 30_000,
      });

      const parsed = this.parseAiJson(content);
      seo_score = this.clampScore(parsed.seo_score);
      aeo_score = this.clampScore(parsed.aeo_score);
      geo_score = this.clampScore(parsed.geo_score);
      eeat_score = this.clampScore(parsed.eeat_score);
      readability_score = this.clampScore(parsed.readability_score);
    } catch (error) {
      this.logger.error(
        `Score calculation failed, using heuristic fallback: ${(error as Error).message}`,
      );
      const wordCount = body.split(/\s+/).length;
      const hasHeadings = /^##\s/m.test(body);
      const hasFaq = /faq|frequently asked/i.test(body);
      const hasList = /^[-*]\s/m.test(body);
      seo_score = Math.min(
        100,
        40 +
          (post.seo_title ? 15 : 0) +
          (post.seo_description ? 15 : 0) +
          (hasHeadings ? 15 : 0) +
          (wordCount > 1000 ? 15 : 0),
      );
      aeo_score = Math.min(
        100,
        30 + (hasFaq ? 25 : 0) + (hasList ? 20 : 0) + (hasHeadings ? 25 : 0),
      );
      geo_score = Math.min(
        100,
        40 + (wordCount > 2000 ? 20 : 0) + (hasHeadings ? 20 : 0) + 20,
      );
      eeat_score = 65;
      readability_score = Math.min(
        100,
        50 + (wordCount > 500 && wordCount < 5000 ? 30 : 0) + 20,
      );
    }

    const quality_score = Math.round(
      (seo_score + aeo_score + geo_score + eeat_score + readability_score) / 5,
    );

    const { data, error } = await client
      .from('blog_posts')
      .update({
        seo_score,
        aeo_score,
        geo_score,
        eeat_score,
        readability_score,
        quality_score,
      })
      .eq('id', postId)
      .select(
        'seo_score, aeo_score, geo_score, eeat_score, readability_score, quality_score',
      )
      .single();

    if (error) throw error;
    return data;
  }

  private clampScore(val: unknown): number {
    const n = Number(val);
    if (isNaN(n)) return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // --- Internal Links ---

  async analyzeLinkOpportunities(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post } = await client
      .from('blog_posts')
      .select('id, title, slug, body, tags, seo_keywords')
      .eq('id', postId)
      .single();

    if (!post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post has no body content');

    const { data: otherPosts } = await client
      .from('blog_posts')
      .select('id, title, slug, tags, seo_keywords, excerpt')
      .eq('status', 'published')
      .neq('id', postId)
      .limit(100);

    if (!otherPosts || otherPosts.length === 0) {
      return [];
    }

    const targetPostsList = otherPosts
      .map(
        (p: any) =>
          `- Title: "${p.title}" | Slug: ${p.slug} | ID: ${p.id} | Keywords: ${p.seo_keywords || 'none'} | Tags: ${(p.tags ?? []).join(', ') || 'none'} | Excerpt: ${(p.excerpt || '').slice(0, 120)}`,
      )
      .join('\n');

    const systemPrompt = `You are an expert SEO internal linking strategist. Given an article and a list of other published posts, identify 10-20 natural internal linking opportunities.

For each opportunity, find an EXISTING phrase in the source article that could naturally be hyperlinked to a related target post. The phrase must exist verbatim in the source text.

Respond ONLY with valid JSON matching this schema:
{
  "suggestions": [
    {
      "anchor_text": "string — exact phrase from the source article to hyperlink",
      "target_post_id": "string — UUID of the target post",
      "context_sentence": "string — the full sentence containing the anchor text",
      "relevance_score": number (0-1, how natural/useful this link would be)
    }
  ]
}

Rules:
1. anchor_text MUST be an exact substring of the source article body
2. Each link should feel natural — not forced
3. Prefer anchor text that is 2-6 words (not single words, not full sentences)
4. Don't suggest linking the same target post more than twice
5. Higher relevance_score for topically relevant links with descriptive anchor text
6. Aim for 10-20 suggestions, sorted by relevance_score descending`;

    const userPrompt = `SOURCE ARTICLE:
Title: ${post.title}
Tags: ${(post.tags ?? []).join(', ')}
Keywords: ${post.seo_keywords || 'none'}

Body (first 5000 chars):
${(post.body ?? '').slice(0, 5000)}

---

AVAILABLE TARGET POSTS:
${targetPostsList}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_analysis',
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 60_000,
      });

      const parsed = this.parseAiJson(content);
      const suggestions: {
        anchor_text: string;
        target_post_id: string;
        context_sentence: string;
        relevance_score: number;
      }[] = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

      const validTargetIds = new Set(otherPosts.map((p: any) => p.id));
      const validSuggestions = suggestions.filter(
        (s) =>
          s.anchor_text &&
          validTargetIds.has(s.target_post_id) &&
          (post.body ?? '').includes(s.anchor_text),
      );

      if (validSuggestions.length === 0) {
        return [];
      }

      const rows = validSuggestions.map((s) => ({
        source_post_id: postId,
        target_post_id: s.target_post_id,
        anchor_text: s.anchor_text,
        context_sentence: s.context_sentence || null,
        relevance_score: Math.max(0, Math.min(1, s.relevance_score ?? 0)),
        status: 'suggested',
      }));

      const { data: inserted, error } = await client
        .from('internal_link_suggestions')
        .upsert(rows, {
          onConflict: 'source_post_id,target_post_id,anchor_text',
        })
        .select();

      if (error) throw error;
      return inserted ?? [];
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      )
        throw error;
      this.logger.error(
        `Internal link analysis failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to analyze link opportunities: ${error instanceof AiGatewayError ? error.message : (error as Error).message}`,
      );
    }
  }

  async getInternalLinks(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data, error } = await client
      .from('internal_link_suggestions')
      .select(
        '*, source_post:source_post_id(id, title, slug), target_post:target_post_id(id, title, slug)',
      )
      .or(`source_post_id.eq.${postId},target_post_id.eq.${postId}`)
      .order('relevance_score', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async acceptLinkSuggestion(suggestionId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('internal_link_suggestions')
      .update({ status: 'accepted' })
      .eq('id', suggestionId)
      .select()
      .single();

    if (error) throw new NotFoundException('Suggestion not found');
    return data;
  }

  async rejectLinkSuggestion(suggestionId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('internal_link_suggestions')
      .update({ status: 'rejected' })
      .eq('id', suggestionId)
      .select()
      .single();

    if (error) throw new NotFoundException('Suggestion not found');
    return data;
  }

  async insertAcceptedLinks(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: suggestions } = await client
      .from('internal_link_suggestions')
      .select('*, target_post:target_post_id(slug)')
      .eq('source_post_id', postId)
      .eq('status', 'accepted');

    if (!suggestions || suggestions.length === 0) {
      return { inserted_count: 0 };
    }

    const { data: post } = await client
      .from('blog_posts')
      .select('body')
      .eq('id', postId)
      .single();

    if (!post || !post.body)
      throw new NotFoundException('Post not found or empty');

    let body = post.body;
    let insertedCount = 0;
    const insertedIds: string[] = [];

    const sorted = [...suggestions].sort(
      (a, b) => (b.anchor_text?.length ?? 0) - (a.anchor_text?.length ?? 0),
    );

    for (const suggestion of sorted) {
      const targetSlug = suggestion.target_post?.slug;
      if (!targetSlug) continue;

      const anchor = suggestion.anchor_text;
      const link = `[${anchor}](/blog/${targetSlug})`;

      if (body.includes(anchor) && !body.includes(link)) {
        body = body.replace(anchor, link);
        insertedCount++;
        insertedIds.push(suggestion.id);
      }
    }

    if (insertedCount > 0) {
      await client.from('blog_posts').update({ body }).eq('id', postId);

      await client
        .from('internal_link_suggestions')
        .update({ status: 'inserted', inserted_at: new Date().toISOString() })
        .in('id', insertedIds);
    }

    return { inserted_count: insertedCount };
  }

  async getPostLinkStats() {
    const client = this.supabase.getServiceClient();

    const { data: allSuggestions } = await client
      .from('internal_link_suggestions')
      .select('id, status, source_post_id');

    const suggestions = allSuggestions ?? [];
    const total = suggestions.length;
    const accepted = suggestions.filter(
      (s: any) => s.status === 'accepted',
    ).length;
    const inserted = suggestions.filter(
      (s: any) => s.status === 'inserted',
    ).length;
    const rejected = suggestions.filter(
      (s: any) => s.status === 'rejected',
    ).length;

    const postsWithLinks = new Map<string, number>();
    for (const s of suggestions) {
      if ((s as any).status === 'inserted') {
        const id = (s as any).source_post_id;
        postsWithLinks.set(id, (postsWithLinks.get(id) ?? 0) + 1);
      }
    }

    const { data: publishedPosts } = await client
      .from('blog_posts')
      .select('id')
      .eq('status', 'published');

    const postsNeedingLinks = (publishedPosts ?? []).filter(
      (p: any) => (postsWithLinks.get(p.id) ?? 0) < 5,
    ).length;

    return {
      total_suggestions: total,
      accepted,
      inserted,
      rejected,
      posts_needing_links: postsNeedingLinks,
      total_published_posts: publishedPosts?.length ?? 0,
    };
  }

  // ===== IMAGE ENGINE =====

  async generateImagePlan(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const wordCount = post.body.split(/\s+/).length;
    const targetImageCount = Math.max(
      3,
      Math.min(15, Math.round(wordCount / 400)),
    );

    const headings = (post.body.match(/^#{2,3}\s+.+$/gm) || []).map(
      (h: string) => h.replace(/^#+\s+/, ''),
    );

    // Analyze content for visual opportunities
    const visualPatterns = {
      comparison:
        /\b(vs\.?|versus|compared|comparison|alternative|difference|versus)\b/i,
      chart:
        /\b(chart|graph|statistics|metrics|data|numbers|performance|results)\b/i,
      workflow:
        /\b(process|workflow|steps|how to|guide|tutorial|procedure|method)\b/i,
      market: /\b(market share|breakdown|distribution|analysis|percentage)\b/i,
      timeline: /\b(timeline|growth|trend|history|evolution|over time)\b/i,
    };

    const contentAnalysis = headings
      .map((h) => {
        const patterns: string[] = [];
        if (visualPatterns.comparison.test(h)) patterns.push('comparison');
        if (visualPatterns.chart.test(h)) patterns.push('chart');
        if (visualPatterns.workflow.test(h)) patterns.push('workflow');
        if (visualPatterns.market.test(h)) patterns.push('market');
        if (visualPatterns.timeline.test(h)) patterns.push('timeline');
        return { heading: h, patterns };
      })
      .filter((item) => item.patterns.length > 0);

    const systemPrompt = `You are a visual content strategist. Given an article's title, word count, and headings, plan image placements. Each image needs a detailed generative-AI prompt, alt text, caption, and where it belongs.

IMPORTANT: When headings suggest comparisons, charts, workflows, or data visualizations, create images for those instead of tables. Use VISUAL content types appropriately.

Image types:
- "featured": Hero/cover image (placement_after_heading: null)
- "section": General section illustration
- "infographic": Data-heavy visualizations, charts, graphs
- "comparison": Side-by-side comparisons, "vs" content
- "workflow": Process diagrams, step-by-step flows
- "chart": Bar charts, line graphs, performance metrics
- "social_preview": Social media preview image
- "og_image": Open Graph image

Respond ONLY with valid JSON matching this schema:
{
  "images": [
    {
      "image_type": "featured" | "section" | "infographic" | "comparison" | "workflow" | "chart" | "social_preview" | "og_image",
      "prompt": "detailed image generation prompt",
      "alt_text": "descriptive alt text for accessibility",
      "caption": "caption to display beneath the image",
      "placement_after_heading": "exact heading text this image should appear after (null for featured)",
      "sort_order": number
    }
  ]
}`;

    const userPrompt = `Plan ${targetImageCount} images for this article:

TITLE: ${post.title}
WORD COUNT: ${wordCount}
HEADINGS:
${headings.map((h: string, i: number) => `${i + 1}. ${h}`).join('\n')}

${
  contentAnalysis.length > 0
    ? `\nVISUAL OPPORTUNITIES DETECTED:
${contentAnalysis.map((item) => `- "${item.heading}" → Suggested types: ${item.patterns.join(', ')}`).join('\n')}
`
    : ''
}

Rules:
1. First image must be type "featured" (hero/cover image, placement_after_heading: null)
2. For headings about comparisons, vs, alternatives → use image_type "comparison" with side-by-side visual
3. For headings about charts, data, metrics, statistics → use image_type "chart" or "infographic"
4. For headings about workflows, processes, steps → use image_type "workflow" with flow diagram
5. For headings about market share, breakdown → use image_type "chart" with pie/bar chart
6. For headings about timeline, growth, trends → use image_type "chart" with line graph
7. Generate actual chart/diagram images, NOT tables or text
8. Distribute remaining images evenly across article sections
9. Prompts should be detailed and specific (style, colors, composition, subject)
10. Alt text must be descriptive and accessibility-friendly
11. Each caption should add value beyond what the image shows
12. Focus on VISUAL representations: charts beat tables, diagrams beat lists`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.7,
        maxTokens: 3000,
        timeoutMs: 45_000,
      });

      const parsed = this.parseAiJson(content);
      const images: any[] = Array.isArray(parsed.images) ? parsed.images : [];

      if (images.length === 0) {
        throw new Error('AI returned no image suggestions');
      }

      const rows = images.map((img: any, i: number) => ({
        post_id: postId,
        image_type: img.image_type || 'section',
        prompt: img.prompt || `Illustration for ${post.title}`,
        alt_text: img.alt_text || null,
        caption: img.caption || null,
        placement_after_heading: img.placement_after_heading || null,
        sort_order: img.sort_order ?? i,
        status: 'prompt_ready',
      }));

      const { data: inserted, error: insErr } = await client
        .from('post_images')
        .insert(rows)
        .select();

      if (insErr) throw insErr;
      return inserted;
    } catch (error) {
      this.logger.error(
        `Image plan generation failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to generate image plan: ${error instanceof AiGatewayError ? error.message : (error as Error).message}`,
      );
    }
  }

  async getImagePlan(postId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('post_images')
      .select('*')
      .eq('post_id', postId)
      .order('sort_order');

    if (error) throw error;
    return data ?? [];
  }

  /**
   * Ensure the blog-images storage bucket exists (idempotent)
   */
  private async ensureBlogImagesBucket(): Promise<void> {
    const client = this.supabase.getServiceClient();

    try {
      // Check if bucket exists
      const { data: buckets, error: listErr } =
        await client.storage.listBuckets();

      if (listErr) {
        this.logger.warn(`Could not list storage buckets: ${listErr.message}`);
        return;
      }

      const bucketExists = buckets?.some((b) => b.name === 'blog-images');

      if (!bucketExists) {
        this.logger.log('Creating blog-images storage bucket...');
        const { error: createErr } = await client.storage.createBucket(
          'blog-images',
          {
            public: true,
            fileSizeLimit: 10485760, // 10MB
            allowedMimeTypes: [
              'image/png',
              'image/jpeg',
              'image/jpg',
              'image/webp',
            ],
          },
        );

        if (createErr) {
          this.logger.error(
            `Failed to create blog-images bucket: ${createErr.message}`,
          );
        } else {
          this.logger.log('blog-images bucket created successfully');
        }
      }
    } catch (err) {
      this.logger.warn(
        `ensureBlogImagesBucket failed: ${(err as Error).message}`,
      );
    }
  }

  async generateImage(imageId: string) {
    const client = this.supabase.getServiceClient();

    // Ensure bucket exists before attempting upload
    await this.ensureBlogImagesBucket();

    const { data: img, error: imgErr } = await client
      .from('post_images')
      .select('*')
      .eq('id', imageId)
      .single();

    if (imgErr || !img) throw new NotFoundException('Image record not found');

    await client
      .from('post_images')
      .update({ status: 'generating', updated_at: new Date().toISOString() })
      .eq('id', imageId);

    try {
      const { b64 } = await this.aiGateway.generateImageB64({
        prompt: img.prompt,
        size: '1024x1024',
        quality: 'standard',
        timeoutMs: 120_000,
      });

      const rawBuffer = Buffer.from(b64, 'base64');
      // Strip C2PA/EXIF metadata to prevent LinkedIn "cr" badge detection
      const buffer = await this.stripAiMetadata(rawBuffer);
      const filename = `post-images/${img.post_id}/${imageId}.png`;

      const { error: uploadErr } = await client.storage
        .from('blog-images')
        .upload(filename, buffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadErr) {
        throw new Error(
          `Storage upload failed: ${uploadErr.message}. ` +
            `Ensure the 'blog-images' bucket exists in Supabase Storage with public access.`,
        );
      }

      const { data: publicUrlData } = client.storage
        .from('blog-images')
        .getPublicUrl(filename);

      const imageUrl = publicUrlData.publicUrl;

      const { data: updated, error: updErr } = await client
        .from('post_images')
        .update({
          image_url: imageUrl,
          status: 'generated',
          updated_at: new Date().toISOString(),
        })
        .eq('id', imageId)
        .select()
        .single();

      if (updErr) throw updErr;
      return updated;
    } catch (error) {
      await client
        .from('post_images')
        .update({
          status: 'prompt_ready',
          updated_at: new Date().toISOString(),
        })
        .eq('id', imageId);

      this.logger.error(`Image generation failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to generate image: ${error instanceof AiGatewayError ? error.message : (error as Error).message}`,
      );
    }
  }

  async approveImage(imageId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('post_images')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', imageId)
      .select()
      .single();

    if (error) throw new NotFoundException('Image not found');
    return data;
  }

  async rejectImage(imageId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('post_images')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', imageId)
      .select()
      .single();

    if (error) throw new NotFoundException('Image not found');
    return data;
  }

  async insertImagesIntoPost(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: images } = await client
      .from('post_images')
      .select('*')
      .eq('post_id', postId)
      .eq('status', 'approved')
      .not('image_url', 'is', null)
      .order('sort_order');

    if (!images || images.length === 0) {
      throw new BadRequestException('No approved images with URLs to insert');
    }

    const { data: post } = await client
      .from('blog_posts')
      .select('body')
      .eq('id', postId)
      .single();

    if (!post?.body) throw new NotFoundException('Post body not found');

    let body = post.body;
    let insertedCount = 0;

    for (const img of images) {
      const mdImage = `\n\n![${img.alt_text || img.caption || ''}](${img.image_url})${img.caption ? `\n*${img.caption}*` : ''}\n`;

      if (img.image_type === 'featured' || !img.placement_after_heading) {
        body = mdImage + '\n' + body;
        insertedCount++;
        continue;
      }

      const headingPattern = new RegExp(
        `(^#{2,3}\\s+${img.placement_after_heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$)`,
        'm',
      );
      const match = body.match(headingPattern);
      if (match && match.index !== undefined) {
        const afterHeading = match.index + match[0].length;
        body = body.slice(0, afterHeading) + mdImage + body.slice(afterHeading);
        insertedCount++;
      }
    }

    if (insertedCount > 0) {
      await client
        .from('blog_posts')
        .update({ body, updated_at: new Date().toISOString() })
        .eq('id', postId);
    }

    return { inserted: insertedCount, total_approved: images.length };
  }

  // ===== SCHEMA ENGINE =====

  async generateSchemas(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select(
        'id, title, slug, body, tags, seo_keywords, seo_description, faq_json, author_display_name, author_bio, canonical_url, featured_image_url, created_at, updated_at',
      )
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');

    const schemas: Record<string, any> = {};
    const canonicalUrl =
      post.canonical_url || `https://trndinn.com/blog/${post.slug}`;

    schemas.article = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title,
      description: post.seo_description || '',
      author: {
        '@type': 'Person',
        name: post.author_display_name || 'Trndinn Team',
      },
      datePublished: post.created_at,
      dateModified: post.updated_at,
      publisher: { '@type': 'Organization', name: 'Trndinn' },
      mainEntityOfPage: canonicalUrl,
      image: post.featured_image_url || undefined,
    };

    const faqItems = Array.isArray(post.faq_json) ? post.faq_json : [];
    if (faqItems.length > 0) {
      schemas.faq = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqItems.map((item: any) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: { '@type': 'Answer', text: item.answer },
        })),
      };
    }

    schemas.breadcrumb = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Home',
          item: 'https://trndinn.com',
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Blog',
          item: 'https://trndinn.com/blog',
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: post.title,
          item: canonicalUrl,
        },
      ],
    };

    schemas.organization = {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Trndinn',
      url: 'https://trndinn.com',
      logo: 'https://trndinn.com/logo.png',
      sameAs: [
        'https://linkedin.com/company/trndinn',
        'https://twitter.com/trndinn',
      ],
    };

    const body = post.body || '';
    const stepPattern = /^#{2,3}\s+(step\s+\d+|#?\d+[\.\):])/im;
    if (stepPattern.test(body)) {
      const stepMatches = body.match(/^#{2,3}\s+(.+)$/gm) || [];
      const steps = stepMatches
        .filter((h: string) => /step\s+\d+|\d+[\.\):]/i.test(h))
        .map((h: string) => {
          const name = h
            .replace(/^#+\s+/, '')
            .replace(/^(step\s+)?\d+[\.\):\s]*/i, '')
            .trim();
          return { '@type': 'HowToStep' as const, name, text: name };
        });

      if (steps.length >= 2) {
        schemas.howTo = {
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: post.title,
          step: steps,
        };
      }
    }

    const isTrndinnPost =
      /trndinn|our (platform|tool|app)/i.test(body) &&
      /feature|pricing|how.to.use/i.test(body);
    if (isTrndinnPost) {
      schemas.softwareApplication = {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Trndinn',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
      };
    }

    const { error: updErr } = await client
      .from('blog_posts')
      .update({ json_ld_schemas: schemas })
      .eq('id', postId);

    if (updErr) throw updErr;

    return schemas;
  }

  async getSchemas(postId: string) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('blog_posts')
      .select('json_ld_schemas')
      .eq('id', postId)
      .single();

    if (error) throw new NotFoundException('Post not found');
    return data?.json_ld_schemas || {};
  }

  async regenerateSchemas(postId: string) {
    return this.generateSchemas(postId);
  }

  // ===== AEO & GEO ENGINE =====

  async analyzeAEO(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, faq_json')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const systemPrompt = `You are an expert in Answer Engine Optimization (AEO). Analyze how well the article is optimized for AI assistants (ChatGPT, Perplexity, Claude, Gemini) to extract and cite answers from it.

Score each criterion 0-10 and provide a brief explanation for each.

Respond ONLY with valid JSON matching this schema:
{
  "overall_score": number (0-100),
  "criteria_scores": [
    { "criterion": "string", "score": number (0-10), "explanation": "string" }
  ],
  "suggestions": [
    { "type": "string", "description": "string", "priority": "high" | "medium" | "low" }
  ]
}

Criteria to evaluate:
1. Direct Answer (first 100 words directly answer the primary question)
2. Clear Definitions (uses "X is..." or "X refers to..." patterns)
3. Structured Lists (bulleted/numbered lists for scannable info)
4. Tables (comparison data in table format)
5. Short Paragraphs (< 3 sentences per paragraph)
6. FAQ Quality (direct Q&A with concise answers)
7. TL;DR / Key Takeaways (summary section at top or bottom)
8. Statistics with Sources (cited data points)
9. Step-by-Step Instructions (numbered how-to steps)`;

    const faqInfo = Array.isArray(post.faq_json)
      ? `\nFAQ COUNT: ${post.faq_json.length}`
      : '\nFAQ: None';

    const userPrompt = `Analyze this article for AEO optimization:

TITLE: ${post.title}
WORD COUNT: ${(post.body ?? '').split(/\s+/).length}${faqInfo}

ARTICLE BODY (first 5000 chars):
${(post.body ?? '').slice(0, 5000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_analysis',
        temperature: 0.3,
        maxTokens: 3000,
        timeoutMs: 45_000,
      });

      const parsed = this.parseAiJson(content);
      const overallScore = this.clampScore(parsed.overall_score);

      await client
        .from('blog_posts')
        .update({ aeo_score: overallScore })
        .eq('id', postId);

      return {
        overall_score: overallScore,
        criteria_scores: Array.isArray(parsed.criteria_scores)
          ? parsed.criteria_scores
          : [],
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [],
      };
    } catch (error) {
      this.logger.error(`AEO analysis failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to analyze AEO: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async analyzeGEO(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, author_display_name, author_bio')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const systemPrompt = `You are an expert in Generative Engine Optimization (GEO). Analyze how well this article is optimized for AI systems (ChatGPT, Perplexity, Claude, Gemini) to cite it as an authoritative source.

Score each criterion 0-10 and provide a brief explanation for each.

Respond ONLY with valid JSON matching this schema:
{
  "overall_score": number (0-100),
  "criteria_scores": [
    { "criterion": "string", "score": number (0-10), "explanation": "string" }
  ],
  "suggestions": [
    { "type": "string", "description": "string", "priority": "high" | "medium" | "low" }
  ]
}

Criteria to evaluate:
1. Unique Insights (original data or perspectives not found elsewhere)
2. Named Frameworks (original methodologies or coined concepts)
3. Cited Statistics (data points with sources/links)
4. Research References (academic or industry research citations)
5. Entity Coverage (clear subject-predicate-object statements)
6. Quotable Statements (concise, authoritative, citable sentences)
7. Structured Data (tables, data-rich lists)
8. Author Expertise Signals (credentials, experience mentioned)
9. Freshness (recent dates, current references)`;

    const authorInfo = post.author_display_name
      ? `\nAUTHOR: ${post.author_display_name}${post.author_bio ? ` — ${post.author_bio}` : ''}`
      : '';

    const userPrompt = `Analyze this article for GEO optimization:

TITLE: ${post.title}
WORD COUNT: ${(post.body ?? '').split(/\s+/).length}${authorInfo}

ARTICLE BODY (first 5000 chars):
${(post.body ?? '').slice(0, 5000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_analysis',
        temperature: 0.3,
        maxTokens: 3000,
        timeoutMs: 45_000,
      });

      const parsed = this.parseAiJson(content);
      const overallScore = this.clampScore(parsed.overall_score);

      await client
        .from('blog_posts')
        .update({ geo_score: overallScore })
        .eq('id', postId);

      return {
        overall_score: overallScore,
        criteria_scores: Array.isArray(parsed.criteria_scores)
          ? parsed.criteria_scores
          : [],
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [],
      };
    } catch (error) {
      this.logger.error(`GEO analysis failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to analyze GEO: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async optimizeForAEO(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, faq_json')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const systemPrompt = `You are an expert AEO (Answer Engine Optimization) content editor. Your task is to rewrite/enhance the given article so AI assistants (ChatGPT, Perplexity, Claude, Gemini) can easily extract answers from it.

Apply these optimizations:
1. Add a direct, concise answer to the primary question in the first 100 words
2. Add "X is..." or "X refers to..." definition patterns for key terms
3. Convert appropriate paragraphs to bulleted or numbered lists
4. Add comparison tables where relevant
5. Ensure all paragraphs are under 3 sentences
6. Improve FAQ answers to be more direct and concise
7. Add a "Key Takeaways" or "TL;DR" section at the top
8. Ensure statistics have source attributions
9. Structure how-to content as numbered step-by-step instructions

IMPORTANT: Return the FULL optimized article body in Markdown format. Preserve the original's factual content, tone, and structure where possible — only enhance for AEO.

Respond ONLY with valid JSON:
{
  "optimized_body": "string — full optimized article in Markdown",
  "changes_made": ["string — list of specific changes applied"]
}`;

    const userPrompt = `Optimize this article for AEO:

TITLE: ${post.title}
FAQ: ${JSON.stringify(post.faq_json ?? [])}

ARTICLE BODY:
${(post.body ?? '').slice(0, 8000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.5,
        maxTokens: 8000,
        timeoutMs: 90_000,
      });

      const parsed = this.parseAiJson(content);
      return {
        optimized_body: parsed.optimized_body || post.body,
        changes_made: Array.isArray(parsed.changes_made)
          ? parsed.changes_made
          : [],
        original_body: post.body,
      };
    } catch (error) {
      this.logger.error(`AEO optimization failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to optimize for AEO: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async optimizeForGEO(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, author_display_name')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const systemPrompt = `You are an expert GEO (Generative Engine Optimization) content editor. Your task is to rewrite/enhance the article so AI systems (ChatGPT, Perplexity, Claude, Gemini) will cite it as an authoritative source.

Apply these optimizations:
1. Add named frameworks or methodologies (e.g., "The 5-Step Content Growth Framework")
2. Add specific statistics with source attributions (use placeholders like [Source: Industry Report 2026] if needed)
3. Add original insights and unique perspectives
4. Include expert quotes with attribution
5. Create entity-rich statements (clear subject-predicate-object format: "X does Y for Z")
6. Add quotable, authoritative sentences that AI would want to cite
7. Reference recent research, events, or data (2025-2026)
8. Add structured data (tables, data-rich lists)
9. Include author expertise signals where natural

IMPORTANT: Return the FULL optimized article body in Markdown format. Preserve the original's factual content and structure — only enhance for GEO.

Respond ONLY with valid JSON:
{
  "optimized_body": "string — full optimized article in Markdown",
  "changes_made": ["string — list of specific changes applied"]
}`;

    const userPrompt = `Optimize this article for GEO:

TITLE: ${post.title}
AUTHOR: ${post.author_display_name || 'Not specified'}

ARTICLE BODY:
${(post.body ?? '').slice(0, 8000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_generation',
        temperature: 0.5,
        maxTokens: 8000,
        timeoutMs: 90_000,
      });

      const parsed = this.parseAiJson(content);
      return {
        optimized_body: parsed.optimized_body || post.body,
        changes_made: Array.isArray(parsed.changes_made)
          ? parsed.changes_made
          : [],
        original_body: post.body,
      };
    } catch (error) {
      this.logger.error(`GEO optimization failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to optimize for GEO: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async applyAEOOptimization(postId: string, optimizedBody: string) {
    const client = this.supabase.getServiceClient();

    const { error } = await client
      .from('blog_posts')
      .update({ body: optimizedBody, updated_at: new Date().toISOString() })
      .eq('id', postId);

    if (error) throw error;
    return { success: true, post_id: postId };
  }

  async applyGEOOptimization(postId: string, optimizedBody: string) {
    const client = this.supabase.getServiceClient();

    const { error } = await client
      .from('blog_posts')
      .update({ body: optimizedBody, updated_at: new Date().toISOString() })
      .eq('id', postId);

    if (error) throw error;
    return { success: true, post_id: postId };
  }

  // ===== SEO ANALYSIS (dedicated, like AEO/GEO) =====

  async analyzeSEO(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, seo_title, seo_description, seo_keywords, tags')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const systemPrompt = `You are an expert in Search Engine Optimization (SEO). Analyze how well this article is optimized for traditional search engines (Google, Bing).

Score each criterion 0-10 and provide a brief explanation for each.

Respond ONLY with valid JSON matching this schema:
{
  "overall_score": number (0-100),
  "criteria_scores": [
    { "criterion": "string", "score": number (0-10), "explanation": "string" }
  ],
  "suggestions": [
    { "type": "string", "description": "string", "priority": "high" | "medium" | "low" }
  ]
}

Criteria to evaluate:
1. Title Tag & Meta Description (compelling, keyword-rich, correct length)
2. Heading Hierarchy (proper H1/H2/H3 usage, keywords in headings)
3. Keyword Optimization (natural placement, density, LSI/related terms)
4. Content Length & Depth (comprehensive coverage, 1500+ words)
5. Internal/External Linking (contextual links, authority sources)
6. Readability & Formatting (short paragraphs, bullet points, scannable)
7. Image Optimization Potential (alt text opportunities, media richness)
8. URL & Structure (clean slug, logical content flow)
9. E-E-A-T Signals (expertise, experience, authority, trustworthiness)`;

    const userPrompt = `Analyze this article for SEO optimization:

TITLE: ${post.title}
SEO TITLE: ${post.seo_title ?? 'not set'}
SEO DESCRIPTION: ${post.seo_description ?? 'not set'}
SEO KEYWORDS: ${post.seo_keywords ?? 'not set'}
TAGS: ${(post.tags ?? []).join(', ')}
WORD COUNT: ${(post.body ?? '').split(/\s+/).length}

ARTICLE BODY (first 5000 chars):
${(post.body ?? '').slice(0, 5000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_analysis',
        temperature: 0.3,
        maxTokens: 3000,
        timeoutMs: 45_000,
      });

      const parsed = this.parseAiJson(content);
      const overallScore = this.clampScore(parsed.overall_score);

      await client
        .from('blog_posts')
        .update({ seo_score: overallScore })
        .eq('id', postId);

      return {
        overall_score: overallScore,
        criteria_scores: Array.isArray(parsed.criteria_scores)
          ? parsed.criteria_scores
          : [],
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [],
      };
    } catch (error) {
      this.logger.error(`SEO analysis failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to analyze SEO: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  // ===== OPTIMIZED VERSIONS GENERATION (full article rewrites) =====

  async generateOptimizedVersions(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, faq_json, seo_keywords, author_display_name, author_bio, seo_title, seo_description, tags')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    this.logger.log(`Generating optimized versions for post ${postId} (${post.body.length} chars)`);

    const [aeoAnalysis, geoAnalysis, seoAnalysis] = await Promise.all([
      this.analyzeAEO(postId),
      this.analyzeGEO(postId),
      this.analyzeSEO(postId),
    ]);

    const currentScores = {
      aeo: aeoAnalysis.overall_score,
      geo: geoAnalysis.overall_score,
      seo: seoAnalysis.overall_score,
      criteria: {
        aeo: aeoAnalysis.criteria_scores,
        geo: geoAnalysis.criteria_scores,
        seo: seoAnalysis.criteria_scores,
      },
    };

    const lowScoringAEO = aeoAnalysis.criteria_scores.filter((c: any) => c.score < 8);
    const lowScoringGEO = geoAnalysis.criteria_scores.filter((c: any) => c.score < 8);
    const lowScoringSEO = seoAnalysis.criteria_scores.filter((c: any) => c.score < 8);

    const veryLowAEO = aeoAnalysis.criteria_scores.filter((c: any) => c.score < 6);
    const veryLowGEO = geoAnalysis.criteria_scores.filter((c: any) => c.score < 6);
    const veryLowSEO = seoAnalysis.criteria_scores.filter((c: any) => c.score < 6);

    const articleBody = post.body ?? '';

    const [variantAResult, variantBResult] = await Promise.allSettled([
      this.generateVariant(
        post,
        articleBody,
        'conservative',
        veryLowAEO.length > 0 ? veryLowAEO : lowScoringAEO.slice(0, 3),
        veryLowGEO.length > 0 ? veryLowGEO : lowScoringGEO.slice(0, 3),
        veryLowSEO.length > 0 ? veryLowSEO : lowScoringSEO.slice(0, 3),
        currentScores,
      ),
      this.generateVariant(
        post,
        articleBody,
        'aggressive',
        lowScoringAEO,
        lowScoringGEO,
        lowScoringSEO,
        currentScores,
      ),
    ]);

    const variantA = variantAResult.status === 'fulfilled' ? variantAResult.value : null;
    const variantB = variantBResult.status === 'fulfilled' ? variantBResult.value : null;

    if (!variantA && !variantB) {
      const errA = variantAResult.status === 'rejected' ? variantAResult.reason?.message : '';
      const errB = variantBResult.status === 'rejected' ? variantBResult.reason?.message : '';
      throw new BadRequestException(
        `Both variants failed. Conservative: ${errA}. Aggressive: ${errB}`,
      );
    }

    if (!variantA) {
      this.logger.warn(`Conservative variant failed, returning aggressive only`);
    }
    if (!variantB) {
      this.logger.warn(`Aggressive variant failed, returning conservative only`);
    }

    return {
      currentScores,
      variantA,
      variantB,
    };
  }

  private async generateVariant(
    post: any,
    articleBody: string,
    mode: 'conservative' | 'aggressive',
    aeoIssues: any[],
    geoIssues: any[],
    seoIssues: any[],
    currentScores: any,
  ) {
    const modeDescription =
      mode === 'conservative'
        ? 'Make MINIMAL changes. Only fix the most critical issues (scoring < 6). Preserve the author\'s voice, structure, and style as much as possible. Only add/modify specific sections that directly address the worst-scoring criteria.'
        : 'Perform a COMPREHENSIVE optimization. Improve all sections scoring below 9. You may restructure paragraphs, add new sections, expand content, and rewrite for maximum clarity and AI-extractability. Still maintain the author\'s core voice and key arguments.';

    const issuesList = [
      ...aeoIssues.map((c: any) => `[AEO] ${c.criterion}: ${c.score}/10 — ${c.explanation}`),
      ...geoIssues.map((c: any) => `[GEO] ${c.criterion}: ${c.score}/10 — ${c.explanation}`),
      ...seoIssues.map((c: any) => `[SEO] ${c.criterion}: ${c.score}/10 — ${c.explanation}`),
    ].join('\n');

    const isLargeArticle = articleBody.length > 10000;

    // Step 1: Generate the rewritten article as plain markdown (no JSON wrapper)
    const rewriteSystemPrompt = `You are a world-class content optimization specialist. Your task is to rewrite a blog post to maximize its AEO, GEO, and SEO scores.

MODE: ${mode === 'conservative' ? 'CONSERVATIVE (minimal changes)' : 'AGGRESSIVE (comprehensive rewrite)'}

${modeDescription}

OPTIMIZATION PRINCIPLES:
- Direct answers within first 100 words
- Explicit definitions using "X is..." patterns
- Structured lists and tables for extractability
- FAQ sections with concise Q&A format
- Step-by-step numbered instructions where applicable
- Statistics with cited sources (use [Source] placeholders)
- Short paragraphs (< 3 sentences each)
- Clear heading hierarchy (H2, H3)
- Quotable, authoritative statements
- Named frameworks or methodologies where relevant
- Entity-rich sentences (subject-predicate-object)
- Author expertise signals

CRITICAL RULES:
1. Output ONLY the rewritten blog post in markdown format — NO JSON, NO code blocks, NO preamble
2. Keep ALL the original information — do not remove facts or arguments
3. The output must be a full article ready to publish, NOT a summary or list of changes
4. Maintain the same markdown formatting style
5. If the article is already strong in an area, don't change it unnecessarily
${isLargeArticle ? '6. The article is very long. Focus improvements on the sections that directly address the listed issues. Sections that already score well should be kept mostly as-is.' : ''}

Output the rewritten article starting immediately with the content. No wrapper, no explanation.`;

    const inputBody = isLargeArticle ? this.truncateForVariant(articleBody, mode) : articleBody;

    const rewriteUserPrompt = `Rewrite this blog post (${mode} mode).

TITLE: ${post.title}
CURRENT SCORES: AEO ${currentScores.aeo}/100, GEO ${currentScores.geo}/100, SEO ${currentScores.seo}/100

ISSUES TO FIX:
${issuesList || 'No major issues — polish for maximum scores.'}

ORIGINAL ARTICLE:
${inputBody}`;

    try {
      // Step 1: Get the rewritten content as plain text (no JSON)
      const { content: rewrittenContent } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: rewriteSystemPrompt },
          { role: 'user', content: rewriteUserPrompt },
        ],
        jsonObject: false,
        category: 'seo_generation',
        temperature: mode === 'conservative' ? 0.4 : 0.6,
        maxTokens: isLargeArticle ? 16000 : 12000,
        timeoutMs: 300_000,
      });

      if (!rewrittenContent || rewrittenContent.trim().length < 100) {
        throw new Error('AI returned empty or too-short content');
      }

      // Step 2: Get score predictions + change summary (small JSON call)
      let predicted_scores = {
        aeo: Math.min(100, currentScores.aeo + (mode === 'aggressive' ? 15 : 8)),
        geo: Math.min(100, currentScores.geo + (mode === 'aggressive' ? 15 : 8)),
        seo: Math.min(100, currentScores.seo + (mode === 'aggressive' ? 15 : 8)),
      };
      let changes_summary: string[] = ['Optimized for AI extractability'];

      try {
        const { content: metaContent } = await this.aiGateway.chatCompletionRaw({
          messages: [
            {
              role: 'system',
              content: `You are a content analysis assistant. Given the original and rewritten article details, predict the new scores and summarize key changes. Respond ONLY with valid JSON matching: { "predicted_scores": { "aeo": number, "geo": number, "seo": number }, "changes_summary": ["string"] }. Scores are 0-100.`,
            },
            {
              role: 'user',
              content: `Original scores: AEO ${currentScores.aeo}, GEO ${currentScores.geo}, SEO ${currentScores.seo}.
Mode: ${mode}.
Issues addressed: ${issuesList.slice(0, 1500)}
Rewritten article length: ${rewrittenContent.length} chars (original: ${articleBody.length} chars).
First 500 chars of rewrite: ${rewrittenContent.slice(0, 500)}`,
            },
          ],
          jsonObject: true,
          category: 'seo_analysis',
          temperature: 0.3,
          maxTokens: 500,
          timeoutMs: 30_000,
        });

        const meta = this.parseAiJson(metaContent);
        if (meta.predicted_scores) {
          predicted_scores = {
            aeo: this.clampScore(meta.predicted_scores.aeo),
            geo: this.clampScore(meta.predicted_scores.geo),
            seo: this.clampScore(meta.predicted_scores.seo),
          };
        }
        if (Array.isArray(meta.changes_summary) && meta.changes_summary.length > 0) {
          changes_summary = meta.changes_summary;
        }
      } catch (metaErr) {
        this.logger.warn(`Score prediction for ${mode} variant failed, using estimates: ${(metaErr as Error).message}`);
      }

      return {
        mode,
        label: mode === 'conservative' ? 'Version A — Conservative' : 'Version B — Comprehensive',
        content: rewrittenContent.trim(),
        predicted_scores,
        changes_summary,
      };
    } catch (error) {
      this.logger.error(`Variant generation (${mode}) failed: ${(error as Error).message}`);
      throw new Error(
        `Failed to generate ${mode} variant: ${error instanceof AiGatewayError ? error.message : (error as Error).message || 'AI service unavailable'}`,
      );
    }
  }

  /**
   * For large articles, intelligently truncate input to stay within model context limits.
   * Conservative mode gets a tighter budget since it changes less.
   */
  private truncateForVariant(body: string, mode: 'conservative' | 'aggressive'): string {
    const maxChars = mode === 'conservative' ? 15000 : 20000;
    if (body.length <= maxChars) return body;

    const sections = body.split(/(?=^## )/m);
    if (sections.length <= 2) {
      return body.slice(0, maxChars) + '\n\n[... article continues, maintain similar style and structure for remaining sections ...]';
    }

    // Keep intro + first sections + last section, trim middle if needed
    let result = '';
    const intro = sections[0];
    const lastSection = sections[sections.length - 1];
    result = intro;

    for (let i = 1; i < sections.length - 1; i++) {
      if ((result + sections[i] + lastSection).length > maxChars) {
        result += `\n\n[... ${sections.length - 1 - i} middle sections omitted for brevity — keep their existing content unchanged ...]\n\n`;
        break;
      }
      result += sections[i];
    }
    result += lastSection;
    return result.slice(0, maxChars + 500);
  }

  async applyOptimizedVersion(postId: string, content: string) {
    const client = this.supabase.getServiceClient();

    if (!content || content.trim().length < 100) {
      throw new BadRequestException('Content is too short to be a valid blog post');
    }

    const { error } = await client
      .from('blog_posts')
      .update({ body: content, updated_at: new Date().toISOString() })
      .eq('id', postId);

    if (error) throw error;
    return { success: true, post_id: postId };
  }

  async generateAEOImprovements(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, faq_json, seo_keywords')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    // First, analyze to get criteria scores
    const analysis = await this.analyzeAEO(postId);
    
    const articleBody = post.body ?? '';
    const CHUNK_SIZE = 5000; // chars per chunk
    const LARGE_ARTICLE_THRESHOLD = 4000; // if article > 4000 chars, use batching

    // Decide whether to use batching
    const useBatching = articleBody.length > LARGE_ARTICLE_THRESHOLD;

    if (useBatching) {
      this.logger.log(`Large article detected (${articleBody.length} chars), using batched generation`);
      return this.generateAEOImprovementsBatched(post, articleBody, analysis.criteria_scores);
    } else {
      this.logger.log(`Standard article size (${articleBody.length} chars), single generation`);
      return this.generateAEOImprovementsSingle(post, articleBody, analysis.criteria_scores);
    }
  }

  private async generateAEOImprovementsSingle(
    post: any,
    articleBody: string,
    criteriaScores: any[],
  ) {
    // Filter to only include low-scoring criteria (< 8/10)
    const SCORE_THRESHOLD = 8;
    const lowScoringCriteria = criteriaScores.filter((c: any) => c.score < SCORE_THRESHOLD);
    
    if (lowScoringCriteria.length === 0) {
      this.logger.log('No low-scoring criteria found - article is well optimized');
      return {
        tldr: '',
        key_takeaways: [],
        additional_faqs: [],
        definitions: [],
        direct_answer: '',
        tables: [],
        statistics: [],
        step_by_step: null,
        examples: [],
        schema_markup: '',
      };
    }

    // Map criteria names to improvement types
    const criteriaToImprovementMap: Record<string, string[]> = {
      'Direct Answer': ['direct_answer'],
      'Clear Definitions': ['definitions'],
      'Structured Lists': ['key_takeaways'],
      'Tables': ['tables'],
      'Short Paragraphs': [], // This is about formatting, not new content
      'FAQ Quality': ['additional_faqs'],
      'TL;DR / Key Takeaways': ['tldr', 'key_takeaways'],
      'Statistics with Sources': ['statistics'],
      'Step-by-Step Instructions': ['step_by_step'],
    };

    // Determine which improvement types to generate
    const improvementTypesToGenerate = new Set<string>();
    lowScoringCriteria.forEach((c: any) => {
      const types = criteriaToImprovementMap[c.criterion] || [];
      types.forEach(type => improvementTypesToGenerate.add(type));
    });

    // Build focused instructions
    const focusedInstructions = lowScoringCriteria
      .map((c: any) => `- ${c.criterion} (current score: ${c.score}/10): ${c.explanation}`)
      .join('\n');

    const systemPrompt = `You are an expert AEO (Answer Engine Optimization) content specialist. Generate specific content additions that will make this article more likely to be cited by AI assistants (ChatGPT, Perplexity, Claude, Gemini).

IMPORTANT: Only generate improvements for the LOW-SCORING criteria listed below. DO NOT generate improvements for criteria that are already performing well (8/10 or higher).

LOW-SCORING CRITERIA TO ADDRESS:
${focusedInstructions}

CRITICAL: You MUST return ONLY valid, complete JSON. Do not truncate the response. Ensure all strings are properly closed and all objects/arrays are properly terminated.

Respond ONLY with valid JSON matching this schema:
{
  "tldr": "string — 2-3 sentence summary (only if TL;DR/Key Takeaways scored low)",
  "key_takeaways": ["string array — 5-7 bullet points (only if Structured Lists or TL;DR scored low)"],
  "additional_faqs": [{ "question": "string", "answer": "string" } (only if FAQ Quality scored low)],
  "definitions": [{ "term": "string", "definition": "string — starts with 'X is...' or 'X refers to...'" } (only if Clear Definitions scored low)],
  "direct_answer": "string — concise answer to the primary question (only if Direct Answer scored low)",
  "tables": [{ "title": "string — table heading", "markdown": "string — full markdown table with | headers | and | rows |" } (only if Tables scored low)],
  "statistics": [{ "stat": "string — the data point", "context": "string — where to use it", "source_placeholder": "string — suggested source like [Source: Industry Report 2026]" } (only if Statistics scored low)],
  "step_by_step": { "title": "string — process name", "steps": ["string array — numbered instructions"] } (only if Step-by-Step scored low),
  "examples": [{ "title": "string — example heading", "content": "string — the example content" }],
  "schema_markup": "string — complete JSON-LD schema code as a string (for Article, HowTo, FAQPage, etc.)"
}

NOTE: Return empty strings or empty arrays for improvement types NOT needed based on the scoring.`;

    const existingFaqs = Array.isArray(post.faq_json) ? post.faq_json : [];
    const userPrompt = `Generate AEO improvements for this article:

TITLE: ${post.title}
KEYWORDS: ${post.seo_keywords || 'not specified'}
EXISTING FAQ COUNT: ${existingFaqs.length}

FULL ARTICLE BODY:
${articleBody}

Requirements:
1. TL;DR should be immediately useful — someone reading only this should understand the core value
2. Key Takeaways should be actionable and specific, not generic
3. FAQs should address questions NOT already covered in existing FAQs
4. Definitions should explain technical terms or concepts mentioned in the article
5. Direct answer should be quotable by AI assistants
6. Tables should use proper markdown format with headers and alignment (e.g., | Header 1 | Header 2 |)
7. Statistics should include realistic placeholder sources like [Source: Industry Survey 2026]
8. Step-by-Step should break down any process/workflow mentioned in the article
9. Examples should provide concrete before/after scenarios or case studies
10. Schema markup should be valid JSON-LD (Article, HowTo, or FAQPage type)

CRITICAL: Keep responses concise but comprehensive. Return complete, valid JSON with all strings properly terminated.`;

    // Retry logic with exponential backoff
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { content } = await this.aiGateway.chatCompletionRaw({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          jsonObject: true,
          category: 'seo_generation',
          temperature: 0.6,
          maxTokens: 8000,
          timeoutMs: 150_000,
        });

        const parsed = this.parseAiJson(content);
        return {
          tldr: parsed.tldr || '',
          key_takeaways: Array.isArray(parsed.key_takeaways)
            ? parsed.key_takeaways
            : [],
          additional_faqs: Array.isArray(parsed.additional_faqs)
            ? parsed.additional_faqs
            : [],
          definitions: Array.isArray(parsed.definitions)
            ? parsed.definitions
            : [],
          direct_answer: parsed.direct_answer || '',
          tables: Array.isArray(parsed.tables) ? parsed.tables : [],
          statistics: Array.isArray(parsed.statistics) ? parsed.statistics : [],
          step_by_step: parsed.step_by_step || null,
          examples: Array.isArray(parsed.examples) ? parsed.examples : [],
          schema_markup: parsed.schema_markup || '',
        };
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `AEO improvements generation attempt ${attempt} failed: ${lastError.message}`,
        );

        if (attempt === maxRetries) break;

        const backoffMs = Math.pow(2, attempt) * 1000;
        this.logger.log(`Retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    this.logger.error(
      `AEO improvements generation failed after ${maxRetries} attempts: ${lastError?.message}`,
    );
    throw new BadRequestException(
      `Failed to generate AEO improvements: ${lastError instanceof AiGatewayError ? lastError.message : 'AI service unavailable'}`,
    );
  }

  private async generateAEOImprovementsBatched(
    post: any,
    articleBody: string,
    criteriaScores: any[],
  ) {
    // Filter to only include low-scoring criteria (< 8/10)
    const SCORE_THRESHOLD = 8;
    const lowScoringCriteria = criteriaScores.filter((c: any) => c.score < SCORE_THRESHOLD);
    
    if (lowScoringCriteria.length === 0) {
      this.logger.log('No low-scoring criteria found - article is well optimized');
      return {
        tldr: '',
        key_takeaways: [],
        additional_faqs: [],
        definitions: [],
        direct_answer: '',
        tables: [],
        statistics: [],
        step_by_step: null,
        examples: [],
        schema_markup: '',
      };
    }

    // Build focused instructions
    const focusedInstructions = lowScoringCriteria
      .map((c: any) => `- ${c.criterion} (score: ${c.score}/10): ${c.explanation}`)
      .join('\n');

    const CHUNK_SIZE = 5000;
    const chunks: string[] = [];
    
    // Split article into chunks
    for (let i = 0; i < articleBody.length; i += CHUNK_SIZE) {
      chunks.push(articleBody.slice(i, i + CHUNK_SIZE));
    }

    this.logger.log(`Generating AEO improvements for ${chunks.length} batches`);

    const systemPrompt = `You are an expert AEO (Answer Engine Optimization) content specialist. Generate specific content additions for THIS SECTION of a larger article.

IMPORTANT: Focus ONLY on these LOW-SCORING areas that need improvement:
${focusedInstructions}

Generate improvements for this section ONLY if they address the low-scoring criteria above:
1. Key Takeaways (3-5 bullet points from this section) - only if needed
2. Additional FAQ pairs (2-3 Q&A pairs from this section) - only if FAQ Quality scored low
3. Definition blocks for key terms (1-3 definitions from this section) - only if Clear Definitions scored low
4. Comparison Tables (if relevant to this section) - only if Tables scored low
5. Statistics with Sources (data points mentioned in this section) - only if Statistics scored low
6. Step-by-Step Instructions (if this section describes a process) - only if Step-by-Step scored low
7. Examples (if this section has use cases or scenarios)

CRITICAL: Return ONLY valid, complete JSON. Keep responses focused on THIS SECTION ONLY. Return empty arrays for improvement types not needed.

Respond ONLY with valid JSON matching this schema:
{
  "key_takeaways": ["string array — 3-5 insights from this section"],
  "additional_faqs": [{ "question": "string", "answer": "string" }],
  "definitions": [{ "term": "string", "definition": "string" }],
  "tables": [{ "title": "string", "markdown": "string" }],
  "statistics": [{ "stat": "string", "context": "string", "source_placeholder": "string" }],
  "step_by_step": { "title": "string", "steps": ["string array"] },
  "examples": [{ "title": "string", "content": "string" }]
}`;

    const existingFaqs = Array.isArray(post.faq_json) ? post.faq_json : [];
    
    // Generate improvements for each chunk
    const batchResults = await Promise.all(
      chunks.map(async (chunk, index) => {
        const userPrompt = `Analyze this section (${index + 1}/${chunks.length}) of the article:

ARTICLE TITLE: ${post.title}
SECTION ${index + 1} CONTENT:
${chunk}

Generate improvements ONLY for what you see in this section. Keep responses concise.`;

        const maxRetries = 2;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const { content } = await this.aiGateway.chatCompletionRaw({
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              jsonObject: true,
              category: 'seo_generation',
              temperature: 0.6,
              maxTokens: 4000,
              timeoutMs: 120_000,
            });

            return this.parseAiJson(content);
          } catch (error) {
            if (attempt === maxRetries) {
              this.logger.warn(`Batch ${index + 1} failed after ${maxRetries} attempts`);
              return null;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
        }
        return null;
      }),
    );

    // Merge results from all batches
    const merged = this.mergeAEOImprovements(batchResults.filter(r => r !== null));

    // Generate TL;DR, Direct Answer, and Schema Markup from full article summary
    const summaryPrompt = `Based on this article, generate:
1. A TL;DR (2-3 sentences)
2. A direct answer to the primary question
3. JSON-LD schema markup

TITLE: ${post.title}
KEYWORDS: ${post.seo_keywords || 'not specified'}
FIRST 3000 CHARS: ${articleBody.slice(0, 3000)}

Respond with JSON:
{
  "tldr": "string",
  "direct_answer": "string",
  "schema_markup": "string — JSON-LD code"
}`;

    const { content: summaryContent } = await this.aiGateway.chatCompletionRaw({
      messages: [
        { role: 'system', content: 'You are an AEO content specialist. Generate concise summary content.' },
        { role: 'user', content: summaryPrompt },
      ],
      jsonObject: true,
      category: 'seo_generation',
      temperature: 0.6,
      maxTokens: 2000,
      timeoutMs: 60_000,
    });

    const summary = this.parseAiJson(summaryContent);

    return {
      tldr: summary.tldr || '',
      direct_answer: summary.direct_answer || '',
      schema_markup: summary.schema_markup || '',
      ...merged,
    };
  }

  private mergeAEOImprovements(results: any[]) {
    const merged = {
      key_takeaways: [] as string[],
      additional_faqs: [] as Array<{ question: string; answer: string }>,
      definitions: [] as Array<{ term: string; definition: string }>,
      tables: [] as Array<{ title: string; markdown: string }>,
      statistics: [] as Array<{ stat: string; context: string; source_placeholder: string }>,
      step_by_step: null as { title: string; steps: string[] } | null,
      examples: [] as Array<{ title: string; content: string }>,
    };

    const seenTakeaways = new Set<string>();
    const seenTerms = new Set<string>();
    const seenQuestions = new Set<string>();

    for (const result of results) {
      // Merge key takeaways (deduplicate)
      if (Array.isArray(result.key_takeaways)) {
        result.key_takeaways.forEach((kt: string) => {
          const normalized = kt.toLowerCase().trim();
          if (!seenTakeaways.has(normalized)) {
            seenTakeaways.add(normalized);
            merged.key_takeaways.push(kt);
          }
        });
      }

      // Merge FAQs (deduplicate by question)
      if (Array.isArray(result.additional_faqs)) {
        result.additional_faqs.forEach((faq: any) => {
          const normalized = faq.question.toLowerCase().trim();
          if (!seenQuestions.has(normalized)) {
            seenQuestions.add(normalized);
            merged.additional_faqs.push(faq);
          }
        });
      }

      // Merge definitions (deduplicate by term)
      if (Array.isArray(result.definitions)) {
        result.definitions.forEach((def: any) => {
          const normalized = def.term.toLowerCase().trim();
          if (!seenTerms.has(normalized)) {
            seenTerms.add(normalized);
            merged.definitions.push(def);
          }
        });
      }

      // Merge tables (no deduplication)
      if (Array.isArray(result.tables)) {
        merged.tables.push(...result.tables);
      }

      // Merge statistics (no deduplication)
      if (Array.isArray(result.statistics)) {
        merged.statistics.push(...result.statistics);
      }

      // Use first step-by-step found
      if (!merged.step_by_step && result.step_by_step) {
        merged.step_by_step = result.step_by_step;
      }

      // Merge examples (no deduplication)
      if (Array.isArray(result.examples)) {
        merged.examples.push(...result.examples);
      }
    }

    // Limit merged results to reasonable sizes
    merged.key_takeaways = merged.key_takeaways.slice(0, 10);
    merged.additional_faqs = merged.additional_faqs.slice(0, 8);
    merged.definitions = merged.definitions.slice(0, 6);
    merged.tables = merged.tables.slice(0, 3);
    merged.statistics = merged.statistics.slice(0, 8);
    merged.examples = merged.examples.slice(0, 4);

    return merged;
  }

  async generateGEOImprovements(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, author_display_name, seo_keywords')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    // First, analyze to get criteria scores
    const analysis = await this.analyzeGEO(postId);

    const articleBody = post.body ?? '';
    const CHUNK_SIZE = 5000; // chars per chunk
    const LARGE_ARTICLE_THRESHOLD = 4000; // if article > 4000 chars, use batching

    // Decide whether to use batching
    const useBatching = articleBody.length > LARGE_ARTICLE_THRESHOLD;

    if (useBatching) {
      this.logger.log(`Large article detected (${articleBody.length} chars), using batched GEO generation`);
      return this.generateGEOImprovementsBatched(post, articleBody, analysis.criteria_scores);
    } else {
      this.logger.log(`Standard article size (${articleBody.length} chars), single GEO generation`);
      return this.generateGEOImprovementsSingle(post, articleBody, analysis.criteria_scores);
    }
  }

  private async generateGEOImprovementsSingle(
    post: any,
    articleBody: string,
    criteriaScores: any[],
  ) {
    // Filter to only include low-scoring criteria (< 8/10)
    const SCORE_THRESHOLD = 8;
    const lowScoringCriteria = criteriaScores.filter((c: any) => c.score < SCORE_THRESHOLD);
    
    if (lowScoringCriteria.length === 0) {
      this.logger.log('No low-scoring GEO criteria found - article is well optimized');
      return {
        statistics: [],
        expert_quotes: [],
        entity_mentions: [],
        unique_insights: [],
        quotable_statements: [],
      };
    }

    // Map criteria names to improvement types
    const criteriaToImprovementMap: Record<string, string[]> = {
      'Unique Insights': ['unique_insights'],
      'Named Frameworks': ['unique_insights'], // Same improvement type
      'Cited Statistics': ['statistics'],
      'Research References': ['statistics'], // Related to statistics
      'Entity Coverage': ['entity_mentions'],
      'Quotable Statements': ['quotable_statements'],
      'Structured Data': ['statistics'], // Can help with structured data
      'Author Expertise Signals': ['expert_quotes'],
      'Freshness': ['statistics'], // Current stats help with freshness
    };

    // Build focused instructions
    const focusedInstructions = lowScoringCriteria
      .map((c: any) => `- ${c.criterion} (current score: ${c.score}/10): ${c.explanation}`)
      .join('\n');

    const systemPrompt = `You are an expert GEO (Generative Engine Optimization) content specialist. Generate specific content additions that will make this article more likely to be cited as an authoritative source by AI systems (ChatGPT, Perplexity, Claude, Gemini).

IMPORTANT: Only generate improvements for the LOW-SCORING criteria listed below. DO NOT generate improvements for criteria that are already performing well (8/10 or higher).

LOW-SCORING CRITERIA TO ADDRESS:
${focusedInstructions}

CRITICAL: You MUST return ONLY valid, complete JSON. Do not truncate the response. Ensure all strings are properly closed and all objects/arrays are properly terminated.

Respond ONLY with valid JSON matching this schema:
{
  "statistics": [{ "stat": "string — the statistic", "context": "string — where to use it", "source_placeholder": "string — suggested source type" }],
  "expert_quotes": [{ "quote": "string — the quote", "attribution_suggestion": "string — type of expert to attribute to" }],
  "entity_mentions": [{ "entity": "string — name", "type": "person" | "company" | "tool" | "concept", "context": "string — how to mention it" }],
  "unique_insights": [{ "insight": "string — the unique perspective", "framework_name": "string — optional named framework" }],
  "quotable_statements": ["string array — authoritative, citable sentences"]
}

NOTE: Return empty arrays for improvement types NOT needed based on the scoring.`;

    const userPrompt = `Generate GEO improvements for this article:

TITLE: ${post.title}
AUTHOR: ${post.author_display_name || 'Not specified'}
KEYWORDS: ${post.seo_keywords || 'not specified'}

FULL ARTICLE BODY:
${articleBody}

Requirements:
1. Statistics should be realistic and verifiable (use 2024-2026 timeframes)
2. Expert quotes should sound authentic and authoritative
3. Entity mentions should be relevant industry leaders, tools, or concepts
4. Unique insights should position the article as original thought leadership
5. Quotable statements should be concise, authoritative, and citation-worthy

CRITICAL: Keep responses concise. Return complete, valid JSON with all strings properly terminated.`;

    // Retry logic with exponential backoff
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { content } = await this.aiGateway.chatCompletionRaw({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          jsonObject: true,
          category: 'seo_generation',
          temperature: 0.6,
          maxTokens: 8000,
          timeoutMs: 150_000,
        });

        const parsed = this.parseAiJson(content);
        return {
          statistics: Array.isArray(parsed.statistics) ? parsed.statistics : [],
          expert_quotes: Array.isArray(parsed.expert_quotes)
            ? parsed.expert_quotes
            : [],
          entity_mentions: Array.isArray(parsed.entity_mentions)
            ? parsed.entity_mentions
            : [],
          unique_insights: Array.isArray(parsed.unique_insights)
            ? parsed.unique_insights
            : [],
          quotable_statements: Array.isArray(parsed.quotable_statements)
            ? parsed.quotable_statements
            : [],
        };
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `GEO improvements generation attempt ${attempt} failed: ${lastError.message}`,
        );

        if (attempt === maxRetries) break;

        const backoffMs = Math.pow(2, attempt) * 1000;
        this.logger.log(`Retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    this.logger.error(
      `GEO improvements generation failed after ${maxRetries} attempts: ${lastError?.message}`,
    );
    throw new BadRequestException(
      `Failed to generate GEO improvements: ${lastError instanceof AiGatewayError ? lastError.message : 'AI service unavailable'}`,
    );
  }

  private async generateGEOImprovementsBatched(
    post: any,
    articleBody: string,
    criteriaScores: any[],
  ) {
    // Filter to only include low-scoring criteria (< 8/10)
    const SCORE_THRESHOLD = 8;
    const lowScoringCriteria = criteriaScores.filter((c: any) => c.score < SCORE_THRESHOLD);
    
    if (lowScoringCriteria.length === 0) {
      this.logger.log('No low-scoring GEO criteria found - article is well optimized');
      return {
        statistics: [],
        expert_quotes: [],
        entity_mentions: [],
        unique_insights: [],
        quotable_statements: [],
      };
    }

    // Build focused instructions
    const focusedInstructions = lowScoringCriteria
      .map((c: any) => `- ${c.criterion} (score: ${c.score}/10): ${c.explanation}`)
      .join('\n');

    const CHUNK_SIZE = 5000;
    const chunks: string[] = [];
    
    // Split article into chunks
    for (let i = 0; i < articleBody.length; i += CHUNK_SIZE) {
      chunks.push(articleBody.slice(i, i + CHUNK_SIZE));
    }

    this.logger.log(`Generating GEO improvements for ${chunks.length} batches`);

    const systemPrompt = `You are an expert GEO (Generative Engine Optimization) content specialist. Generate specific content additions for THIS SECTION of a larger article.

IMPORTANT: Focus ONLY on these LOW-SCORING areas that need improvement:
${focusedInstructions}

Generate improvements for this section ONLY if they address the low-scoring criteria above:
1. Statistics to add (with placeholder sources) - only if Statistics/Research References scored low
2. Expert quote suggestions - only if Author Expertise scored low
3. Entity mentions (people, companies, tools, concepts) - only if Entity Coverage scored low
4. Unique insight angles - only if Unique Insights/Named Frameworks scored low
5. Quotable statements - only if Quotable Statements scored low

CRITICAL: Return ONLY valid, complete JSON. Keep responses focused on THIS SECTION ONLY. Return empty arrays for improvement types not needed.

Respond ONLY with valid JSON matching this schema:
{
  "statistics": [{ "stat": "string", "context": "string", "source_placeholder": "string" }],
  "expert_quotes": [{ "quote": "string", "attribution_suggestion": "string" }],
  "entity_mentions": [{ "entity": "string", "type": "person" | "company" | "tool" | "concept", "context": "string" }],
  "unique_insights": [{ "insight": "string", "framework_name": "string" }],
  "quotable_statements": ["string array"]
}`;

    // Generate improvements for each chunk
    const batchResults = await Promise.all(
      chunks.map(async (chunk, index) => {
        const userPrompt = `Analyze this section (${index + 1}/${chunks.length}) of the article:

ARTICLE TITLE: ${post.title}
AUTHOR: ${post.author_display_name || 'Not specified'}
SECTION ${index + 1} CONTENT:
${chunk}

Generate improvements ONLY for what you see in this section. Keep responses concise.`;

        const maxRetries = 2;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const { content } = await this.aiGateway.chatCompletionRaw({
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              jsonObject: true,
              category: 'seo_generation',
              temperature: 0.6,
              maxTokens: 4000,
              timeoutMs: 120_000,
            });

            return this.parseAiJson(content);
          } catch (error) {
            if (attempt === maxRetries) {
              this.logger.warn(`GEO batch ${index + 1} failed after ${maxRetries} attempts`);
              return null;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
        }
        return null;
      }),
    );

    // Merge results from all batches
    return this.mergeGEOImprovements(batchResults.filter(r => r !== null));
  }

  private mergeGEOImprovements(results: any[]) {
    const merged = {
      statistics: [] as Array<{ stat: string; context: string; source_placeholder: string }>,
      expert_quotes: [] as Array<{ quote: string; attribution_suggestion: string }>,
      entity_mentions: [] as Array<{ entity: string; type: string; context: string }>,
      unique_insights: [] as Array<{ insight: string; framework_name?: string }>,
      quotable_statements: [] as string[],
    };

    const seenStats = new Set<string>();
    const seenQuotes = new Set<string>();
    const seenEntities = new Set<string>();
    const seenInsights = new Set<string>();
    const seenQuotables = new Set<string>();

    for (const result of results) {
      // Merge statistics (deduplicate)
      if (Array.isArray(result.statistics)) {
        result.statistics.forEach((stat: any) => {
          const normalized = stat.stat.toLowerCase().trim();
          if (!seenStats.has(normalized)) {
            seenStats.add(normalized);
            merged.statistics.push(stat);
          }
        });
      }

      // Merge expert quotes (deduplicate)
      if (Array.isArray(result.expert_quotes)) {
        result.expert_quotes.forEach((quote: any) => {
          const normalized = quote.quote.toLowerCase().trim();
          if (!seenQuotes.has(normalized)) {
            seenQuotes.add(normalized);
            merged.expert_quotes.push(quote);
          }
        });
      }

      // Merge entity mentions (deduplicate by entity name)
      if (Array.isArray(result.entity_mentions)) {
        result.entity_mentions.forEach((entity: any) => {
          const normalized = entity.entity.toLowerCase().trim();
          if (!seenEntities.has(normalized)) {
            seenEntities.add(normalized);
            merged.entity_mentions.push(entity);
          }
        });
      }

      // Merge unique insights (deduplicate)
      if (Array.isArray(result.unique_insights)) {
        result.unique_insights.forEach((insight: any) => {
          const normalized = insight.insight.toLowerCase().trim();
          if (!seenInsights.has(normalized)) {
            seenInsights.add(normalized);
            merged.unique_insights.push(insight);
          }
        });
      }

      // Merge quotable statements (deduplicate)
      if (Array.isArray(result.quotable_statements)) {
        result.quotable_statements.forEach((statement: string) => {
          const normalized = statement.toLowerCase().trim();
          if (!seenQuotables.has(normalized)) {
            seenQuotables.add(normalized);
            merged.quotable_statements.push(statement);
          }
        });
      }
    }

    // Limit merged results to reasonable sizes
    merged.statistics = merged.statistics.slice(0, 8);
    merged.expert_quotes = merged.expert_quotes.slice(0, 6);
    merged.entity_mentions = merged.entity_mentions.slice(0, 8);
    merged.unique_insights = merged.unique_insights.slice(0, 5);
    merged.quotable_statements = merged.quotable_statements.slice(0, 8);

    return merged;
  }

  async getOptimizationReport(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, aeo_score, geo_score, quality_score')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');

    const [aeoAnalysis, geoAnalysis] = await Promise.all([
      this.analyzeAEO(postId),
      this.analyzeGEO(postId),
    ]);

    const combinedScore = Math.round(
      (aeoAnalysis.overall_score + geoAnalysis.overall_score) / 2,
    );

    const allSuggestions = [
      ...aeoAnalysis.suggestions.map((s: any) => ({ ...s, source: 'aeo' })),
      ...geoAnalysis.suggestions.map((s: any) => ({ ...s, source: 'geo' })),
    ].sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return (
        (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 2) -
        (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 2)
      );
    });

    return {
      post_id: postId,
      title: post.title,
      combined_score: combinedScore,
      aeo: {
        score: aeoAnalysis.overall_score,
        criteria_scores: aeoAnalysis.criteria_scores,
        suggestions: aeoAnalysis.suggestions,
      },
      geo: {
        score: geoAnalysis.overall_score,
        criteria_scores: geoAnalysis.criteria_scores,
        suggestions: geoAnalysis.suggestions,
      },
      prioritized_suggestions: allSuggestions.slice(0, 10),
      recommendations: this.generateOptimizationRecommendations(
        aeoAnalysis,
        geoAnalysis,
      ),
    };
  }

  private generateOptimizationRecommendations(
    aeoAnalysis: {
      overall_score: number;
      criteria_scores: any[];
      suggestions: any[];
    },
    geoAnalysis: {
      overall_score: number;
      criteria_scores: any[];
      suggestions: any[];
    },
  ): string[] {
    const recommendations: string[] = [];

    if (aeoAnalysis.overall_score < 60) {
      recommendations.push(
        'AEO score is low — prioritize adding TL;DR, Key Takeaways, and FAQ sections',
      );
    }
    if (geoAnalysis.overall_score < 60) {
      recommendations.push(
        'GEO score is low — add statistics with sources, expert quotes, and unique insights',
      );
    }

    const aeoLowCriteria = aeoAnalysis.criteria_scores.filter(
      (c: any) => c.score < 5,
    );
    const geoLowCriteria = geoAnalysis.criteria_scores.filter(
      (c: any) => c.score < 5,
    );

    if (aeoLowCriteria.length > 0) {
      recommendations.push(
        `AEO weak areas: ${aeoLowCriteria.map((c: any) => c.criterion).join(', ')}`,
      );
    }
    if (geoLowCriteria.length > 0) {
      recommendations.push(
        `GEO weak areas: ${geoLowCriteria.map((c: any) => c.criterion).join(', ')}`,
      );
    }

    if (aeoAnalysis.overall_score >= 80 && geoAnalysis.overall_score >= 80) {
      recommendations.push(
        'Content is well-optimized for AI engines — consider minor refinements only',
      );
    }

    return recommendations;
  }

  async applyOptimizations(
    postId: string,
    optimizations: {
      type: string;
      content: string;
      position: 'top' | 'bottom' | 'after_intro';
    }[],
  ) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, body, faq_json')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');
    if (!post.body) throw new BadRequestException('Post body is empty');

    const originalBody = post.body;
    const originalBodyLength = originalBody.length;
    
    let body = post.body;
    let faqJson = Array.isArray(post.faq_json) ? [...post.faq_json] : [];
    let appliedCount = 0;
    const appliedTypes: string[] = [];

    for (const opt of optimizations) {
      if (!opt.content || opt.content.trim() === '') {
        this.logger.warn(`Skipping empty optimization: ${opt.type}`);
        continue;
      }

      if (opt.type === 'faq' && opt.content) {
        try {
          const faqItems = JSON.parse(opt.content);
          if (Array.isArray(faqItems)) {
            faqJson = [...faqJson, ...faqItems];
            appliedCount++;
            appliedTypes.push('FAQ');
          }
        } catch {
          this.logger.warn(`Invalid FAQ JSON: ${opt.content}`);
        }
        continue;
      }

      const contentBlock = `\n\n${opt.content}\n`;

      switch (opt.position) {
        case 'top':
          body = contentBlock + body;
          appliedCount++;
          appliedTypes.push(opt.type);
          break;
        case 'bottom':
          body = body + contentBlock;
          appliedCount++;
          appliedTypes.push(opt.type);
          break;
        case 'after_intro': {
          const firstHeadingMatch = body.match(/^(#{2,3}\s+.+)$/m);
          if (firstHeadingMatch && firstHeadingMatch.index !== undefined) {
            body =
              body.slice(0, firstHeadingMatch.index) +
              contentBlock +
              body.slice(firstHeadingMatch.index);
          } else {
            const firstParagraphEnd = body.indexOf('\n\n');
            if (firstParagraphEnd > 0) {
              body =
                body.slice(0, firstParagraphEnd) +
                contentBlock +
                body.slice(firstParagraphEnd);
            } else {
              body = contentBlock + body;
            }
          }
          appliedCount++;
          appliedTypes.push(opt.type);
          break;
        }
      }
    }

    if (appliedCount === 0) {
      throw new BadRequestException('No valid optimizations to apply');
    }

    const newBodyLength = body.length;
    
    this.logger.log(`Content validation: original length=${originalBodyLength}, new length=${newBodyLength}`);

    // Basic sanity checks: new content should not be empty or drastically shorter
    if (newBodyLength < 100) {
      this.logger.error(`Content validation failed: New body is too short (${newBodyLength} chars)`);
      throw new BadRequestException('Content validation failed: Resulting content is too short');
    }

    // Allow content to be shorter if optimizations were applied (e.g., table insertions may replace text)
    // but not by more than 50%
    const lengthRatio = newBodyLength / originalBodyLength;
    if (lengthRatio < 0.5) {
      this.logger.error(
        `Content validation failed: New body is significantly shorter than original (${Math.round(lengthRatio * 100)}% of original)`,
      );
      throw new BadRequestException(
        `Content validation failed: Resulting content is too short (${Math.round(lengthRatio * 100)}% of original)`,
      );
    }

    // Relaxed integrity check: verify that at least 60% of original segments are present
    // This allows for content modifications (like table insertions) while still catching major issues
    const originalSegments = [
      originalBody.substring(0, 100),
      originalBody.substring(Math.floor(originalBodyLength / 4), Math.floor(originalBodyLength / 4) + 100),
      originalBody.substring(Math.floor(originalBodyLength / 2), Math.floor(originalBodyLength / 2) + 100),
      originalBody.substring(Math.floor(originalBodyLength * 3 / 4), Math.floor(originalBodyLength * 3 / 4) + 100),
      originalBody.substring(Math.max(0, originalBodyLength - 100)),
    ].filter(seg => seg.length > 50);

    const segmentsPresent = originalSegments.filter(segment => body.includes(segment));
    const integrityRatio = segmentsPresent.length / originalSegments.length;
    
    this.logger.log(
      `Content integrity check: ${segmentsPresent.length}/${originalSegments.length} segments present (${Math.round(integrityRatio * 100)}%)`,
    );

    if (integrityRatio < 0.6) {
      this.logger.warn(
        `Content integrity is low (${Math.round(integrityRatio * 100)}%) - only ${segmentsPresent.length}/${originalSegments.length} segments found`,
      );
      
      // Log which segments are missing for debugging
      originalSegments.forEach((seg, idx) => {
        if (!body.includes(seg)) {
          this.logger.warn(`Missing segment ${idx + 1}: "${seg.substring(0, 50)}..."`);
        }
      });
      
      throw new BadRequestException(
        `Content validation failed: Original content integrity too low (${Math.round(integrityRatio * 100)}%)`,
      );
    }

    this.logger.log('Content validation passed');

    const { error: updateErr } = await client
      .from('blog_posts')
      .update({
        body,
        faq_json: faqJson.length > 0 ? faqJson : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', postId);

    if (updateErr) throw updateErr;

    this.logger.log(
      `Applied ${appliedCount} optimizations to post ${postId}: ${appliedTypes.join(', ')}`,
    );

    return {
      success: true,
      post_id: postId,
      applied_count: appliedCount,
      applied_types: appliedTypes,
      new_faq_count: faqJson.length,
      body_length_before: originalBodyLength,
      body_length_after: body.length,
      content_added: body.length - originalBodyLength,
    };
  }

  // ===== RANK TRACKING ENGINE =====

  async trackKeywordRanking(
    keywordId: string,
    position: number,
    searchEngine: string = 'google',
    country: string = 'US',
    postId?: string,
  ) {
    const client = this.supabase.getServiceClient();

    const { data: lastRanking } = await client
      .from('keyword_rankings')
      .select('position')
      .eq('keyword_id', keywordId)
      .order('tracked_at', { ascending: false })
      .limit(1)
      .single();

    const previousPosition = lastRanking?.position ?? null;

    const { data, error } = await client
      .from('keyword_rankings')
      .insert({
        keyword_id: keywordId,
        post_id: postId ?? null,
        position,
        previous_position: previousPosition,
        search_engine: searchEngine,
        country,
        tracked_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getKeywordRankings(keywordId: string, days: number = 30) {
    const client = this.supabase.getServiceClient();
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await client
      .from('keyword_rankings')
      .select('*, seo_keywords:keyword_id(keyword, normalized_keyword)')
      .eq('keyword_id', keywordId)
      .gte('tracked_at', since.toISOString())
      .order('tracked_at', { ascending: true });

    if (error) throw error;
    return data ?? [];
  }

  async getRankingOverview() {
    const client = this.supabase.getServiceClient();

    const { data: keywords } = await client
      .from('seo_keywords')
      .select('id')
      .eq('status', 'active');

    const keywordsTracked = keywords?.length ?? 0;

    const { data: latestRankings } = await client
      .from('keyword_rankings')
      .select('keyword_id, position, previous_position')
      .order('tracked_at', { ascending: false });

    const latestByKeyword = new Map<
      string,
      { position: number; previous_position: number | null }
    >();
    for (const r of latestRankings ?? []) {
      if (!latestByKeyword.has(r.keyword_id)) {
        latestByKeyword.set(r.keyword_id, {
          position: r.position,
          previous_position: r.previous_position,
        });
      }
    }

    let totalPosition = 0;
    let improved = 0;
    let declined = 0;
    let unchanged = 0;

    for (const [, ranking] of latestByKeyword) {
      totalPosition += ranking.position ?? 0;
      if (ranking.previous_position !== null) {
        if (ranking.position < ranking.previous_position) improved++;
        else if (ranking.position > ranking.previous_position) declined++;
        else unchanged++;
      }
    }

    const avgPosition =
      latestByKeyword.size > 0
        ? Math.round(totalPosition / latestByKeyword.size)
        : 0;

    return {
      keywords_tracked: keywordsTracked,
      keywords_with_rankings: latestByKeyword.size,
      avg_position: avgPosition,
      improved,
      declined,
      unchanged,
    };
  }

  async getTopMovers(limit: number = 10) {
    const client = this.supabase.getServiceClient();

    const { data: rankings } = await client
      .from('keyword_rankings')
      .select(
        'keyword_id, position, previous_position, tracked_at, seo_keywords:keyword_id(keyword)',
      )
      .not('previous_position', 'is', null)
      .order('tracked_at', { ascending: false });

    const latestByKeyword = new Map<string, any>();
    for (const r of rankings ?? []) {
      if (!latestByKeyword.has(r.keyword_id)) {
        latestByKeyword.set(r.keyword_id, r);
      }
    }

    const movers = Array.from(latestByKeyword.values())
      .map((r) => ({
        keyword_id: r.keyword_id,
        keyword: r.seo_keywords?.keyword ?? 'Unknown',
        position: r.position,
        previous_position: r.previous_position,
        change: (r.previous_position ?? r.position) - r.position,
        tracked_at: r.tracked_at,
      }))
      .filter((m) => m.change !== 0)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, limit);

    const gainers = movers.filter((m) => m.change > 0);
    const losers = movers.filter((m) => m.change < 0);

    return { gainers, losers };
  }

  async checkRankings() {
    return {
      message:
        'Automatic rank checking requires API integration (Google Search Console, SerpAPI, etc.). Use manual entry for now.',
      supported_apis: [
        'Google Search Console',
        'SerpAPI',
        'DataForSEO',
        'Ahrefs API',
      ],
      status: 'not_configured',
    };
  }

  // ===== BACKLINK ENGINE =====

  async listBacklinkProfiles() {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('backlink_profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async createBacklinkProfile(body: {
    platform: string;
    profile_url?: string;
    status?: string;
    domain_authority?: number;
    notes?: string;
  }) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('backlink_profiles')
      .insert({
        platform: body.platform,
        profile_url: body.profile_url ?? null,
        status: body.status ?? 'planned',
        domain_authority: body.domain_authority ?? null,
        notes: body.notes ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateBacklinkProfile(
    id: string,
    body: {
      platform?: string;
      profile_url?: string;
      status?: string;
      domain_authority?: number;
      notes?: string;
    },
  ) {
    const client = this.supabase.getServiceClient();
    const update: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.platform !== undefined) update.platform = body.platform;
    if (body.profile_url !== undefined) update.profile_url = body.profile_url;
    if (body.status !== undefined) update.status = body.status;
    if (body.domain_authority !== undefined)
      update.domain_authority = body.domain_authority;
    if (body.notes !== undefined) update.notes = body.notes;

    const { data, error } = await client
      .from('backlink_profiles')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new NotFoundException('Backlink profile not found');
    return data;
  }

  async listBacklinkOpportunities(filters?: {
    status?: string;
    opportunity_type?: string;
  }) {
    const client = this.supabase.getServiceClient();
    let query = client
      .from('backlink_opportunities')
      .select('*, target_post:target_post_id(id, title, slug)')
      .order('created_at', { ascending: false });

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }
    if (filters?.opportunity_type) {
      query = query.eq('opportunity_type', filters.opportunity_type);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async createBacklinkOpportunity(body: {
    source_domain: string;
    source_url?: string;
    opportunity_type?: string;
    target_post_id?: string;
    status?: string;
    domain_authority?: number;
    contact_email?: string;
    notes?: string;
  }) {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('backlink_opportunities')
      .insert({
        source_domain: body.source_domain,
        source_url: body.source_url ?? null,
        opportunity_type: body.opportunity_type ?? null,
        target_post_id: body.target_post_id ?? null,
        status: body.status ?? 'identified',
        domain_authority: body.domain_authority ?? null,
        contact_email: body.contact_email ?? null,
        notes: body.notes ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateBacklinkOpportunity(
    id: string,
    body: {
      source_domain?: string;
      source_url?: string;
      opportunity_type?: string;
      target_post_id?: string;
      status?: string;
      domain_authority?: number;
      contact_email?: string;
      notes?: string;
      outreach_sent_at?: string;
      acquired_at?: string;
    },
  ) {
    const client = this.supabase.getServiceClient();
    const update: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.source_domain !== undefined)
      update.source_domain = body.source_domain;
    if (body.source_url !== undefined) update.source_url = body.source_url;
    if (body.opportunity_type !== undefined)
      update.opportunity_type = body.opportunity_type;
    if (body.target_post_id !== undefined)
      update.target_post_id = body.target_post_id;
    if (body.status !== undefined) update.status = body.status;
    if (body.domain_authority !== undefined)
      update.domain_authority = body.domain_authority;
    if (body.contact_email !== undefined)
      update.contact_email = body.contact_email;
    if (body.notes !== undefined) update.notes = body.notes;
    if (body.outreach_sent_at !== undefined)
      update.outreach_sent_at = body.outreach_sent_at;
    if (body.acquired_at !== undefined) update.acquired_at = body.acquired_at;

    if (body.status === 'outreach_sent' && !body.outreach_sent_at) {
      update.outreach_sent_at = new Date().toISOString();
    }
    if (body.status === 'acquired' && !body.acquired_at) {
      update.acquired_at = new Date().toISOString();
    }

    const { data, error } = await client
      .from('backlink_opportunities')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new NotFoundException('Backlink opportunity not found');
    return data;
  }

  async getBacklinkStats() {
    const client = this.supabase.getServiceClient();

    const { data: opportunities } = await client
      .from('backlink_opportunities')
      .select('id, status, opportunity_type');

    const opps = opportunities ?? [];
    const total = opps.length;

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const opp of opps) {
      byStatus[opp.status] = (byStatus[opp.status] ?? 0) + 1;
      if (opp.opportunity_type) {
        byType[opp.opportunity_type] = (byType[opp.opportunity_type] ?? 0) + 1;
      }
    }

    const { count: profilesCount } = await client
      .from('backlink_profiles')
      .select('*', { count: 'exact', head: true });

    const { count: verifiedProfiles } = await client
      .from('backlink_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'verified');

    return {
      total_opportunities: total,
      by_status: byStatus,
      by_type: byType,
      acquired_count: byStatus['acquired'] ?? 0,
      profiles_count: profilesCount ?? 0,
      verified_profiles: verifiedProfiles ?? 0,
    };
  }

  async suggestBacklinkOpportunities(postId: string) {
    const client = this.supabase.getServiceClient();

    const { data: post, error: postErr } = await client
      .from('blog_posts')
      .select('id, title, body, tags, seo_keywords')
      .eq('id', postId)
      .single();

    if (postErr || !post) throw new NotFoundException('Post not found');

    const systemPrompt = `You are an expert SEO link builder. Given a blog post's topic and keywords, suggest potential backlink opportunities. Focus on realistic, actionable opportunities.

Respond ONLY with valid JSON matching this schema:
{
  "suggestions": [
    {
      "source_domain": "string — domain name (e.g., 'producthunt.com')",
      "opportunity_type": "guest_post" | "resource_page" | "broken_link" | "competitor_backlink" | "directory" | "mention",
      "reason": "string — why this is a good opportunity",
      "outreach_approach": "string — suggested outreach strategy",
      "estimated_da": number (0-100, estimated domain authority)
    }
  ]
}

Suggest 5-10 opportunities across different types. Prioritize high-DA sites relevant to the topic.`;

    const userPrompt = `Suggest backlink opportunities for this blog post:

TITLE: ${post.title}
TAGS: ${(post.tags ?? []).join(', ')}
KEYWORDS: ${post.seo_keywords || 'not specified'}

CONTENT PREVIEW (first 2000 chars):
${(post.body ?? '').slice(0, 2000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        jsonObject: true,
        category: 'seo_analysis',
        temperature: 0.7,
        maxTokens: 2000,
        timeoutMs: 45_000,
      });

      const parsed = this.parseAiJson(content);
      return {
        post_id: postId,
        post_title: post.title,
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [],
      };
    } catch (error) {
      this.logger.error(
        `Backlink suggestion failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to suggest backlink opportunities: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  // --- Blog AI Helpers ---

  async generateTitle(keyword: string): Promise<{ title: string }> {
    try {
      const prompt = `Generate a compelling, SEO-optimized blog post title based on this keyword: "${keyword}".

Requirements:
- Should be engaging and click-worthy
- Include the keyword naturally
- 50-60 characters optimal
- Clear value proposition

Return only JSON: {"title": "Your Generated Title"}`;

      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [{ role: 'user', content: prompt }],
        category: 'seo_generation',
        jsonObject: true,
        temperature: 0.8,
        maxTokens: 150,
        timeoutMs: 20_000,
      });

      const parsed = this.parseAiJson(content);
      return { title: parsed.title || keyword };
    } catch (error) {
      this.logger.error(`Title generation failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to generate title: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async generateExcerpt(body: string): Promise<{ excerpt: string }> {
    try {
      const prompt = `Generate a compelling excerpt (meta description) for this blog post body:

${body.slice(0, 2000)}

Requirements:
- 140-160 characters
- Summarize key value
- Include call to action or hook
- Natural, engaging tone

Return only JSON: {"excerpt": "Your generated excerpt"}`;

      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [{ role: 'user', content: prompt }],
        category: 'seo_generation',
        jsonObject: true,
        temperature: 0.7,
        maxTokens: 200,
        timeoutMs: 20_000,
      });

      const parsed = this.parseAiJson(content);
      return { excerpt: parsed.excerpt || '' };
    } catch (error) {
      this.logger.error(
        `Excerpt generation failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to generate excerpt: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async enhanceContent(
    body: string,
    instructions?: string,
  ): Promise<{ enhanced_body: string }> {
    try {
      const defaultInstructions =
        'Expand and improve this content while maintaining the original structure and key points. Add depth, examples, and clarity.';
      const prompt = `${instructions || defaultInstructions}

Original content:
${body}

Return only JSON: {"enhanced_body": "Your enhanced markdown content"}`;

      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [{ role: 'user', content: prompt }],
        category: 'seo_generation',
        jsonObject: true,
        temperature: 0.7,
        maxTokens: 4000,
        timeoutMs: 60_000,
      });

      const parsed = this.parseAiJson(content);
      return { enhanced_body: parsed.enhanced_body || body };
    } catch (error) {
      this.logger.error(
        `Content enhancement failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to enhance content: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async generateFAQ(
    body: string,
  ): Promise<{ faq: Array<{ question: string; answer: string }> }> {
    try {
      const prompt = `Generate 3-5 frequently asked questions based on this blog post content:

${body.slice(0, 3000)}

Requirements:
- Questions should address common reader concerns
- Answers should be clear and concise (2-3 sentences)
- Use natural language
- Cover different aspects of the content

Return only JSON: {"faq": [{"question": "...", "answer": "..."}]}`;

      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [{ role: 'user', content: prompt }],
        category: 'seo_generation',
        jsonObject: true,
        temperature: 0.7,
        maxTokens: 1000,
        timeoutMs: 30_000,
      });

      const parsed = this.parseAiJson(content);
      return { faq: Array.isArray(parsed.faq) ? parsed.faq : [] };
    } catch (error) {
      this.logger.error(`FAQ generation failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to generate FAQ: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async generateSEO(
    title: string,
    body: string,
    keyword?: string,
  ): Promise<{ seo_title: string; seo_description: string; keywords: string }> {
    try {
      const prompt = `Generate SEO metadata for this blog post:

Title: ${title}
Primary Keyword: ${keyword || 'Not specified'}
Content preview: ${body.slice(0, 1500)}

Requirements:
- SEO Title: 50-60 characters, include keyword naturally
- Meta Description: 140-160 characters, compelling, keyword-rich
- Keywords: 5-8 relevant keywords, comma-separated

Return only JSON: {"seo_title": "...", "seo_description": "...", "keywords": "..."}`;

      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [{ role: 'user', content: prompt }],
        category: 'seo_analysis',
        jsonObject: true,
        temperature: 0.7,
        maxTokens: 300,
        timeoutMs: 20_000,
      });

      const parsed = this.parseAiJson(content);
      return {
        seo_title: parsed.seo_title || title,
        seo_description: parsed.seo_description || '',
        keywords: parsed.keywords || keyword || '',
      };
    } catch (error) {
      this.logger.error(`SEO generation failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to generate SEO: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }

  async generateSEOMetadataWithOG(
    postId: string,
  ): Promise<{
    title: string;
    metaDescription: string;
    keywords: string;
    ogImageUrl: string | null;
  }> {
    const client = this.supabase.getServiceClient();
    const { data: post, error } = await client
      .from('blog_posts')
      .select('id, title, body, tags, seo_keywords, slug')
      .eq('id', postId)
      .single();

    if (error || !post) {
      throw new NotFoundException(`Blog post ${postId} not found`);
    }

    const bodyPreview = (post.body || '').slice(0, 3000);
    const existingKeywords = post.seo_keywords || (Array.isArray(post.tags) ? post.tags.join(', ') : '');

    const prompt = `You are an expert SEO strategist following Google's Search Quality Guidelines. Generate optimized SEO metadata for this blog post.

Title: ${post.title}
Existing Keywords: ${existingKeywords}
Content:
${bodyPreview}

Generate the following:

1. **SEO Title** (50-60 characters):
   - Front-load the primary keyword
   - Include a power word for CTR (e.g., Guide, Best, How to, [2026], Ultimate)
   - Match the search intent of the content
   - Make it compelling and unique

2. **Meta Description** (150-160 characters):
   - Include the primary keyword naturally in the first 60 characters
   - Clear value proposition: what will the reader gain?
   - End with a call-to-action or reason to click
   - Match the content's actual promise

3. **SEO Keywords** (5-8 keywords):
   - Primary keyword first
   - 2-3 secondary/related keywords
   - 2-3 long-tail variations
   - Include semantic/LSI terms
   - Comma-separated

Return ONLY valid JSON:
{"seo_title": "...", "meta_description": "...", "keywords": "keyword1, keyword2, keyword3, ..."}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [{ role: 'user', content: prompt }],
        category: 'seo_generation',
        jsonObject: true,
        temperature: 0.6,
        maxTokens: 500,
        timeoutMs: 30_000,
      });

      const parsed = this.parseAiJson(content);
      const seoTitle = parsed.seo_title || post.title;
      const metaDescription = parsed.meta_description || '';
      const keywords = parsed.keywords || existingKeywords;

      let ogImageUrl: string | null = null;
      if (this.minioService) {
        try {
          const firstTag = Array.isArray(post.tags) && post.tags.length > 0 ? post.tags[0] : undefined;
          const bodyExcerpt = (post.body || '')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // remove markdown images ![alt](url)
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links → keep text
            .replace(/^#{1,6}\s+.*/gm, '')           // remove headings
            .replace(/```[\s\S]*?```/g, '')          // remove fenced code blocks
            .replace(/`[^`]*`/g, '')                 // remove inline code
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic → text
            .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')   // underscore bold/italic → text
            .replace(/<[^>]+>/g, '')                  // remove HTML tags
            .replace(/\s+/g, ' ')                     // collapse whitespace
            .trim()
            .slice(0, 160);
          const imageBuffer = await generateOGImage({
            title: seoTitle,
            category: firstTag,
            excerpt: bodyExcerpt || undefined,
          });

          const objectName = `blog/og/${post.slug || postId}-og-${Date.now()}.png`;
          await this.minioService.uploadFile(
            'contentos-media',
            objectName,
            imageBuffer,
            'image/png',
          );
          ogImageUrl = await this.minioService.getPublicUrl(
            'contentos-media',
            objectName,
          );
        } catch (imgError) {
          this.logger.warn(
            `OG image generation failed for ${postId}: ${(imgError as Error).message}`,
          );
        }
      }

      // Persist generated SEO fields to the blog post
      const updatePayload: Record<string, string | null> = {
        seo_title: seoTitle,
        seo_description: metaDescription,
        seo_keywords: keywords,
      };
      if (ogImageUrl) {
        updatePayload.og_image_url = ogImageUrl;
      }
      const { error: updateError } = await client
        .from('blog_posts')
        .update(updatePayload)
        .eq('id', postId);
      if (updateError) {
        this.logger.warn(
          `Failed to persist SEO metadata for ${postId}: ${updateError.message}`,
        );
      }

      return { title: seoTitle, metaDescription, keywords, ogImageUrl };
    } catch (error) {
      this.logger.error(
        `SEO metadata generation with OG failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to generate SEO metadata: ${error instanceof AiGatewayError ? error.message : 'AI service unavailable'}`,
      );
    }
  }
}
