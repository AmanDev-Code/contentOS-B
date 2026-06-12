import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppSettingsService } from './app-settings.service';
import {
  buildResearchPromptContext,
  formatResearchSystemBlock,
  type ResearchPromptContext,
} from './web-research-intent';

export type { ResearchPromptContext };

export const WEB_RESEARCH_SETTINGS_KEY = 'web_research_config';

export interface WebResearchConfig {
  tavilyApiKey?: string;
  enabled: boolean;
  maxResults: number;
  searchDepth: 'basic' | 'advanced';
  /** Topic hint for Tavily: "general" | "news" | "finance" */
  defaultTopic: 'general' | 'news' | 'finance';
  /** Time range filter: undefined = all time, or "day"|"week"|"month"|"year" */
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

export interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number;
}

export interface WebResearchResult {
  query: string;
  answer?: string;
  sources: Array<{
    title: string;
    url: string;
    snippet: string;
    relevance: number;
    publishedDate?: string;
  }>;
  researchSummary: string;
  responseTimeMs: number;
}

const DEFAULT_CONFIG: WebResearchConfig = {
  enabled: true,
  maxResults: 5,
  searchDepth: 'basic',
  defaultTopic: 'general',
};

@Injectable()
export class WebResearchService implements OnModuleInit {
  private readonly logger = new Logger(WebResearchService.name);
  private config: WebResearchConfig = { ...DEFAULT_CONFIG };
  private lastRefresh = 0;
  private static readonly REFRESH_MS = 30_000;
  private static readonly TAVILY_URL = 'https://api.tavily.com/search';

  constructor(
    private readonly configService: ConfigService,
    private readonly appSettings: AppSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshConfig();
    this.logger.log(
      `WebResearch initialized: enabled=${this.config.enabled}, hasKey=${!!this.getApiKey()}`,
    );
  }

  private getApiKey(): string | undefined {
    return (
      this.config.tavilyApiKey ||
      this.configService.get<string>('TAVILY_API_KEY')
    );
  }

  private async refreshConfig(): Promise<void> {
    try {
      const stored =
        await this.appSettings.get<WebResearchConfig>(WEB_RESEARCH_SETTINGS_KEY);
      if (stored) {
        this.config = { ...DEFAULT_CONFIG, ...stored };
      } else {
        this.config = {
          ...DEFAULT_CONFIG,
          enabled:
            this.configService.get<string>('WEB_RESEARCH_ENABLED') !== 'false',
          maxResults: parseInt(
            this.configService.get<string>('WEB_RESEARCH_MAX_RESULTS') || '5',
            10,
          ),
        };
      }
      this.lastRefresh = Date.now();
    } catch (e) {
      this.logger.warn(`Config refresh failed: ${(e as Error).message}`);
    }
  }

  private async ensureFreshConfig(): Promise<void> {
    if (Date.now() - this.lastRefresh > WebResearchService.REFRESH_MS) {
      await this.refreshConfig();
    }
  }

  isEnabled(): boolean {
    return this.config.enabled && !!this.getApiKey();
  }

  async getConfig(): Promise<
    Omit<WebResearchConfig, 'tavilyApiKey'> & {
      hasApiKey: boolean;
      keyPreview: string;
    }
  > {
    await this.ensureFreshConfig();
    const key = this.getApiKey();
    return {
      enabled: this.config.enabled,
      maxResults: this.config.maxResults,
      searchDepth: this.config.searchDepth,
      defaultTopic: this.config.defaultTopic,
      timeRange: this.config.timeRange,
      hasApiKey: !!key,
      keyPreview: key ? `${key.slice(0, 12)}…${key.slice(-4)}` : '',
    };
  }

  async updateConfig(
    patch: Partial<WebResearchConfig>,
    updatedBy?: string,
  ): Promise<void> {
    await this.ensureFreshConfig();
    const next: WebResearchConfig = { ...this.config, ...patch };
    if (patch.tavilyApiKey === '') {
      next.tavilyApiKey = undefined;
    }
    await this.appSettings.set(WEB_RESEARCH_SETTINGS_KEY, next, updatedBy);
    this.config = next;
    this.lastRefresh = Date.now();
    this.logger.log(
      `WebResearch config updated: enabled=${next.enabled}, hasKey=${!!this.getApiKey()}`,
    );
  }

