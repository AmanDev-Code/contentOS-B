import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProfileRepository } from '../repositories/profile.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { ERROR_MESSAGES } from '../common/constants';
import { ScraperCredentialsService } from './scrapers/scraper-credentials.service';

type InsightSource = 'linkedin_analytics' | 'organization_analytics' | 'published_posts';

interface LinkedInInsightItem {
  title: 'Best Posting Time' | 'Top Content Type' | 'Engagement Rate' | 'Growth Rate';
  value: string;
  description: string;
  trend: string;
  source: InsightSource;
}

export interface LinkedInAccountTypeContext {
  accountType: 'organization_admin' | 'personal';
  linkedMemberId: string | null;
  organizationAdminCount: number;
  organizationNames: string[];
  canViewEngagementMetrics: boolean;
  reason: string;
}

export interface LinkedInPostingIdentity {
  id: string;
  actorType: 'member' | 'organization';
  label: string;
  organizationUrn?: string;
  organizationName?: string;
  avatarUrl?: string;
}

export interface LinkedInInsightsPayload {
  hasData: boolean;
  periodDays: number;
  accountType: 'organization_admin' | 'personal';
  canViewEngagementMetrics: boolean;
  engagementMetricsMessage: string;
  bestPostingTime: string | null;
  topContentType: string | null;
  engagementRate: number;
  growthRate: number;
  insights: LinkedInInsightItem[];
}

