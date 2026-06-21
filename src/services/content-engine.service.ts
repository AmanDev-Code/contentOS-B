import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { AiGatewayService, AiGatewayError } from './ai-gateway.service';
import { PlatformPublishersService } from './platform-publishers.service';
import { ProfileRepository } from '../repositories/profile.repository';
import { LinkedInAuthService } from '../integrations/social/providers/linkedin/linkedin-auth.service';
import { MinioService } from './minio.service';
import { generateDiagram, generateOGImage } from '../utils/image-generation.util';

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

    // Get the post content
    const { data: post } = await client
      .from('blog_posts')
      .select('title, excerpt, body, tags')
      .eq('id', postId)
      .single();

    if (!post) throw new NotFoundException('Post not found');

    const adapted = await this.adaptContentForPlatform(post, platform);

    const { data, error } = await client
      .from('blog_distributions')
      .upsert(
        {
          post_id: postId,
          platform,
          status: 'ready',
          adapted_content: adapted,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'post_id,platform' },
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  private async adaptContentForPlatform(
    post: {
      title: string;
      excerpt: string | null;
      body: string | null;
      tags: string[] | null;
    },
    platform: string,
  ): Promise<string> {
    const title = post.title;
    const excerpt = post.excerpt ?? '';
    const body = post.body ?? excerpt;
    const tags = post.tags ?? [];

    const platformRules: Record<string, string> = {
      // ===== TIER 1: AUTO-PUBLISH PLATFORMS =====
      linkedin_article:
        'Professional LinkedIn article. 1500-2000 words. Add relevant hashtags at the end. Maintain professional, insightful tone. Add a strong hook in the first line. Include data points and industry insights.',
      linkedin_post:
        'LinkedIn post, MAX 1300 characters total. Hook in first line (bold statement or question). Personal/professional tone. Use line breaks for readability. End with a question to drive engagement. Add 3-5 hashtags.',
      medium:
        'Medium article format. Different intro than original (hook the reader). Use Medium-style formatting: pull quotes, section breaks (---). Add a "TL;DR" at the top. Conversational but authoritative tone.',
      devto:
        'Dev.to article. Start with YAML front matter (title, published: false, tags). Developer-community focused. Add code examples where relevant. Practical and tutorial-like. Use dev.to markdown extensions.',
      hashnode:
        'Hashnode technical blog. Deep technical depth. Include code examples and explanations. Developer-friendly. Use clear subheadings. Add a "Prerequisites" section if applicable.',
      ghost:
        'Ghost blog format. Clean, professional writing. Use proper heading hierarchy (H2, H3). Include a compelling introduction. Add a clear call-to-action at the end. Optimize for readability with short paragraphs.',
      beehiiv:
        'Beehiiv newsletter format. Engaging, personal tone. Start with a hook that makes readers want to continue. Use bullet points for key takeaways. Include a clear CTA. Keep paragraphs short (2-3 sentences).',
      telegraph:
        'Telegraph article format. Clean, minimal formatting. Focus on readability. Use short paragraphs. Include a strong opening. Telegraph supports basic formatting only (bold, italic, links).',
      blogger:
        'Blogger/Blogspot format. SEO-optimized with keywords in headings. Include internal linking suggestions. Add a meta description at the top as a comment. Use proper heading structure.',

      // ===== TIER 2: SUBMIT FOR REVIEW PLATFORMS =====
      hackernoon: `HackerNoon tech editorial submission. Requirements:
- 1500+ words minimum, tech editorial style
- Compelling narrative hook in the first paragraph
- Technical depth with practical insights
- Include a TL;DR section at the top
- Add specific data points and statistics
- End with actionable takeaways
- Include a brief author bio suggestion
- Add 3-5 relevant tags

Also generate:
1. A submission pitch (2-3 sentences explaining why this fits HackerNoon)
2. Key points for editors (3 bullet points)
3. 2 alternative title suggestions`,

      towards_ai: `Towards AI submission. Requirements:
- AI/ML focused content with technical accuracy
- Explain AI concepts clearly for practitioners
- Include code snippets if relevant (Python preferred)
- Add practical applications and use cases
- Reference recent AI research or developments
- Include visualizations or diagram descriptions

Also generate:
1. A pitch for the editors (why this fits Towards AI audience)
2. Suggested categories (Machine Learning, Deep Learning, NLP, Computer Vision, etc.)
3. Key technical concepts covered`,

      analytics_vidhya: `Analytics Vidhya submission. Requirements:
- Data science/analytics tutorial format
- Step-by-step explanations
- Include code examples (Python/R)
- Add dataset references or examples
- Explain statistical concepts clearly
- Include practical exercises or challenges

Also generate:
1. Submission pitch for editors
2. Difficulty level (Beginner/Intermediate/Advanced)
3. Prerequisites for readers`,

      freecodecamp: `freeCodeCamp tutorial submission. Requirements:
- Developer tutorial format, educational tone
- Step-by-step instructions with code examples
- Beginner-friendly explanations
- Include a "What You'll Learn" section
- Add "Prerequisites" section
- Include working code examples
- End with "Next Steps" or further learning resources

Also generate:
1. Pitch explaining educational value
2. Target audience (beginners, intermediate, advanced)
3. Estimated reading/completion time`,

      smashing_magazine: `Smashing Magazine submission. Requirements:
- Web development or design focus
- In-depth, well-researched content
- Include practical examples and demos
- Add browser compatibility notes if relevant
- Professional, authoritative tone
- Include performance considerations

Also generate:
1. Editorial pitch (why this fits Smashing's audience)
2. Key takeaways for readers
3. Related topics for internal linking`,

      sitepoint: `SitePoint submission. Requirements:
- Web development tutorial format
- Practical, hands-on approach
- Include complete code examples
- Add "Quick Tips" or "Pro Tips" sections
- Cover best practices
- Include troubleshooting section

Also generate:
1. Submission pitch
2. Technology stack covered
3. Skill level required`,

      readwrite: `ReadWrite tech news/opinion submission. Requirements:
- Tech industry news or opinion angle
- Current, timely topic
- Include industry context and trends
- Quote or reference industry experts
- Forward-looking analysis
- Accessible to general tech audience

Also generate:
1. News hook (why this is timely)
2. Key industry implications
3. Expert sources to cite`,

      yourstory: `YourStory submission (Indian startup focus). Requirements:
- Founder journey or startup story angle
- Include specific metrics and milestones
- Add challenges overcome and lessons learned
- Indian market context where relevant
- Inspirational but practical tone
- Include founder quotes or insights

Also generate:
1. Pitch emphasizing the founder/startup angle
2. Key metrics to highlight
3. Indian market relevance`,

      startuptalky: `StartupTalky submission. Requirements:
- Indian startup ecosystem focus
- News or analysis format
- Include funding, growth, or milestone data
- Add market context and competition analysis
- Quote founders or industry experts
- Include company background

Also generate:
1. News angle pitch
2. Key data points to highlight
3. Related startups to mention`,

      inc42: `Inc42 submission (Indian tech/startup). Requirements:
- Indian tech industry news angle
- Data-driven analysis
- Include market size and growth projections
- Add competitive landscape
- Quote industry experts
- Professional, journalistic tone

Also generate:
1. News pitch with timeliness angle
2. Key statistics to include
3. Industry experts to quote`,

      techstory: `TechStory submission. Requirements:
- Tech news or startup story format
- Include company/product details
- Add market context
- Quote relevant stakeholders
- Include future outlook
- Accessible writing style

Also generate:
1. Story pitch
2. Key facts to highlight
3. Related stories angle`,

      // ===== TIER 3: DISCUSSION PLATFORMS =====
      reddit: `Reddit discussion post. CRITICAL RULES:
- Value-first, NO self-promotion
- Lead with insights/findings, NOT "I wrote an article about..."
- Sound like a knowledgeable community member sharing discoveries
- Ask genuine questions to spark discussion
- Use markdown formatting
- Be humble and open to feedback

Format:
1. Hook (interesting finding or question)
2. Context (brief background)
3. Key insights (bullet points)
4. Discussion questions (2-3 genuine questions)

Also suggest:
- 3 relevant subreddits with subscriber counts
- Best posting times
- Potential objections to address`,

      indiehackers: `Indie Hackers post. Requirements:
- Founder journey format
- Focus on lessons learned and challenges
- Include specific metrics if available
- Be transparent about failures and pivots
- End with discussion questions
- Builder/maker community tone

Format:
1. The Problem/Opportunity
2. What I Built/Discovered
3. Key Learnings (bullet points with specifics)
4. What's Next
5. Questions for the community

Also generate:
- Engagement hooks
- Metrics to share (if applicable)
- Follow-up discussion topics`,

      producthunt_discussions: `Product Hunt Discussions post. Requirements:
- Product or launch focused
- Problem-solution format
- Invite feedback and suggestions
- Be specific about the product/approach
- Engage with the maker community

Format:
1. Problem statement
2. Solution approach
3. Current status/results
4. Specific questions for feedback

Also generate:
- Discussion title options
- Key features to highlight
- Feedback questions`,

      growthhackers: `GrowthHackers post. Requirements:
- Growth tactics and data focus
- Include specific metrics and results
- Case study format preferred
- Actionable insights
- A/B test results if available

Format:
1. Growth challenge/goal
2. Tactics tried
3. Results with data
4. Key learnings
5. Questions for the community

Also generate:
- Growth metrics to highlight
- Tactics summary
- Discussion questions`,

      hackernews: `Hacker News submission. CRITICAL RULES:
- Technical and objective tone
- NO marketing language whatsoever
- Factual, concise title
- Lead with the most interesting technical aspect
- Be prepared for critical feedback

Format:
1. Submission title (factual, no clickbait)
2. Brief comment to add context (optional)
3. Key technical points

Also generate:
- Alternative titles
- Potential HN objections to address
- Technical depth to emphasize`,

      huggingface_community: `Hugging Face Community post. Requirements:
- AI/ML technical focus
- Include model details or code
- Reference Hugging Face tools/models
- Technical but accessible
- Include reproducibility info

Format:
1. Technical overview
2. Implementation details
3. Results/benchmarks
4. Code snippets
5. Discussion questions

Also generate:
- Relevant models/datasets to reference
- Technical tags
- Collaboration opportunities`,

      // ===== LEGACY PLATFORMS =====
      twitter_thread:
        'Twitter/X thread. 5-10 tweets, each UNDER 280 characters. Number each tweet (1/, 2/, etc). First tweet is a hook. Last tweet is a CTA. Separate tweets with "---". Make each tweet standalone-valuable.',
      newsletter:
        'Email newsletter format. Short paragraphs (2-3 sentences max). Conversational "letter to a friend" tone. Clear sections with bold headers. End with a single CTA. Add a P.S. line. Make it scannable.',
      substack:
        'Substack newsletter. Personal, opinionated voice. Start with "Dear reader" or similar personal opener. Include personal anecdotes or observations. End with invitation to subscribe/share.',
      facebook:
        'Facebook post. Conversational, accessible. Ask a question to drive comments. Keep under 500 words. Use emoji sparingly. End with engagement prompt.',
      instagram:
        'Instagram carousel text. Create 7-10 slides. Each slide: [Slide N - Topic]. First slide is a hook/title. Last slide is CTA. Keep text per slide under 50 words. Visual-first thinking.',
    };

    const rules =
      platformRules[platform] ||
      `Adapt for ${platform}. Keep the core message but match the platform's conventions and audience expectations.`;

    const systemPrompt = `You are an expert content repurposing specialist. Adapt the following article for a specific platform. Output ONLY the adapted content — no explanations, no JSON wrapper, just the ready-to-publish text.

Platform rules: ${rules}`;

    const userPrompt = `ORIGINAL ARTICLE:
Title: ${title}
Tags: ${tags.join(', ')}

${body.slice(0, 6000)}`;

    try {
      const { content } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        category: 'seo_generation',
        temperature: 0.7,
        maxTokens: 4000,
        timeoutMs: 45_000,
      });
      return content;
    } catch (error) {
      this.logger.error(
        `Platform adaptation failed for ${platform}: ${(error as Error).message}`,
      );
      return this.fallbackAdaptContent(post, platform);
    }
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
        return `# ${title}\n\n${body}\n\n---\n${hashtags}`;
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

      const buffer = Buffer.from(b64, 'base64');
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
