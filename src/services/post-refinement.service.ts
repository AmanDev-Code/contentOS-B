import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaPostType, N8nGeneratedContentDto } from '../common/dto/media-intent.dto';
import { stripMarkdownForLinkedIn } from '../common/utils/linkedin-publish-text';

type SupportedPlatform = 'linkedin' | 'x' | 'instagram' | string;

interface RefineInput {
  platform: SupportedPlatform;
  content: N8nGeneratedContentDto;
  sourceUrl?: string;
}

interface RefineQuality {
  score: number;
  passed: boolean;
  reasons: string[];
}

export interface RefinedPostOutput {
  title: string;
  content: string;
  hashtags: string[];
  quality: RefineQuality;
}

@Injectable()
export class PostRefinementService {
  private readonly logger = new Logger(PostRefinementService.name);

  constructor(private readonly configService: ConfigService) {}

  async refine(input: RefineInput): Promise<RefinedPostOutput> {
    this.logger.log(
      JSON.stringify({
        event: 'refinement.start',
        platform: input.platform,
        titleLength: (input.content.title || '').length,
        contentLength: (input.content.content || '').length,
      }),
    );
    if (input.platform === 'linkedin') {
      const deterministic = this.refineLinkedIn(input);
      const llmRefined = await this.tryLlmRefinement(input, deterministic);
      const base = llmRefined || deterministic;
      const result = {
        ...base,
        content: this.polishLinkAndAttribution(base.content),
      };
      this.logger.log(
        JSON.stringify({
          event: 'refinement.done',
          platform: input.platform,
          mode: llmRefined ? 'llm' : 'deterministic',
          qualityScore: result.quality.score,
          qualityPassed: result.quality.passed,
          outputLength: result.content.length,
        }),
      );
      return result;
    }
    const deterministic = this.refineLinkedIn(input);
    const llmRefined = await this.tryLlmRefinement(input, deterministic);
    const base = llmRefined || deterministic;
    const result = {
      ...base,
      content: this.polishLinkAndAttribution(base.content),
    };
    this.logger.log(
      JSON.stringify({
        event: 'refinement.done',
        platform: input.platform,
        mode: llmRefined ? 'llm' : 'deterministic',
        qualityScore: result.quality.score,
        qualityPassed: result.quality.passed,
        outputLength: result.content.length,
      }),
    );
    return result;
  }

  private refineLinkedIn(input: RefineInput): RefinedPostOutput {
    const rawTitle = this.cleanInlineHashtagTokens(input.content.title || '').trim();
    const rawBody = this.cleanInlineHashtagTokens(input.content.content || '').trim();
    const normalizedBody = this.normalizeBodyText(rawBody);
    const title = rawTitle || 'New insight';

    const normalizedHashtags = this.normalizeHashtags(
      input.content.hashtags || this.extractHashtagsFromText(normalizedBody),
    );
    const sourceUrl = this.extractFirstUrl(input.sourceUrl || normalizedBody);

    const meaningfulLines = normalizedBody
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith('http') &&
          !line.startsWith('#') &&
          !line.startsWith('🔗'),
      );

    const baseSentences = this.toSentences(meaningfulLines.join(' ')).slice(0, 10);
    const keyPoints = this.uniqueSentences(
      baseSentences.slice(0, 4).map((sentence) => this.trimSentence(sentence)),
    ).slice(0, 3);

    const tone = this.inferTone(`${title}\n${rawBody}`);
    const hookEmoji = tone === 'inspiring' ? '🚀' : tone === 'urgent' ? '⚡' : '✨';

    const intro =
      tone === 'inspiring'
        ? `${hookEmoji} ${title}`
        : tone === 'urgent'
          ? `${hookEmoji} Why this matters now: ${title}`
          : `${hookEmoji} ${title}`;

    const sections: string[] = [intro];
    const actionItems = this.uniqueSentences(
      baseSentences.slice(3, 7).map((sentence) => this.trimSentence(sentence)),
    ).slice(0, 3);
    const styleVariant = this.hashNumber(title) % 3;
    const leadSentence =
      keyPoints[0] || this.trimSentence(baseSentences[0] || normalizedBody);
    const detailSentence =
      keyPoints[1] || this.trimSentence(baseSentences[1] || leadSentence);

    if (leadSentence) {
      sections.push(leadSentence);
    }