@Injectable()
export class LinkedinService {
  private readonly logger = new Logger(LinkedinService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly linkedinApiVersion: string;

  constructor(
    private configService: ConfigService,
    private profileRepository: ProfileRepository,
    private generatedContentRepository: GeneratedContentRepository,
    private scraperCredentialsService: ScraperCredentialsService,
  ) {
    this.clientId = this.configService.get<string>('linkedin.clientId') || '';
    this.clientSecret =
      this.configService.get<string>('linkedin.clientSecret') || '';
    this.redirectUri =
      this.configService.get<string>('linkedin.redirectUri') || '';
    this.linkedinApiVersion =
      this.configService.get<string>('LINKEDIN_API_VERSION') || '202401';
  }

  private toLinkedinText(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
    if (value && typeof value === 'object') {
      const localized = (value as any).localized;
      if (localized && typeof localized === 'object') {
        const first = Object.values(localized).find(
          (v) => typeof v === 'string' && v.trim().length > 0,
        ) as string | undefined;
        if (first) return first;
      }
      const direct = Object.values(value as Record<string, unknown>).find(
        (v) => typeof v === 'string' && v.trim().length > 0,
      ) as string | undefined;
      if (direct) return direct;
    }
    return fallback;
  }

  private sanitizeLinkedinVersion(version: string | undefined | null): string | null {
    if (!version) return null;
    const trimmed = String(version).trim();
    const yyyymm = trimmed.replace(/[^0-9]/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(yyyymm)) return null;
    return yyyymm;
  }

  private getCurrentLinkedinVersion(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${y}${m}`;
  }

  private async getLinkedinVersionCandidates(): Promise<string[]> {
    const effective = await this.scraperCredentialsService.getEffective();
    const configured = this.sanitizeLinkedinVersion(
      effective.linkedinApiVersion || this.linkedinApiVersion,
    );
    const current = this.getCurrentLinkedinVersion();
    return Array.from(new Set([current, configured].filter(Boolean) as string[]));
  }

  private async fetchLinkedinRestWithVersionRetry(
    url: string,
    accessToken: string,
    init: {
      method: string;
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const versions = await this.getLinkedinVersionCandidates();
    let lastResponse: Response | null = null;

    for (const version of versions) {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': version,
          ...(init.headers || {}),
        },
        body: init.body,
      });

      if (response.ok) return response;

      const errorText = await response.text().catch(() => '');
      const isVersionError =
        response.status === 426 ||
        errorText.includes('NONEXISTENT_VERSION') ||
        errorText.includes('VERSION_MISSING');
      if (!isVersionError || version === versions[versions.length - 1]) {
        return new Response(errorText, {
          status: response.status,
          statusText: response.statusText,
        });
      }

      this.logger.warn(
        `LinkedIn version ${version} failed for ${url}. Retrying with next candidate.`,
      );
      lastResponse = response;
    }

    return (
      lastResponse ||
      new Response('LinkedIn request failed', { status: 400, statusText: 'Bad Request' })
    );
  }

  private async fetchLinkedinV2WithRetry(
    url: string,
    accessToken: string,
    timeoutMs = 10000,
    attempts = 2,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        return response;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `LinkedIn v2 request failed (attempt ${i + 1}/${attempts}) for ${url}: ${message}`,
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error('LinkedIn v2 request failed');
  }

  private findFirstIdentifierUrl(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;

    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;

      if (Array.isArray(node)) {
        for (const child of node) stack.push(child);
        continue;
      }

      const record = node as Record<string, unknown>;
      const identifier = record.identifier;
      if (typeof identifier === 'string' && identifier.startsWith('http')) {
        return identifier;
      }

      for (const child of Object.values(record)) {
        if (child && typeof child === 'object') {
          stack.push(child);
        }
      }
    }

    return undefined;
  }

  private buildVectorImageUrl(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const vectorImage = (value as any).vectorImage;
    if (!vectorImage || typeof vectorImage !== 'object') return undefined;

    const rootUrl =
      typeof vectorImage.rootUrl === 'string' ? vectorImage.rootUrl : '';
    const artifacts = Array.isArray(vectorImage.artifacts)
      ? vectorImage.artifacts
      : [];
    if (!rootUrl || artifacts.length === 0) return undefined;

    const best = [...artifacts]
      .filter((a) => a && typeof a.fileIdentifyingUrlPathSegment === 'string')
      .sort((a: any, b: any) => (Number(b.width || 0) - Number(a.width || 0)))[0];
    if (!best?.fileIdentifyingUrlPathSegment) return undefined;

    return `${rootUrl}${best.fileIdentifyingUrlPathSegment}`;
  }

  private deepFindNumber(obj: unknown, keyHints: string[]): number | null {
    if (!obj || typeof obj !== 'object') return null;
    const queue: unknown[] = [obj];
    const hints = keyHints.map((h) => h.toLowerCase());

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      const record = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(record)) {
        const lk = k.toLowerCase();
        if (
          hints.some((hint) => lk.includes(hint)) &&
          (typeof v === 'number' || typeof v === 'string')
        ) {
          const n = Number(v);
          if (Number.isFinite(n)) return n;
        }
        if (v && typeof v === 'object') queue.push(v);
      }
    }
    return null;
  }

  private extractShareStatisticsTotals(payload: any): {
    impressions: number;
    clicks: number;
    reactions: number;
    comments: number;
    shares: number;
  } {
    const totals = {
      impressions: 0,
      clicks: 0,
      reactions: 0,
      comments: 0,
      shares: 0,
    };

    const consume = (stats: any) => {
      if (!stats || typeof stats !== 'object') return;
      totals.impressions += Number(stats.impressionCount || stats.impressions || 0);
      totals.clicks += Number(stats.clickCount || stats.clicks || 0);
      totals.reactions += Number(stats.likeCount || stats.reactionCount || stats.reactions || 0);
      totals.comments += Number(stats.commentCount || stats.comments || 0);
      totals.shares += Number(stats.shareCount || stats.repostCount || stats.shares || 0);
    };

    if (payload?.totalShareStatistics) consume(payload.totalShareStatistics);
    if (payload?.shareStatistics) consume(payload.shareStatistics);
    consume(payload);

    if (Array.isArray(payload?.elements)) {
      for (const el of payload.elements) {
        if (el?.totalShareStatistics) consume(el.totalShareStatistics);
        if (el?.shareStatistics) consume(el.shareStatistics);
        consume(el);
      }
    }

    return totals;
  }

  private normalizeLinkedinUrn(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
  }

  private extractFirstUrn(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.includes('urn:li:') ? value : null;
    }
    if (!value || typeof value !== 'object') return null;
    const queue: unknown[] = [value];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      for (const v of Object.values(node as Record<string, unknown>)) {
        if (typeof v === 'string' && v.includes('urn:li:')) return v;
        if (v && typeof v === 'object') queue.push(v);
      }
    }
    return null;
  }

  private extractShareStatisticsByShareUrn(
    payload: any,
  ): Map<
    string,
    {
      impressions: number;
      clicks: number;
      reactions: number;
      comments: number;
      shares: number;
    }
  > {
    const out = new Map<
      string,
      {
        impressions: number;
        clicks: number;
        reactions: number;
        comments: number;
        shares: number;
      }
    >();
    const elements = Array.isArray(payload?.elements) ? payload.elements : [];
    for (const el of elements) {
      const urn = this.extractFirstUrn(el);
      if (!urn) continue;
      const key = this.normalizeLinkedinUrn(urn);
      if (!key) continue;
      const totals = this.extractShareStatisticsTotals(el);
      out.set(key, totals);
    }
    return out;
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      scope:
        'openid profile email w_member_social w_organization_social r_basicprofile r_1st_connections_size r_organization_admin rw_organization_admin r_organization_social',
    });

    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const response = await fetch(
      'https://www.linkedin.com/oauth/v2/accessToken',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`LinkedIn token exchange failed: ${error}`);
      throw new BadRequestException('Failed to exchange code for token');
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  async saveTokens(
    userId: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
  ): Promise<void> {
    this.logger.log(
      `Saving LinkedIn tokens for user: ${userId}, expiresIn: ${expiresIn}s`,
    );

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    try {
      await this.profileRepository.updateLinkedinTokens(
        userId,
        accessToken,
        refreshToken,
        expiresAt,
      );
      this.logger.log(`LinkedIn tokens saved successfully for user: ${userId}`);
    } catch (error) {
      this.logger.error(
        `Failed to save LinkedIn tokens for user: ${userId}`,
        error,
      );
      throw error;
    }
  }

  async getConnectionStatus(userId: string): Promise<{
    connected: boolean;
    expiresAt: Date | null;
  }> {
    this.logger.log(`Checking LinkedIn connection status for user: ${userId}`);

    const profile = await this.profileRepository.findById(userId);
    if (!profile) {
      this.logger.error(`User profile not found for user: ${userId}`);
      throw new BadRequestException('User profile not found');
    }

    const connected = !!profile.linkedin_access_token;
    const expiresAt = profile.linkedin_expires_at || null;

    this.logger.log(
      `LinkedIn connection status for user ${userId}: connected=${connected}, expiresAt=${expiresAt}, hasToken=${!!profile.linkedin_access_token}`,
    );

    return { connected, expiresAt };
  }

  async getProfileMetrics(userId: string): Promise<{
    followers: number;
    connections: number;
    profileViews: number;
    searchAppearances: number;
  }> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    try {
      const profileResponse = await fetch('https://api.linkedin.com/v2/me', {
        headers: {
          Authorization: `Bearer ${profile.linkedin_access_token}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });

      if (!profileResponse.ok) {
        this.logger.error(
          `LinkedIn profile API error: ${profileResponse.status} ${profileResponse.statusText}`,
        );
        if (profileResponse.status === 403) {
          throw new ForbiddenException(
            'LinkedIn permission denied. Reconnect to grant required scopes.',
          );
        }
        throw new BadRequestException('Failed to fetch LinkedIn profile');
      }

