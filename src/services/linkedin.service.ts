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

@Injectable()
export class LinkedinService {
  private readonly logger = new Logger(LinkedinService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private configService: ConfigService,
    private profileRepository: ProfileRepository,
    private generatedContentRepository: GeneratedContentRepository,
  ) {
    this.clientId = this.configService.get<string>('linkedin.clientId') || '';
    this.clientSecret =
      this.configService.get<string>('linkedin.clientSecret') || '';
    this.redirectUri =
      this.configService.get<string>('linkedin.redirectUri') || '';
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      scope:
        'openid profile email w_member_social r_basicprofile r_1st_connections_size r_organization_admin r_organization_social',
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

      const linkedinId = profileData?.id;
      let connections = 0;

      // Best-effort connection count (requires r_1st_connections_size)
      if (linkedinId) {
        try {
          const networkSizeRes = await fetch(
            `https://api.linkedin.com/v2/connections/urn:li:person:${linkedinId}`,
            {
              headers: {
                Authorization: `Bearer ${profile.linkedin_access_token}`,
                'X-Restli-Protocol-Version': '2.0.0',
              },
            },
          );

          if (networkSizeRes.ok) {
            const networkSize = await networkSizeRes.json();
            connections = Number(networkSize?.firstDegreeSize || 0);
          } else if (networkSizeRes.status === 403) {
            this.logger.warn('LinkedIn connections permission denied (403).');
          } else {
            const txt = await networkSizeRes.text().catch(() => '');
            this.logger.warn(
              `LinkedIn connections error: ${networkSizeRes.status} ${txt}`,
            );
          }
        } catch (e) {
          this.logger.warn('LinkedIn connections fetch failed', e);
        }
      }

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
        this.logger.log('No posts found in LinkedIn API response');
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

  async getOrganizationAnalytics(userId: string): Promise<{
    organizationId: string | null;
    organizationName: string | null;
    followers: number;
    posts: number;
    engagement: number;
  }> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile?.linkedin_access_token) {
      throw new BadRequestException('LinkedIn not connected');
    }

    try {
      // Get organizations the user administers
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
          organizationId: null,
          organizationName: null,
          followers: 0,
          posts: 0,
          engagement: 0,
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
        };
      }

      const firstOrg = orgsData.elements[0];
      const orgId = firstOrg.organization;
      const orgName = firstOrg['organization~']?.name || 'Organization';

      // Get follower statistics
      const followerStatsResponse = await fetch(
        `https://api.linkedin.com/v2/networkSizes/${orgId}?edgeType=CompanyFollowedByMember`,
        {
          headers: {
            Authorization: `Bearer ${profile.linkedin_access_token}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      let followers = 0;
      if (followerStatsResponse.ok) {
        const followerStats = await followerStatsResponse.json();
        followers = followerStats.firstDegreeSize || 0;
      }

      // Get organization posts for engagement calculation
      const orgPostsResponse = await fetch(
        `https://api.linkedin.com/v2/shares?q=owners&owners=${orgId}&count=50&projection=(elements*(totalSocialActivityCounts))`,
        {
          headers: {
            Authorization: `Bearer ${profile.linkedin_access_token}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      let posts = 0;
      let totalEngagement = 0;
      if (orgPostsResponse.ok) {
        const orgPostsData = await orgPostsResponse.json();
        posts = orgPostsData.elements?.length || 0;

        totalEngagement =
          orgPostsData.elements?.reduce((sum: number, post: any) => {
            const likes = post.totalSocialActivityCounts?.numLikes || 0;
            const comments = post.totalSocialActivityCounts?.numComments || 0;
            const shares = post.totalSocialActivityCounts?.numShares || 0;
            return sum + likes + comments + shares;
          }, 0) || 0;
      }

      return {
        organizationId: orgId,
        organizationName: orgName,
        followers,
        posts,
        engagement: totalEngagement,
      };
    } catch (error) {
      this.logger.error('Error fetching organization analytics:', error);
      return {
        organizationId: null,
        organizationName: null,
        followers: 0,
        posts: 0,
        engagement: 0,
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

  async publishPost(request: {
    userId: string;
    text: string;
    mediaType: 'text' | 'image' | 'document';
    mediaUrl?: string;
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

    let postData: any;

    switch (request.mediaType) {
      case 'text':
        postData = await this.createTextPost(linkedinUserId, request.text);
        break;
      case 'image':
        if (!request.mediaUrl) {
          throw new BadRequestException('Media URL required for image post');
        }
        postData = await this.createImagePost(
          linkedinUserId,
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
          linkedinUserId,
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

    const response = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.linkedin_access_token}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202504',
      },
      body: JSON.stringify(postData),
    });

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

  private async createTextPost(
    linkedinUserId: string,
    text: string,
  ): Promise<any> {
    return {
      author: `urn:li:person:${linkedinUserId}`,
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
    linkedinUserId: string,
    text: string,
    imageUrl: string,
    accessToken: string,
  ): Promise<any> {
    // First, upload the image to LinkedIn
    const uploadedImageUrn = await this.uploadImageToLinkedIn(
      imageUrl,
      accessToken,
    );

    return {
      author: `urn:li:person:${linkedinUserId}`,
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
    linkedinUserId: string,
    text: string,
    documentUrl: string,
    accessToken: string,
  ): Promise<any> {
    // Upload the document (PDF) to LinkedIn
    const uploadedDocumentUrn = await this.uploadDocumentToLinkedIn(
      documentUrl,
      accessToken,
    );

    return {
      author: `urn:li:person:${linkedinUserId}`,
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
  ): Promise<string> {
    try {
      // Initialize upload
      const initResponse = await fetch(
        'https://api.linkedin.com/rest/images?action=initializeUpload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202504',
          },
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: await this.getLinkedinPersonUrn(accessToken),
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
  ): Promise<string> {
    try {
      // Initialize document upload
      const initResponse = await fetch(
        'https://api.linkedin.com/rest/documents?action=initializeUpload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202504',
          },
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: await this.getLinkedinPersonUrn(accessToken),
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