    if (styleVariant === 0) {
      // Narrative style: short flow, no explicit labels.
      if (detailSentence) sections.push(detailSentence);
      if (actionItems.length > 0) {
        sections.push(actionItems.map((item) => `• ${item}`).join('\n'));
      }
    } else if (styleVariant === 1) {
      // Insight style: tighter summary + numbered moves.
      const summary = this.uniqueSentences([detailSentence, ...keyPoints.slice(2)])
        .filter(Boolean)
        .slice(0, 2)
        .join(' ');
      if (summary) sections.push(summary);
      if (actionItems.length > 0) {
        sections.push(
          actionItems.slice(0, 2).map((item, idx) => `${idx + 1}) ${item}`).join('\n'),
        );
      }
    } else {
      // Contrarian / alternate framing — always anchored in extracted points, no generic filler.
      const contrarianLead = this.buildContrarianLead(title, leadSentence, detailSentence, keyPoints);
      if (contrarianLead) sections.push(contrarianLead);
      const bullets = this.uniqueSentences(keyPoints.slice(1))
        .filter(Boolean)
        .slice(0, 2)
        .map((point) => `• ${point}`);
      if (bullets.length > 0) sections.push(bullets.join('\n'));
      if (actionItems.length > 0) {
        sections.push(actionItems.slice(0, 2).join(' '));
      }
    }

    if (input.content.postType === MediaPostType.CAROUSEL && input.content.slides?.length) {
      const carouselIntro = this.carouselIntroLine(title);
      sections.push(carouselIntro);
      sections.push(
        input.content.slides
          .slice(0, 4)
          .map((slide, idx) => `${idx + 1}. ${this.trimSentence(slide.headline || slide.body)}`)
          .join('\n'),
      );
    }

    sections.push(this.pickClosingQuestion(tone, title, keyPoints));

    if (sourceUrl) {
      sections.push(`Read more: ${sourceUrl}`);
    }

    const draftContent = sections.filter(Boolean).join('\n\n').trim();
    const hashtagsForAppend = this.removeHashtagsAlreadyInBody(
      normalizedHashtags,
      draftContent,
    );
    // Do not append hashtags into body text; frontend renders hashtags from array.

    let refinedContent = sections.filter(Boolean).join('\n\n').trim();
    refinedContent = this.injectSourceIntoPlaceholder(refinedContent, sourceUrl);
    refinedContent = this.stripTrailingHashtagLines(refinedContent);
    refinedContent = stripMarkdownForLinkedIn(refinedContent);
    refinedContent = this.removeDuplicateLines(refinedContent);
    refinedContent = this.stripFormattingNoise(refinedContent);
    const finalHashtags =
      hashtagsForAppend.length > 0 ? hashtagsForAppend : normalizedHashtags;
    const quality = this.assessQuality({
      refinedContent,
      hashtags: finalHashtags,
      sourceUrl,
      keyPointCount: keyPoints.length,
    });

    // If quality is weak, regenerate once with stricter logical skeleton.
    if (!quality.passed) {
      const fallbackContent = this.buildFallbackLinkedInContent({
        title,
        baseSentences,
        hashtags: normalizedHashtags,
        sourceUrl,
      });
      const fallbackQuality = this.assessQuality({
        refinedContent: fallbackContent,
        hashtags: normalizedHashtags,
        sourceUrl,
        keyPointCount: Math.max(2, Math.min(3, baseSentences.length)),
      });
      return {
        title,
        content: this.stripFormattingNoise(
          this.removeDuplicateLines(
            stripMarkdownForLinkedIn(
              this.stripTrailingHashtagLines(
                this.removeDuplicateHeadingBlocks(fallbackContent),
              ),
            ),
          ),
        ),
        hashtags: finalHashtags,
        quality: fallbackQuality,
      };
    }