  /**
   * Run a Tavily web search for content generation context.
   * Returns null if disabled or if the search fails (non-blocking).
   */
  async search(
    topic: string,
    opts?: {
      maxResults?: number;
      searchDepth?: 'basic' | 'advanced';
      tavilyTopic?: 'general' | 'news' | 'finance';
      timeRange?: 'day' | 'week' | 'month' | 'year';
      includeAnswer?: boolean;
      platform?: string;
    },
  ): Promise<WebResearchResult | null> {
    const ctx = buildResearchPromptContext(topic, opts?.platform);
    return this.searchWithContext(topic, ctx, opts);
  }

  /**
   * Search using a pre-built prompt context (smart query + news/time hints).
   */
  async searchWithContext(
    originalTopic: string,
    ctx: ResearchPromptContext,
    opts?: {
      maxResults?: number;
      searchDepth?: 'basic' | 'advanced';
      tavilyTopic?: 'general' | 'news' | 'finance';
      timeRange?: 'day' | 'week' | 'month' | 'year';
      includeAnswer?: boolean;
    },
  ): Promise<(WebResearchResult & { promptContext: ResearchPromptContext }) | null> {
    await this.ensureFreshConfig();

    const apiKey = this.getApiKey();
    if (!this.config.enabled || !apiKey) {
      this.logger.debug('Web research skipped: disabled or no API key');
      return null;
    }

    // Tavily caps the query length; never strip keywords, just hard-cap.
    const query = ctx.searchQuery.slice(0, 400);
    const topic =
      opts?.tavilyTopic || ctx.tavilyTopic || this.config.defaultTopic;
    const timeRange =
      opts?.timeRange || ctx.timeRange || this.config.timeRange || undefined;
    const body: Record<string, unknown> = {
      query,
      search_depth: opts?.searchDepth || this.config.searchDepth,
      max_results: opts?.maxResults || this.config.maxResults,
      topic,
      include_answer: opts?.includeAnswer ?? true,
      include_raw_content: false,
      time_range: timeRange,
    };
    // For the news agent, also pass an explicit lookback window (Tavily's `days`
    // only applies to topic=news) so we bias hard toward the freshest sources.
    if (topic === 'news') {
      body.days = WebResearchService.freshnessToDays(timeRange);
    }

    const startMs = Date.now();
    try {
      const res = await fetch(WebResearchService.TAVILY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        this.logger.warn(
          `Tavily ${res.status}: ${errText.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await res.json()) as TavilyResponse;
      const elapsed = Date.now() - startMs;

      const result: WebResearchResult & { promptContext: ResearchPromptContext } = {
        query: data.query || query,
        answer: data.answer || undefined,
        sources: (data.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          relevance: r.score,
          publishedDate: r.published_date,
        })),
        researchSummary: this.buildResearchSummary(data),
        responseTimeMs: elapsed,
        promptContext: ctx,
      };

      this.logger.log(
        `Tavily search OK: "${query}" (intent=${ctx.isResearchIntent}) → ${result.sources.length} sources in ${elapsed}ms`,
      );

      return result;
    } catch (e) {
      const elapsed = Date.now() - startMs;
      this.logger.warn(
        `Tavily search failed after ${elapsed}ms: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Format research results as a prompt-injection block for the LLM system message.
   */
  formatForPrompt(
    research: WebResearchResult,
    originalTopic: string,
    ctx?: ResearchPromptContext,
  ): string {
    const promptCtx =
      ctx ?? buildResearchPromptContext(originalTopic);
    return formatResearchSystemBlock(research, promptCtx, originalTopic);
  }

  buildPromptContext(topic: string, platform?: string): ResearchPromptContext {
    return buildResearchPromptContext(topic, platform);
  }

  /** News lookback window in days for a relative time range (default 14). */
  private static freshnessToDays(
    range?: 'day' | 'week' | 'month' | 'year',
  ): number {
    switch (range) {
      case 'day':
        return 1;
      case 'week':
        return 7;
      case 'month':
        return 30;
      case 'year':
        return 365;
      default:
        return 14;
    }
  }

  private buildResearchSummary(data: TavilyResponse): string {
    if (data.answer) return data.answer;
    const topResults = (data.results || []).slice(0, 3);
    return topResults.map((r) => r.content.slice(0, 150)).join(' | ');
  }
}