      const profileData = await profileResponse.json();
      this.logger.log(`LinkedIn profile data available:`, !!profileData);

      // Connection counts are unavailable for many app scope combinations.
      // Keep this deterministic and avoid noisy 400 path-variable warnings.
      const connections = 0;

      // We do not return any estimated/random analytics.
      return {
        followers: 0,
        connections,
        profileViews: 0,
        searchAppearances: 0,
      };
    } catch (error) {
      this.logger.error('Error fetching LinkedIn metrics:', error);
      if (error instanceof ForbiddenException) throw error;
      return {
        followers: 0,
        connections: 0,
        profileViews: 0,
        searchAppearances: 0,
      };
    }
  }

  async getPostAnalytics(
    userId: string,
    limit: number = 10,
    actorType: 'member' | 'organization' = 'member',
    organizationUrn?: string,
  ): Promise<Array<{
    id: string;
    content: string;
    publishedAt: string;
    likes: number;
    comments: number;
    shares: number;
    impressions: number;
    clicks: number;
    engagementRate: number;
  }> | null> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    try {
      if (actorType === 'organization' && organizationUrn) {
        // Preferred: LinkedIn REST endpoints (versioned) for org posts/metrics.
        const restPostsResponse = await this.fetchLinkedinRestWithVersionRetry(
          `https://api.linkedin.com/rest/posts?q=author&author=${encodeURIComponent(organizationUrn)}&count=${Math.max(1, Math.min(limit, 50))}&sortBy=LAST_MODIFIED`,
          profile.linkedin_access_token,
          {
            method: 'GET',
          },
        );

        const restStatsResponse = await this.fetchLinkedinRestWithVersionRetry(
          `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn)}`,
          profile.linkedin_access_token,
          {
            method: 'GET',
          },
        );

        // Fallback: legacy v2 shares endpoint for broader compatibility.
        const v2PostsResponse = await fetch(
          `https://api.linkedin.com/v2/shares?q=owners&owners=${encodeURIComponent(organizationUrn)}&count=${Math.max(1, Math.min(limit, 50))}&projection=(elements*(id,text,created,time,totalSocialActivityCounts))`,
          {
            headers: {
              Authorization: `Bearer ${profile.linkedin_access_token}`,
              'X-Restli-Protocol-Version': '2.0.0',
            },
          },
        );

        const restPostsData = restPostsResponse.ok
          ? await restPostsResponse.json().catch(() => ({ elements: [] }))
          : { elements: [] };
        const v2PostsData = v2PostsResponse.ok
          ? await v2PostsResponse.json().catch(() => ({ elements: [] }))
          : { elements: [] };
        const orgPostsData =
          Array.isArray(restPostsData?.elements) && restPostsData.elements.length > 0
            ? restPostsData
            : v2PostsData;

        const statsData = restStatsResponse.ok
          ? await restStatsResponse.json().catch(() => ({}))
          : {};
        const statsTotals = this.extractShareStatisticsTotals(statsData);
        const statsByShareUrn = this.extractShareStatisticsByShareUrn(statsData);
        const totalImpressions = statsTotals.impressions;
        const totalClicks = statsTotals.clicks;
        const totalReactions = statsTotals.reactions;
        const totalComments = statsTotals.comments;
        const totalShares = statsTotals.shares;

        const rows = Array.isArray(orgPostsData?.elements) ? orgPostsData.elements : [];
        const distributedFallbackImpressions =
          rows.length > 0 ? Math.floor(totalImpressions / rows.length) : 0;
        const distributedFallbackClicks =
          rows.length > 0 ? Math.floor(totalClicks / rows.length) : 0;
        return rows.map((post: any, index: number) => {
          const likes = Number(post?.totalSocialActivityCounts?.numLikes || 0);
          const comments = Number(post?.totalSocialActivityCounts?.numComments || 0);
          const shares = Number(post?.totalSocialActivityCounts?.numShares || 0);
          const interactions = likes + comments + shares;
          const postId = post?.id || `org-post-${index}`;
          const postUrnKey = this.normalizeLinkedinUrn(postId);
          const postStats = statsByShareUrn.get(postUrnKey);
          const postImpressions = postStats?.impressions ?? distributedFallbackImpressions;
          const postClicks = postStats?.clicks ?? distributedFallbackClicks;
          const postReactions = postStats?.reactions ?? likes;
          const postComments = postStats?.comments ?? comments;
          const postShares = postStats?.shares ?? shares;
          const postInteractions =
            postReactions + postComments + postShares + postClicks;
          return {
            id: postId,
            content:
              post?.commentary ||
              post?.text?.text ||
              post?.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary
                ?.text ||
              'LinkedIn Company Page Post',
            publishedAt: new Date(
              post?.createdAt ||
                post?.created?.time ||
                post?.lastModified?.time ||
                Date.now(),
            ).toISOString(),
            likes,
            comments,
            shares,
            impressions: Math.max(0, postImpressions),
            clicks: Math.max(0, postClicks),
            engagementRate:
              postImpressions > 0
                ? (postInteractions / postImpressions) * 100
                : totalImpressions > 0
                  ? (interactions / totalImpressions) * 100
                  : 0,
          };
        });
      }

      // Get user profile data first
      const meResponse = await fetch('https://api.linkedin.com/v2/me', {
        headers: {
          Authorization: `Bearer ${profile.linkedin_access_token}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });

      if (!meResponse.ok) {
        this.logger.error(
          `LinkedIn profile API error: ${meResponse.status} ${meResponse.statusText}`,
        );
        if (meResponse.status === 403) {
          throw new ForbiddenException(
            'LinkedIn permission denied. Reconnect to grant required scopes.',
          );
        }
        throw new BadRequestException('Failed to fetch user profile');
      }

      const userData = await meResponse.json();
      const userId_linkedin = userData.id;

      // With current scopes we can publish member posts, but LinkedIn does not allow
      // reading member post analytics without additional restricted read scopes.
      this.logger.log(
        `Personal LinkedIn analytics are unavailable for member ${userId_linkedin} with current scopes; returning no personal post analytics.`,
      );
      const posts: any[] = [];

      if (posts.length === 0) {
        this.logger.log(
          'No LinkedIn personal post analytics available with current scopes; returning empty personal analytics set',
        );
        return [];
      }

      // Transform posts with REAL engagement data only
      const transformedPosts = posts.map((post: any, index: number) => {
        // UGC response doesn't include analytics counts; keep real zeros.
        const realLikes = 0;
        const realComments = 0;
        const realShares = 0;
        const impressions = 0;
        const clicks = 0;
        const engagementRate = 0;

        return {
          id: post.id || `post-${index}`,
          content:
            post?.specificContent?.['com.linkedin.ugc.ShareContent']
              ?.shareCommentary?.text || 'LinkedIn Post',
          publishedAt: new Date(
            post?.lastModified?.time || post?.created?.time || Date.now(),
          ).toISOString(),
          likes: realLikes,
          comments: realComments,
          shares: realShares,
          impressions,
          clicks,
          engagementRate: Math.round(engagementRate * 100) / 100,
        };
      });

      this.logger.log(
        `Returning ${transformedPosts.length} posts with REAL engagement data`,
      );
      return transformedPosts;
    } catch (error) {
      this.logger.error('Error fetching LinkedIn post analytics:', error);
      if (error instanceof ForbiddenException) throw error;
      return [];
    }
  }

  async disconnectLinkedIn(userId: string): Promise<void> {
    this.logger.log(`Disconnecting LinkedIn for user: ${userId}`);

    try {
      await this.profileRepository.clearLinkedinTokens(userId);
      this.logger.log(`LinkedIn disconnected successfully for user: ${userId}`);
    } catch (error) {
      this.logger.error(
        `Failed to disconnect LinkedIn for user: ${userId}`,
        error,
      );
      throw error;
    }
  }

  async getOrganizationAnalytics(
    userId: string,
    organizationUrn?: string,
  ): Promise<{
    organizationId: string | null;
    organizationName: string | null;
    followers: number;
    posts: number;
    engagement: number;
    impressions: number;
    clicks: number;
    reactions: number;
    comments: number;
    reposts: number;
    availableMetrics?: string[];
    source?: string;
  }> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    try {
      // Get organizations the user administers
      const orgsResponse = await this.fetchLinkedinV2WithRetry(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,name,logoV2)))',
        profile.linkedin_access_token,
      );

      if (!orgsResponse.ok) {
        return {
          organizationId: null,
          organizationName: null,
          followers: 0,
          posts: 0,
          engagement: 0,
          impressions: 0,
          clicks: 0,
          reactions: 0,
          comments: 0,
          reposts: 0,
          availableMetrics: [],
          source: 'none',
        };
      }

      const orgsData = await orgsResponse.json();

      if (!orgsData.elements || orgsData.elements.length === 0) {
        return {
          organizationId: null,
          organizationName: null,
          followers: 0,
          posts: 0,
          engagement: 0,
          impressions: 0,
          clicks: 0,
          reactions: 0,
          comments: 0,
          reposts: 0,
          availableMetrics: [],
          source: 'none',
        };
      }

      const selectedOrg = organizationUrn
        ? orgsData.elements.find((el: any) => el?.organization === organizationUrn)
        : orgsData.elements[0];
      const firstOrg = selectedOrg || orgsData.elements[0];
      const orgId = firstOrg.organization;
      const orgName = this.toLinkedinText(
        firstOrg?.['organization~']?.name,
        'Organization',
      );

      // Prefer REST org follower/share stats (versioned, richer).
      const followerStatsResponse = await this.fetchLinkedinRestWithVersionRetry(
        `https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgId)}`,
        profile.linkedin_access_token,
        { method: 'GET' },
      );

      let followers = 0;
      if (followerStatsResponse.ok) {
        const followerStats = await followerStatsResponse.json().catch(() => ({}));
        followers =
          Number(followerStats?.followerCountsByAssociationType?.organicFollowerCount || 0) ||
          Number(followerStats?.firstDegreeSize || 0);
      }

      const shareStatsResponse = await this.fetchLinkedinRestWithVersionRetry(
        `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgId)}`,
        profile.linkedin_access_token,
        { method: 'GET' },
      );
      const pageStatsResponse = await this.fetchLinkedinRestWithVersionRetry(
        `https://api.linkedin.com/rest/organizationPageStatistics?q=organization&organization=${encodeURIComponent(orgId)}`,
        profile.linkedin_access_token,
        { method: 'GET' },
      );
      const orgPostsResponse = await this.fetchLinkedinRestWithVersionRetry(
        `https://api.linkedin.com/rest/posts?q=author&author=${encodeURIComponent(orgId)}&count=50&sortBy=LAST_MODIFIED`,
        profile.linkedin_access_token,
        { method: 'GET' },
      );

      let posts = 0;
      let totalEngagement = 0;
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalReactions = 0;
      let totalComments = 0;
      let totalReposts = 0;
      const availableMetrics = new Set<string>();
      let source = 'rest';
      if (orgPostsResponse.ok) {
        const orgPostsData = await orgPostsResponse.json().catch(() => ({ elements: [] }));
        posts = orgPostsData.elements?.length || 0;

        totalEngagement =
          orgPostsData.elements?.reduce((sum: number, post: any) => {
            const likes = post.totalSocialActivityCounts?.numLikes || 0;
            const comments = post.totalSocialActivityCounts?.numComments || 0;
            const shares = post.totalSocialActivityCounts?.numShares || 0;
            return sum + likes + comments + shares;
          }, 0) || 0;
        availableMetrics.add('posts');
      } else {
        source = 'partial';
      }
      if (shareStatsResponse.ok) {
        const shareStats = await shareStatsResponse.json().catch(() => ({}));
        const statsTotals = this.extractShareStatisticsTotals(shareStats);
        totalImpressions = Math.max(totalImpressions, statsTotals.impressions);
        totalClicks = Math.max(totalClicks, statsTotals.clicks);
        totalReactions = Math.max(totalReactions, statsTotals.reactions);
        totalComments = Math.max(totalComments, statsTotals.comments);
        totalReposts = Math.max(totalReposts, statsTotals.shares);
        totalEngagement = Math.max(
          totalEngagement,
          totalReactions + totalComments + totalReposts + totalClicks,
        );
        availableMetrics.add('shareStatistics');
      }
      if (pageStatsResponse.ok) {
        const pageStats = await pageStatsResponse.json().catch(() => ({}));
        const pageImpressions = this.deepFindNumber(pageStats, [
          'impression',
          'view',
          'views',
        ]);
        const pageClicks = this.deepFindNumber(pageStats, ['click']);
        const pageReactions = this.deepFindNumber(pageStats, ['reaction', 'like']);
        const pageComments = this.deepFindNumber(pageStats, ['comment']);
        const pageReposts = this.deepFindNumber(pageStats, ['repost', 'share']);

        if (pageImpressions != null)
          totalImpressions = Math.max(totalImpressions, pageImpressions);
        if (pageClicks != null) totalClicks = Math.max(totalClicks, pageClicks);
        if (pageReactions != null)
          totalReactions = Math.max(totalReactions, pageReactions);
        if (pageComments != null)
          totalComments = Math.max(totalComments, pageComments);
        if (pageReposts != null) totalReposts = Math.max(totalReposts, pageReposts);
        totalEngagement = Math.max(
          totalEngagement,
          totalReactions + totalComments + totalReposts + totalClicks,
        );
        availableMetrics.add('pageStatistics');
      }

      return {
        organizationId: orgId,
        organizationName: orgName,
        followers,
        posts,
        engagement: totalEngagement,
        impressions: totalImpressions,
        clicks: totalClicks,
        reactions: totalReactions,
        comments: totalComments,
        reposts: totalReposts,
        availableMetrics: Array.from(availableMetrics),
        source,
      };
    } catch (error) {
      this.logger.error('Error fetching organization analytics:', error);
      const fallbackOrgId = organizationUrn || null;
      return {
        organizationId: fallbackOrgId,
        organizationName: fallbackOrgId ? 'Organization' : null,
        followers: 0,
        posts: 0,
        engagement: 0,
        impressions: 0,
        clicks: 0,
        reactions: 0,
        comments: 0,
        reposts: 0,
        availableMetrics: [],
        source: 'timeout_or_network_error',
      };
    }
  }

  async getDashboardMetrics(userId: string): Promise<{
    followers: number;
    engagement: string;
    posts: number;
    connected: boolean;
    needsReauth?: boolean;
  }> {
    const profile = await this.profileRepository.findById(userId);
    const connected = !!profile?.linkedin_access_token;

    if (!connected) {
      return {
        followers: 0,
        engagement: '0%',
        posts: 0,
        connected: false,
      };
    }

    try {
      const personalMetrics = await this.getProfileMetrics(userId);
      const posts = await this.getPostAnalytics(userId, 30);
      const orgAnalytics = await this.getOrganizationAnalytics(userId);

      const followers =
        orgAnalytics.followers > 0
          ? orgAnalytics.followers
          : personalMetrics.followers;
      const postsCount =
        orgAnalytics.posts > 0 ? orgAnalytics.posts : (posts?.length ?? 0);
      const avgEngagement =
        orgAnalytics.posts > 0
          ? orgAnalytics.engagement
          : postsCount > 0
            ? posts!.reduce((sum, post) => sum + post.engagementRate, 0) /
              postsCount
            : 0;

      return {
        followers,
        engagement: `${avgEngagement.toFixed(1)}%`,
        posts: postsCount,
        connected: true,
        needsReauth: false,
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        return {
          followers: 0,
          engagement: '0%',
          posts: 0,
          connected: true,
          needsReauth: true,
        };
      }

      this.logger.error('Error fetching LinkedIn dashboard metrics:', error);
      // Not a permission issue -> do not force reconnect loop
      return {
        followers: 0,
        engagement: '0%',
        posts: 0,
        connected: true,
        needsReauth: false,
      };
    }
  }

  async getInsights(
    userId: string,
    periodDays = 30,
    actorType: 'member' | 'organization' = 'member',
    organizationUrn?: string,
  ): Promise<LinkedInInsightsPayload> {
    const safePeriodDays = Number.isFinite(periodDays)
      ? Math.min(Math.max(periodDays, 7), 90)
      : 30;
    const now = new Date();
    const currentFrom = new Date(
      now.getTime() - safePeriodDays * 24 * 60 * 60 * 1000,
    );
    const previousFrom = new Date(
      currentFrom.getTime() - safePeriodDays * 24 * 60 * 60 * 1000,
    );

    const [currentPosts, previousPosts, analytics, org] = await Promise.all([
      this.generatedContentRepository.findPublishedWithinRange(
        userId,
        currentFrom,
        now,
      ),
      this.generatedContentRepository.findPublishedWithinRange(
        userId,
        previousFrom,
        currentFrom,
      ),
      this.getPostAnalytics(userId, 100, actorType, organizationUrn),
      this.getOrganizationAnalytics(userId, organizationUrn),
    ]);

    const slotScores = new Map<string, number>();
    for (const post of currentPosts) {
      const dt = new Date(post.published_at);
      if (Number.isNaN(dt.getTime())) continue;
      const weekday = dt.toLocaleDateString('en-US', { weekday: 'short' });
      const hour = dt.getHours().toString().padStart(2, '0');
      const slotKey = `${weekday} ${hour}:00`;
      slotScores.set(slotKey, (slotScores.get(slotKey) || 0) + 1);
    }
    const bestPostingTime =
      [...slotScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const typeCounts = new Map<string, number>();
    for (const post of currentPosts) {
      const key = (post.visual_type || 'text').toLowerCase();
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
    }
    const topContentType =
      [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const analyticsRows = (analytics || []).filter((row) =>
      Number.isFinite(row.impressions),
    );
    const totalImpressions = analyticsRows.reduce(
      (sum, row) => sum + Math.max(0, row.impressions || 0),
      0,
    );
    const totalInteractions = analyticsRows.reduce(
      (sum, row) =>
        sum +
        Math.max(0, row.likes || 0) +
        Math.max(0, row.comments || 0) +
        Math.max(0, row.shares || 0) +
        Math.max(0, row.clicks || 0),
      0,
    );

    const engagementRate =
      totalImpressions > 0 ? (totalInteractions / totalImpressions) * 100 : 0;

    const currentPostCount = currentPosts.length;
    const previousPostCount = previousPosts.length;
    const hasGrowthBaseline = previousPostCount >= 3;
    const growthRate = hasGrowthBaseline
      ? ((currentPostCount - previousPostCount) / previousPostCount) * 100
      : 0;

    const hasOrganizationAdmin =
      Boolean(org.organizationId) &&
      (org.followers > 0 || org.posts > 0 || org.engagement > 0);
    const canViewEngagementMetrics =
      actorType === 'organization' && hasOrganizationAdmin;
    const engagementMetricsMessage = canViewEngagementMetrics
      ? 'Organization analytics available from LinkedIn API.'
      : 'LinkedIn engagement/impression analytics are limited for personal accounts without restricted partner permissions.';
    const hasData =
      currentPostCount > 0 ||
      org.posts > 0 ||
      totalImpressions > 0 ||
      totalInteractions > 0;

    const insights: LinkedInInsightItem[] = [
      {
        title: 'Best Posting Time',
        value: bestPostingTime || 'Not enough data',
        description: bestPostingTime
          ? `Most-used posting slot over last ${safePeriodDays} days`
          : 'Publish more posts to unlock best posting time',
        trend: 'Live from published posts',
        source: 'published_posts',
      },
      {
        title: 'Top Content Type',
        value: topContentType || 'Not enough data',
        description: topContentType
          ? `Most frequent winning format over last ${safePeriodDays} days`
          : 'Publish multiple formats to compare performance',
        trend: 'Live from published posts',
        source: 'published_posts',
      },
      {
        title: 'Engagement Rate',
        value: `${engagementRate.toFixed(1)}%`,
        description:
          !canViewEngagementMetrics
            ? 'Company Page admin access is required for full LinkedIn engagement metrics.'
            : totalImpressions > 0
            ? 'Calculated from LinkedIn interactions/impressions'
            : 'No impression data returned yet from LinkedIn',
        trend:
          !canViewEngagementMetrics
            ? 'Unavailable for personal account analytics'
            : totalImpressions > 0
            ? 'Live from LinkedIn analytics'
            : 'Waiting for LinkedIn analytics',
        source:
          totalImpressions > 0 ? 'linkedin_analytics' : 'organization_analytics',
      },
      {
        title: 'Growth Rate',
        value: hasGrowthBaseline ? `${growthRate.toFixed(1)}%` : 'Not enough baseline',
        description: hasGrowthBaseline
          ? `Post output trend vs previous ${safePeriodDays}-day window`
          : `Need at least 3 posts in previous ${safePeriodDays}-day window for stable growth`,
        trend: hasGrowthBaseline
          ? 'Live from published posts'
          : 'Waiting for baseline data',
        source: 'published_posts',
      },
    ];

    return {
      hasData,
      periodDays: safePeriodDays,
      accountType: actorType === 'organization' ? 'organization_admin' : 'personal',
      canViewEngagementMetrics,
      engagementMetricsMessage,
      bestPostingTime,
      topContentType,
      engagementRate: Number(engagementRate.toFixed(2)),
      growthRate: Number(growthRate.toFixed(2)),
      insights,
    };
  }

  async getAccountTypeContext(
    userId: string,
    actorType: 'member' | 'organization' = 'member',
    organizationUrn?: string,
  ): Promise<LinkedInAccountTypeContext> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    let linkedMemberId: string | null = null;
    try {
      const userInfoResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${profile.linkedin_access_token}`,
        },
      });
      if (userInfoResponse.ok) {
        const userInfo = await userInfoResponse.json();
        linkedMemberId = userInfo?.sub || null;
      }
    } catch (error) {
      this.logger.warn('Unable to fetch LinkedIn userinfo for account type context');
    }

    try {
      const orgsResponse = await fetch(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,name,logoV2)))',
        {
          headers: {
            Authorization: `Bearer ${profile.linkedin_access_token}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      if (!orgsResponse.ok) {
        return {
          accountType: 'personal',
          linkedMemberId,
          organizationAdminCount: 0,
          organizationNames: [],
          canViewEngagementMetrics: false,
          reason:
            'No LinkedIn organization admin access detected (organizationAcls unavailable).',
        };
      }

      const orgsData = await orgsResponse.json();
      const elements = Array.isArray(orgsData?.elements) ? orgsData.elements : [];
      const organizationNames = elements
        .map((el: any) => el?.['organization~']?.name)
        .filter((v: any) => typeof v === 'string' && v.trim().length > 0);
      const organizationAdminCount = elements.length;
      const isOrganizationAdmin = organizationAdminCount > 0;
      const selectedOrgAllowed = organizationUrn
        ? elements.some((el: any) => el?.organization === organizationUrn)
        : isOrganizationAdmin;
      const canViewEngagementMetrics =
        actorType === 'organization' && selectedOrgAllowed;

      return {
        accountType:
          actorType === 'organization' && selectedOrgAllowed
            ? 'organization_admin'
            : 'personal',
        linkedMemberId,
        organizationAdminCount,
        organizationNames,
        canViewEngagementMetrics,
        reason: canViewEngagementMetrics
          ? 'Selected Company Page analytics access is available.'
          : actorType === 'organization'
            ? 'Selected company page is not available under current LinkedIn admin access.'
            : 'Selected personal profile view has limited analytics. Choose a company page for richer metrics.',
      };
    } catch (error) {
      this.logger.error('Error determining LinkedIn account type context:', error);
      return {
        accountType: 'personal',
        linkedMemberId,
        organizationAdminCount: 0,
        organizationNames: [],
        canViewEngagementMetrics: false,
        reason: 'Failed to determine organization admin access from LinkedIn.',
      };
    }
  }

  async getPostingIdentities(userId: string): Promise<{
    defaultIdentityId: string;
    identities: LinkedInPostingIdentity[];
  }> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    let linkedMemberId: string | null = null;
    let memberAvatarUrl: string | undefined;
    const identities: LinkedInPostingIdentity[] = [];

    try {
      const userInfoResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${profile.linkedin_access_token}`,
        },
      });
      if (userInfoResponse.ok) {
        const userInfo = await userInfoResponse.json();
        linkedMemberId = userInfo?.sub || null;
        if (typeof userInfo?.picture === 'string' && userInfo.picture.startsWith('http')) {
          memberAvatarUrl = userInfo.picture;
        }
      }
    } catch (error) {
      this.logger.warn('Unable to fetch LinkedIn userinfo for posting identities');
    }

    const memberIdentityId = linkedMemberId
      ? `member:${linkedMemberId}`
      : 'member:self';
    identities.push({
      id: memberIdentityId,
      actorType: 'member',
      label: 'Personal profile',
      avatarUrl: memberAvatarUrl,
    });

    try {
      const orgsResponse = await fetch(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,name,logoV2)))',
        {
          headers: {
            Authorization: `Bearer ${profile.linkedin_access_token}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      if (orgsResponse.ok) {
        const orgsData = await orgsResponse.json();
        const elements = Array.isArray(orgsData?.elements) ? orgsData.elements : [];
        for (const element of elements) {
          const organizationUrn = element?.organization;
          if (!organizationUrn) continue;
          const organizationName = this.toLinkedinText(
            element?.['organization~']?.name,
            organizationUrn,
          );
          let avatarUrl =
            this.findFirstIdentifierUrl(
              element?.['organization~']?.logoV2,
            ) || this.buildVectorImageUrl(element?.['organization~']?.logoV2);

          // Some LinkedIn org ACL payloads omit resolved logo fields.
          if (!avatarUrl) {
            const organizationId = String(organizationUrn).split(':').pop();
            if (organizationId) {
              try {
                const orgDetailResponse = await fetch(
                  `https://api.linkedin.com/v2/organizations/${organizationId}?projection=(id,name,logoV2)`,
                  {
                    headers: {
                      Authorization: `Bearer ${profile.linkedin_access_token}`,
                      'X-Restli-Protocol-Version': '2.0.0',
                    },
                  },
                );
                if (orgDetailResponse.ok) {
                  const orgDetail = await orgDetailResponse.json();
                  avatarUrl =
                    this.findFirstIdentifierUrl(orgDetail?.logoV2) ||
                    this.buildVectorImageUrl(orgDetail?.logoV2);
                }
              } catch {
                // best effort only
              }
            }
          }
          identities.push({
            id: `org:${organizationUrn}`,
            actorType: 'organization',
            label: organizationName,
            organizationUrn,
            organizationName,
            avatarUrl,
          });
        }
      }
    } catch (error) {
      this.logger.warn('Unable to fetch LinkedIn organization identities');
    }

    return {
      defaultIdentityId: identities[0]?.id || memberIdentityId,
      identities,
    };
  }

  async publishPost(request: {
    userId: string;
    text: string;
    mediaType: 'text' | 'image' | 'document';
    mediaUrl?: string;
    actorType?: 'member' | 'organization';
    organizationUrn?: string;
  }): Promise<{ postId: string }> {
    const profile = await this.profileRepository.findById(request.userId);
    if (!profile) {
      throw new BadRequestException('User profile not found');
    }

    if (!profile.linkedin_access_token) {
      throw new BadRequestException(ERROR_MESSAGES.LINKEDIN_NOT_CONNECTED);
    }

    if (
      profile.linkedin_expires_at &&
      new Date(profile.linkedin_expires_at) < new Date()
    ) {
      throw new BadRequestException(ERROR_MESSAGES.LINKEDIN_TOKEN_EXPIRED);
    }

    const linkedinUserId = await this.getLinkedinUserId(
      profile.linkedin_access_token,
    );
    const ownerUrn =
      request.actorType === 'organization'
        ? request.organizationUrn
        : `urn:li:person:${linkedinUserId}`;
    if (!ownerUrn) {
      throw new BadRequestException(
        'organizationUrn is required for organization publishing',
      );
    }

    let postData: any;

    switch (request.mediaType) {
      case 'text':
        postData = await this.createTextPost(ownerUrn, request.text);
        break;
      case 'image':
        if (!request.mediaUrl) {
          throw new BadRequestException('Media URL required for image post');
        }
        postData = await this.createImagePost(
          ownerUrn,
          request.text,
          request.mediaUrl,
          profile.linkedin_access_token,
        );
        break;
      case 'document':
        if (!request.mediaUrl) {
          throw new BadRequestException('Media URL required for document post');
        }
        postData = await this.createDocumentPost(
          ownerUrn,
          request.text,
          request.mediaUrl,
          profile.linkedin_access_token,
        );
        break;
      default:
        throw new BadRequestException(
          `Unsupported media type: ${request.mediaType}`,
        );
    }

    // Log the post data for debugging
    this.logger.log(
      `Publishing to LinkedIn: ${JSON.stringify(postData, null, 2)}`,
    );

    const response = await this.fetchLinkedinRestWithVersionRetry(
      'https://api.linkedin.com/rest/posts',
      profile.linkedin_access_token,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(postData),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`LinkedIn post failed: ${error}`);

      // Handle duplicate post error specifically
      if (
        error.includes('DUPLICATE_POST') ||
        error.includes('Duplicate post is detected')
      ) {
        this.logger.warn('Post rejected as duplicate by LinkedIn');
        throw new BadRequestException(
          'This content has already been posted to LinkedIn. Please modify the content before posting again.',
        );
      }
      if (
        error.includes('Organization permissions must be used') ||
        error.includes('w_organization_social')
      ) {
        throw new BadRequestException(
          'LinkedIn company-page publishing requires organization write permission. Reconnect LinkedIn and approve company page permissions.',
        );
      }

      this.logger.error(
        `Post data that failed: ${JSON.stringify(postData, null, 2)}`,
      );
      throw new BadRequestException('Failed to publish to LinkedIn');
    }

    const postId = response.headers.get('x-restli-id');
    if (!postId) {
      throw new BadRequestException('Failed to get post ID from LinkedIn');
    }

    return { postId };
  }

  private async createTextPost(ownerUrn: string, text: string): Promise<any> {
    return {
      author: ownerUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
  }

  private async createImagePost(
    ownerUrn: string,
    text: string,
    imageUrl: string,
    accessToken: string,
  ): Promise<any> {
    // First, upload the image to LinkedIn
    const uploadedImageUrn = await this.uploadImageToLinkedIn(
      imageUrl,
      accessToken,
      ownerUrn,
    );

    return {
      author: ownerUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        media: {
          title: 'Generated Image',
          id: uploadedImageUrn,
        },
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
  }

  private async createDocumentPost(
    ownerUrn: string,
    text: string,
    documentUrl: string,
    accessToken: string,
  ): Promise<any> {
    // Upload the document (PDF) to LinkedIn
    const uploadedDocumentUrn = await this.uploadDocumentToLinkedIn(
      documentUrl,
      accessToken,
      ownerUrn,
    );

    return {
      author: ownerUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        media: {
          title: 'Carousel PDF',
          id: uploadedDocumentUrn,
        },
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
  }

  private async uploadImageToLinkedIn(
    imageUrl: string,
    accessToken: string,
    ownerUrn: string,
  ): Promise<string> {
    try {
      // Initialize upload
      const initResponse = await this.fetchLinkedinRestWithVersionRetry(
        'https://api.linkedin.com/rest/images?action=initializeUpload',
        accessToken,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: ownerUrn,
            },
          }),
        },
      );

      if (!initResponse.ok) {
        throw new Error('Failed to initialize image upload');
      }

      const initData = await initResponse.json();
      const uploadUrl = initData.value.uploadUrl;
      const imageUrn = initData.value.image;

      // Validate image URL
      if (
        !imageUrl ||
        imageUrl === 'generated-image' ||
        !imageUrl.startsWith('http')
      ) {
        throw new Error(
          `Invalid image URL: ${imageUrl}. Please ensure the image is properly uploaded to MinIO.`,
        );
      }

      // Download image from MinIO
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error('Failed to download image from MinIO');
      }

      const imageBuffer = await imageResponse.arrayBuffer();

      // Upload to LinkedIn
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
        },
        body: imageBuffer,
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload image to LinkedIn');
      }

      return imageUrn;
    } catch (error) {
      this.logger.error('Failed to upload image to LinkedIn:', error);
      throw new BadRequestException('Failed to upload image to LinkedIn');
    }
  }

  private async uploadDocumentToLinkedIn(
    documentUrl: string,
    accessToken: string,
    ownerUrn: string,
  ): Promise<string> {
    try {
      // Initialize document upload
      const initResponse = await this.fetchLinkedinRestWithVersionRetry(
        'https://api.linkedin.com/rest/documents?action=initializeUpload',
        accessToken,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: ownerUrn,
            },
          }),
        },
      );

      if (!initResponse.ok) {
        throw new Error('Failed to initialize document upload');
      }

      const initData = await initResponse.json();
      const uploadUrl = initData.value.uploadUrl;
      const documentUrn = initData.value.document;

      // Download document from MinIO
      const documentResponse = await fetch(documentUrl);
      if (!documentResponse.ok) {
        throw new Error('Failed to download document from MinIO');
      }

      const documentBuffer = await documentResponse.arrayBuffer();

      // Upload to LinkedIn
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/pdf',
        },
        body: documentBuffer,
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload document to LinkedIn');
      }

      return documentUrn;
    } catch (error) {
      this.logger.error('Failed to upload document to LinkedIn:', error);
      throw new BadRequestException('Failed to upload document to LinkedIn');
    }
  }

  private async getLinkedinPersonUrn(accessToken: string): Promise<string> {
    const userId = await this.getLinkedinUserId(accessToken);
    return `urn:li:person:${userId}`;
  }

  private async getLinkedinUserId(accessToken: string): Promise<string> {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new BadRequestException('Failed to get LinkedIn user info');
    }

    const data = await response.json();
    return data.sub;
  }
}