    return {
      title,
      content: this.stripFormattingNoise(
        this.removeDuplicateHeadingBlocks(refinedContent),
      ),
      hashtags: finalHashtags,
      quality,
    };
  }

  private buildFallbackLinkedInContent(input: {
    title: string;
    baseSentences: string[];
    hashtags: string[];
    sourceUrl?: string;
  }): string {
    const skeletonPoints = input.baseSentences
      .slice(0, 3)
      .map((s) => `• ${this.trimSentence(s)}`)
      .join('\n');
    const closing = this.pickClosingQuestion('neutral', input.title, input.baseSentences);
    const lines = [
      `🚀 ${input.title}`,
      skeletonPoints || '• Clear insight\n• Practical value\n• Immediate application',
      closing,
      input.sourceUrl ? input.sourceUrl : '',
    ].filter(Boolean);
    return lines.join('\n\n');
  }

  private assessQuality(input: {
    refinedContent: string;
    hashtags: string[];
    sourceUrl?: string;
    keyPointCount: number;
  }): RefineQuality {
    const reasons: string[] = [];
    let score = 100;

    if (input.refinedContent.length < 120) {
      score -= 30;
      reasons.push('content_too_short');
    }
    if (input.keyPointCount < 2) {
      score -= 25;
      reasons.push('missing_logic_points');
    }
    if (!input.refinedContent.includes('?')) {
      score -= 10;
      reasons.push('missing_cta_question');
    }
    if (!/\b(I|my|we|our)\b/i.test(input.refinedContent)) {
      score -= 10;
      reasons.push('missing_personal_voice');
    }
    if (input.hashtags.length === 0) {
      score -= 10;
      reasons.push('missing_hashtags');
    }
    if (input.sourceUrl && !input.refinedContent.includes(input.sourceUrl)) {
      score -= 15;
      reasons.push('missing_source_url');
    }

    // Stale content signal: explicit old-year references.
    const nowYear = new Date().getUTCFullYear();
    const years = Array.from(input.refinedContent.matchAll(/\b(20\d{2})\b/g)).map((m) =>
      Number(m[1]),
    );
    const hasVeryOldYear = years.some((y) => y < nowYear - 2);
    if (hasVeryOldYear) {
      score -= 20;
      reasons.push('possible_stale_reference');
    }

    return {
      score,
      passed: score >= 60,
      reasons,
    };
  }

  private inferTone(text: string): 'inspiring' | 'urgent' | 'neutral' {
    const lower = text.toLowerCase();
    if (
      lower.includes('now') ||
      lower.includes('urgent') ||
      lower.includes('critical') ||
      lower.includes('immediately')
    ) {
      return 'urgent';
    }
    if (
      lower.includes('innovation') ||
      lower.includes('future') ||
      lower.includes('growth') ||
      lower.includes('opportunity')
    ) {
      return 'inspiring';
    }
    return 'neutral';
  }

  private extractFirstUrl(text?: string): string | undefined {
    if (!text) return undefined;
    const match = text.match(/https?:\/\/[^\s\])]+/i);
    if (!match?.[0]) return undefined;
    return this.sanitizeUrl(match[0]);
  }

  private normalizeHashtags(values: string[]): string[] {
    const cleaned = values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => {
        const token = value.replace(/^#+/, '').replace(/[^a-zA-Z0-9_]/g, '');
        return token ? `#${token}` : '';
      })
      .filter(Boolean);
    return Array.from(new Set(cleaned)).slice(0, 12);
  }

  private extractHashtagsFromText(text: string): string[] {
    const matches = Array.from(text.matchAll(/#([a-zA-Z0-9_]+)/g)).map((m) => `#${m[1]}`);
    return Array.from(new Set(matches));
  }

  private toSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
  }

  private trimSentence(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 220) return normalized;
    return `${normalized.slice(0, 217).trim()}...`;
  }

  private cleanInlineHashtagTokens(text: string): string {
    return text.replace(/\{hashtag\|\\?#\|([^}]+)\}/gi, '#$1');
  }

  private normalizeBodyText(text: string): string {
    let t = String(text || '').trim();
    t = this.flattenMarkdownLinks(t);
    t = this.dedupeRepeatedUrlTail(t);
    t = t.replace(/\[[^\]]*https?:\/\/[^\]]+\]/gi, (m) => m.replace(/^\[|\]$/g, ''));
    t = this.stripReadMoreAttributionParagraphs(t);
    t = t.replace(/read more[^:]*:\s*/gi, '');
    return t.replace(/\s+$/g, '').trim();
  }

  /** [label](url) → plain URL (or "label url") so scrapers/UI never see duplicate bracket links. */
  private flattenMarkdownLinks(text: string): string {
    return text.replace(/\[([^\]]*)\]\((https?:[^)\s]+)\)/gi, (_m, label, url) => {
      const u = this.sanitizeUrl(String(url));
      const l = String(label || '')
        .trim()
        .replace(/^<|>$/g, '');
      if (!l || l === u || /^https?:\/\//i.test(l)) return u;
      if (l.length <= 2) return u;
      return `${l} ${u}`;
    });
  }

  /** Collapse patterns like "https://a (https://a)" from n8n / editors. */
  private dedupeRepeatedUrlTail(text: string): string {
    let t = text;
    t = t.replace(/(https?:\/\/[^\s)]+)\s*\(\s*\1\s*\)/gi, '$1');
    t = t.replace(/\(\s*(https?:\/\/[^\s)]+)\s*\)\s*\(\s*\1\s*\)/gi, '($1)');
    return t;
  }

  /** Drop trailing "Read more … [url]" blocks; we add a single Read more line later. */
  private stripReadMoreAttributionParagraphs(text: string): string {
    const blocks = text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    const kept = blocks.filter((b) => !this.isReadMoreAttributionBlock(b));
    return kept.join('\n\n').trim();
  }

  private isReadMoreAttributionBlock(block: string): boolean {
    if (!/https?:\/\//i.test(block)) return false;
    if (block.length > 650) return false;
    return (
      /read more|full article|source\s*:|articleshow|magazines\/panache/i.test(block) ||
      /^\(?read more\b/i.test(block)
    );
  }

  /** Remove accidental line breaks inside bare URLs (prevents "…purchase" / "s/" split in UI). */
  private stripNewlinesInsideUrls(text: string): string {
    return text.replace(/https?:\/\/[^\s]+/gi, (url) => url.replace(/\s+/g, ''));
  }

  /** Final pass: flatten any leftover links, dedupe URLs, collapse duplicate Read more lines. */
  private polishLinkAndAttribution(text: string): string {
    let t = String(text || '').trim();
    t = this.stripNewlinesInsideUrls(t);
    t = this.flattenMarkdownLinks(t);
    t = this.dedupeRepeatedUrlTail(t);
    t = this.stripReadMoreAttributionParagraphs(t);
    t = this.collapseDuplicateReadMoreLines(t);
    t = this.stripTrailingHashtagLines(t);
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  private collapseDuplicateReadMoreLines(text: string): string {
    const lines = text.split('\n');
    let keptLastReadMore = false;
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const trimmed = line.trim();
      if (/^read more:/i.test(trimmed)) {
        if (keptLastReadMore) continue;
        keptLastReadMore = true;
      }
      out.push(line);
    }
    return out.reverse().join('\n');
  }

  /** Stable 32-bit hash for layout variety (not crypto). */
  private hashNumber(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  private buildContrarianLead(
    title: string,
    lead: string,
    detail: string,
    keyPoints: string[],
  ): string {
    const a = (lead || keyPoints[0] || title || '').trim();
    const b = (detail || keyPoints[1] || keyPoints[0] || '').trim();
    if (!a) return '';
    const mode = this.hashNumber(`${title}\n${a}`) % 4;
    const aLow = a.charAt(0).toLowerCase() + a.slice(1);
    const bLow = b && b !== a ? b.charAt(0).toLowerCase() + b.slice(1) : '';
    switch (mode) {
      case 0:
        return bLow
          ? `The easy story is ${aLow} I'd sit with the less comfortable bit: ${bLow}`
          : `I'd push back gently on the obvious read: ${aLow}`;
      case 1:
        return `I'd flip the usual takeaway — ${aLow}`;
      case 2:
        return bLow
          ? `Most people stop at ${aLow} I keep going because ${bLow}`
          : `I'm stress-testing this in my head: ${aLow}`;
      default:
        return `If I had to keep one line top of mind: ${aLow}`;
    }
  }

  private carouselIntroLine(title: string): string {
    const variants = [
      'Quick slide-by-slide:',
      'How I’d walk through this:',
      'The thread in the carousel:',
    ];
    return variants[this.hashNumber(title) % variants.length];
  }

  private pickClosingQuestion(
    tone: 'inspiring' | 'urgent' | 'neutral',
    title: string,
    keyPoints: string[],
  ): string {
    const seed = `${tone}:${title}:${keyPoints[0] || ''}`;
    const h = this.hashNumber(seed);
    if (tone === 'urgent') {
      const urgent = [
        'If you had to ship one change this week, what would it be?',
        'What’s the first move you’d make today?',
        'Where would you tighten the loop first?',
      ];
      return urgent[h % urgent.length];
    }
    const neutral = [
      'What are you seeing in your corner of the industry?',
      'Does this line up with what your team is experiencing?',
      'What would you add — or challenge — here?',
      'Where would you take this idea next?',
    ];
    return neutral[h % neutral.length];
  }

  private uniqueSentences(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(value);
    }
    return out;
  }

  private removeHashtagsAlreadyInBody(hashtags: string[], body: string): string[] {
    const lowerBody = body.toLowerCase();
    return hashtags.filter((tag) => !lowerBody.includes(tag.toLowerCase()));
  }

  private removeDuplicateHeadingBlocks(text: string): string {
    const lines = text.split('\n');
    const output: string[] = [];
    let previousNormalized = '';
    const headingLike = (normalized: string) =>
      normalized === '💡 _why this caught my attention:_' ||
      normalized === '_what stands out to me:_' ||
      normalized === '**how teams can respond:**' ||
      normalized === 'carousel flow:' ||
      normalized === '_carousel flow:_' ||
      normalized === 'key takeaways:' ||
      /^why this caught my attention:?$/.test(normalized) ||
      /^what stands out to me:?$/.test(normalized) ||
      /^my take:?$/.test(normalized);
    for (const line of lines) {
      const normalized = line.trim().toLowerCase().replace(/[_*]+/g, '');
      if (headingLike(normalized) && normalized === previousNormalized) {
        continue;
      }
      output.push(line);
      if (normalized.length > 0) {
        previousNormalized = normalized;
      }
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private injectSourceIntoPlaceholder(
    text: string,
    sourceUrl?: string,
  ): string {
    if (!sourceUrl) {
      // Strip any placeholder patterns when no source URL is provided
      return text
        .replace(/🔗\s*\[Source URL\]/gi, '')
        .replace(/🔗\s*\[Source\]/gi, '')
        .replace(/\[Source URL\]/gi, '')
        .replace(/\[link to [^\]]+\]/gi, '')
        .replace(/\[source\]/gi, '')
        .replace(/\[read more\]/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    const placeholderRegex =
      /\[link to [^\]]+\]|\[source\]|\[read more\]|\[Source URL\]/i;
    if (!placeholderRegex.test(text)) return text;
    return text.replace(placeholderRegex, sourceUrl);
  }

  private stripTrailingHashtagLines(text: string): string {
    const lines = text.split('\n');
    const cleaned: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const isHashtagOnlyLine =
        trimmed.length > 0 &&
        trimmed
          .split(/\s+/)
          .every((token) => /^#[a-z0-9_]+$/i.test(token));
      if (isHashtagOnlyLine) {
        continue;
      }
      cleaned.push(line);
    }
    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private removeDuplicateLines(text: string): string {
    const lines = text.split('\n');
    const output: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      const normalized = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9#]+/g, ' ')
        .trim();
      if (!trimmed) {
        output.push(line);
        continue;
      }
      const isHeading = /:$/.test(trimmed);
      if (!isHeading && normalized.length > 0 && seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(line);
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private stripFormattingNoise(text: string): string {
    return text
      .replace(/^[;,*_]+\s*/gm, '')
      .replace(/\s+[;]+$/gm, '')
      .replace(/mytake/gi, '')
      // Drop common “AI section” labels; keep the rest of the line if present.
      .replace(/^_?\*?my take\*?:_?\s*/gim, '')
      .replace(/^_?\*?why this caught my attention\*?:_?\s*/gim, '')
      .replace(/^_?\*?what stands out to me\*?:_?\s*/gim, '')
      .replace(/^_?\*?how teams can respond\*?:_?\s*/gim, '')
      .replace(/^_?\*?carousel flow\*?:_?\s*/gim, '')
      .replace(/^_?\*?key takeaways\*?:_?\s*/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private sanitizeUrl(url: string): string {
    let cleaned = url.trim();
    cleaned = cleaned.replace(/[).,\]]+$/g, '');
    if (cleaned.endsWith('...')) {
      cleaned = cleaned.slice(0, -3);
    }
    return cleaned;
  }

  /** Primary model + optional AI_REFINEMENT_FALLBACK_MODELS only (no silent substitution). */
  private buildLlmModelAttemptList(primary: string): string[] {
    const extras = (process.env.AI_REFINEMENT_FALLBACK_MODELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([primary, ...extras].filter(Boolean)));
  }

  private llmErrorWarrantsModelSwitch(status: number, body: string): boolean {
    if (status === 404 || status === 503) return true;
    const b = body.toLowerCase();
    return (
      b.includes('no allowed providers') ||
      b.includes('model not found') ||
      b.includes('invalid model') ||
      b.includes('does not exist')
    );
  }

  /** Parse JSON from strict mode, fenced blocks, or largest {...} slice (non–JSON-mode completions). */
  private tryParseJsonFromLlmPayload(text: string): any | null {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      /* continue */
    }
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* continue */
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }

  private async tryLlmRefinement(
    input: RefineInput,
    fallback: RefinedPostOutput,
  ): Promise<RefinedPostOutput | null> {
    const enabled = (process.env.AI_REFINEMENT_ENABLED || 'true') !== 'false';
    if (!enabled) {
      this.logger.log(
        JSON.stringify({
          event: 'refinement.llm.skip',
          reason: 'disabled',
        }),
      );
      return null;
    }

    const baseUrl =
      this.configService.get<string>('aiRefinement.baseUrl') ||
      process.env.AI_REFINEMENT_BASE_URL ||
      'https://openrouter.ai/api/v1';
    const model =
      this.configService.get<string>('aiRefinement.model') ||
      process.env.AI_REFINEMENT_MODEL ||
      (baseUrl.includes('openrouter.ai')
        ? 'z-ai/glm-4.5-air:free'
        : 'gpt-4.1-mini');
    const apiKey =
      this.configService.get<string>('aiRefinement.apiKey') ||
      process.env.AI_REFINEMENT_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      (baseUrl.includes('openrouter.ai') ? '' : process.env.OPENAI_API_KEY || '');
    if (!apiKey) {
      this.logger.warn(
        JSON.stringify({
          event: 'refinement.llm.skip',
          reason: baseUrl.includes('openrouter.ai')
            ? 'missing_openrouter_api_key'
            : 'missing_api_key',
          baseUrl,
        }),
      );
      return null;
    }
    const timeoutMs = Number(
      this.configService.get<string>('aiRefinement.timeoutMs') ||
        process.env.AI_REFINEMENT_TIMEOUT_MS ||
        '12000',
    );
    const referer =
      this.configService.get<string>('aiRefinement.referer') ||
      process.env.AI_REFINEMENT_REFERER ||
      '';
    const appTitle =
      this.configService.get<string>('aiRefinement.appTitle') ||
      process.env.AI_REFINEMENT_APP_TITLE ||
      'Trndinn';
    const modelCandidates = this.buildLlmModelAttemptList(model);
    this.logger.log(
      JSON.stringify({
        event: 'refinement.llm.start',
        models: modelCandidates,
        baseUrl,
        timeoutMs,
        hasApiKey: Boolean(apiKey),
      }),
    );

    const sourceUrl =
      input.sourceUrl ||
      this.extractFirstUrl(input.content.content || '') ||
      this.extractFirstUrl(fallback.content);
    const originalHashtags = this.normalizeHashtags(input.content.hashtags || []);
    const fallbackHashtags = this.normalizeHashtags(fallback.hashtags || []);
    const seedHashtags = originalHashtags.length > 0 ? originalHashtags : fallbackHashtags;

    const systemPrompt =
      'You are a world-class LinkedIn ghostwriter. Rewrite posts to feel deeply human, emotionally intelligent, and unique per request. Vary structure every time (do not reuse the same outline). Keep facts and intent intact, avoid hallucinations, and produce polished LinkedIn-ready content.';
    const sourceUrlLine = sourceUrl
      ? `Source URL: ${sourceUrl}`
      : 'Source URL: (none provided — do NOT add any source URL placeholder or link to the content)';
    const userPrompt = [
      'Rewrite this content for LinkedIn with strong human voice and emotional clarity.',
      'Requirements:',
      '- Keep context and factual claims from source; do not invent facts.',
      '- Write in first-person creator/founder style with personality.',
      '- Never use template labels like: "My take", "Why this caught my attention", "What stands out", "Key takeaways", or "Carousel flow".',
      '- Use natural, selective emojis only when they improve tone.',
      '- Add structure using short paragraphs plus either bullets or numbered steps when useful.',
      '- For numbered lists, use one consistent label style for every item (prefer **Label:** then the sentence; do not alternate *italics* and **bold** between items).',
      '- Put all hashtags only in the "hashtags" JSON array — do not paste hashtag lines into the content body.',
      '- Emphasize key phrases using **bold**, *italic*, and optionally __underline__ or ==highlight== where meaningful.',
      '- End with a thoughtful CTA question.',
      '- Include the source URL once ONLY if a real URL is provided. If no source URL is provided, do NOT add any placeholder like "[Source URL]" or "🔗 [Source URL]".',
      '- Include relevant hashtags at end; preserve provided hashtags unless clearly irrelevant.',
      '- Keep output under 2200 characters.',
      '',
      `Title: ${input.content.title || ''}`,
      sourceUrlLine,
      `Provided hashtags: ${seedHashtags.join(' ')}`,
      '',
      'Original content:',
      input.content.content || '',
      '',
      'Return strict JSON only with keys:',
      '{"title":"string","content":"string","hashtags":["#tag"],"tone":"string"}',
    ].join('\n');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (baseUrl.includes('openrouter.ai')) {
      if (referer) headers['HTTP-Referer'] = referer;
      if (appTitle) {
        headers['X-Title'] = appTitle;
        headers['X-OpenRouter-Title'] = appTitle;
      }
    }

    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    for (let i = 0; i < modelCandidates.length; i++) {
      const m = modelCandidates[i];
      this.logger.log(
        JSON.stringify({
          event: 'refinement.llm.attempt',
          model: m,
          index: i,
          total: modelCandidates.length,
        }),
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const chatPayload = (useJsonObjectMode: boolean) =>
          JSON.stringify({
            model: m,
            temperature: 0.8,
            ...(useJsonObjectMode
              ? { response_format: { type: 'json_object' } }
              : {}),
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          });

        let response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: chatPayload(true),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errText = await response.text();
          if (
            response.status === 400 &&
            /response_format|json_object|response format|json mode/i.test(
              errText,
            )
          ) {
            this.logger.warn(
              JSON.stringify({
                event: 'refinement.llm.retry_without_json_mode',
                model: m,
              }),
            );
            response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: chatPayload(false),
              signal: controller.signal,
            });
            if (!response.ok) {
              errText = await response.text();
            }
          }

          if (!response.ok) {
            const canRetry =
              this.llmErrorWarrantsModelSwitch(response.status, errText) &&
              i < modelCandidates.length - 1;
            this.logger.warn(
              JSON.stringify({
                event: 'refinement.llm.http_error',
                model: m,
                status: response.status,
                body: errText.slice(0, 500),
                willRetryFallback: canRetry,
              }),
            );
            if (canRetry) continue;
            return null;
          }
        }

        const json = (await response.json()) as any;
        const text = String(json?.choices?.[0]?.message?.content || '').trim();
        if (!text) {
          this.logger.warn(
            JSON.stringify({
              event: 'refinement.llm.empty_response',
              model: m,
            }),
          );
          return null;
        }

        const parsed = this.tryParseJsonFromLlmPayload(text);
        if (!parsed) {
          this.logger.warn(
            JSON.stringify({
              event: 'refinement.llm.invalid_json',
              model: m,
              sample: text.slice(0, 300),
            }),
          );
          return null;
        }

        const title = String(parsed?.title || fallback.title || '').trim().slice(0, 180);
        const content = this.injectSourceIntoPlaceholder(
          String(parsed?.content || '').trim().slice(0, 5000),
          sourceUrl,
        );
        const hashtags = this.normalizeHashtags(
          Array.isArray(parsed?.hashtags) ? parsed.hashtags : seedHashtags,
        );
        if (!title || !content) return null;

        const quality = this.assessQuality({
          refinedContent: content,
          hashtags,
          sourceUrl,
          keyPointCount: Math.max(2, this.toSentences(content).length),
        });
        if (!quality.passed || quality.score < 70) {
          this.logger.warn(
            JSON.stringify({
              event: 'refinement.llm.rejected_quality',
              model: m,
              score: quality.score,
              reasons: quality.reasons,
            }),
          );
          return null;
        }
        this.logger.log(
          JSON.stringify({
            event: 'refinement.llm.success',
            model: m,
            qualityScore: quality.score,
            outputLength: content.length,
          }),
        );

        return { title, content, hashtags, quality };
      } catch (error) {
        const msg = (error as Error).message;
        const canRetry = i < modelCandidates.length - 1;
        this.logger.warn(
          JSON.stringify({
            event: 'refinement.llm.exception',
            model: m,
            message: msg,
            willRetryFallback: canRetry,
          }),
        );
        if (canRetry) continue;
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    return null;
  }
}

