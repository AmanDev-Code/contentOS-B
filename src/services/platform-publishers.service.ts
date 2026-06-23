import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

export interface PublishResult {
  success: boolean;
  url?: string;
  error?: string;
}

// Tier 2: Submit for Review platforms (generate submission-ready content)
const SUBMIT_FOR_REVIEW_PLATFORMS = new Set([
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
]);

// Tier 3: Discussion platforms (generate discussion-format content)
const DISCUSSION_PLATFORMS = new Set([
  'reddit',
  'indiehackers',
  'producthunt_discussions',
  'growthhackers',
  'hackernews',
  'huggingface_community',
]);

// All manual-only platforms (Tier 2 + Tier 3 + legacy manual)
const MANUAL_ONLY_PLATFORMS = new Set([
  // Legacy manual platforms
  'substack',
  'twitter_thread',
  'facebook',
  'instagram',
  'newsletter',
  'medium', // Medium API deprecated, keep as manual fallback
  // Tier 2: Submit for Review
  ...SUBMIT_FOR_REVIEW_PLATFORMS,
  // Tier 3: Discussion
  ...DISCUSSION_PLATFORMS,
]);

const REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class PlatformPublishersService {
  private readonly logger = new Logger(PlatformPublishersService.name);

  isManualOnly(platform: string): boolean {
    return MANUAL_ONLY_PLATFORMS.has(platform);
  }

  isSubmitForReview(platform: string): boolean {
    return SUBMIT_FOR_REVIEW_PLATFORMS.has(platform);
  }

  isDiscussionPlatform(platform: string): boolean {
    return DISCUSSION_PLATFORMS.has(platform);
  }

  getPlatformTier(
    platform: string,
  ): 'auto' | 'submit' | 'discussion' | 'manual' {
    if (SUBMIT_FOR_REVIEW_PLATFORMS.has(platform)) return 'submit';
    if (DISCUSSION_PLATFORMS.has(platform)) return 'discussion';
    if (MANUAL_ONLY_PLATFORMS.has(platform)) return 'manual';
    return 'auto';
  }

  async publish(
    platform: string,
    credentials: Record<string, any>,
    content: string,
    title: string,
    canonicalUrl: string,
    tags: string[],
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    if (this.isManualOnly(platform)) {
      return {
        success: false,
        error: `Manual publishing required for ${platform} — use the Copy button to paste content manually.`,
      };
    }

    switch (platform) {
      case 'devto':
        return this.publishToDevTo(
          credentials as any,
          content,
          title,
          canonicalUrl,
          tags,
          coverImageUrl,
        );
      case 'hashnode':
        return this.publishToHashnode(
          credentials as any,
          content,
          title,
          canonicalUrl,
          tags,
          coverImageUrl,
        );
      case 'medium':
        return this.publishToMedium(
          credentials as any,
          content,
          title,
          canonicalUrl,
          tags,
        );
      case 'linkedin_article':
        return this.publishToLinkedIn(credentials as any, content, title, coverImageUrl);
      case 'linkedin_post':
        return this.publishLinkedInPost(credentials as any, content, coverImageUrl);
      case 'ghost':
        return this.publishToGhost(
          credentials as any,
          content,
          title,
          canonicalUrl,
          tags,
          coverImageUrl,
        );
      case 'beehiiv':
        return this.publishToBeehiiv(credentials as any, content, title, coverImageUrl);
      case 'telegraph':
        return this.publishToTelegraph(
          credentials as any,
          content,
          title,
          canonicalUrl,
        );
      case 'blogger':
        return this.publishToBlogger(
          credentials as any,
          content,
          title,
          canonicalUrl,
          tags,
        );
      default:
        return { success: false, error: `Unsupported platform: ${platform}` };
    }
  }

  async publishToDevTo(
    credentials: { api_key: string },
    content: string,
    title: string,
    canonicalUrl: string,
    tags: string[],
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Dev.to: "${title}"`);

      // Ensure any frontmatter in body_markdown has published: true
      // Dev.to frontmatter overrides API params, so we must fix it in the content
      let sanitizedContent = content;
      const fmMatch = sanitizedContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const fmBody = fmMatch[1];
        if (/^published\s*:\s*false/m.test(fmBody)) {
          const fixedFm = fmBody.replace(/^published\s*:.*$/m, 'published: true');
          sanitizedContent = sanitizedContent.replace(fmMatch[0], `---\n${fixedFm}\n---`);
          this.logger.log('Dev.to: Fixed published: false in frontmatter');
        }
      }

      const articlePayload: Record<string, any> = {
        title,
        body_markdown: sanitizedContent,
        published: true,
        canonical_url: canonicalUrl,
        tags: tags
          .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
          .filter((t) => t.length > 0)
          .slice(0, 4),
      };

      // Add cover image if provided (Dev.to uses main_image field)
      if (coverImageUrl) {
        articlePayload.main_image = coverImageUrl;
        this.logger.log(`Dev.to: Including cover image: ${coverImageUrl}`);
      }

      const response = await axios.post(
        'https://dev.to/api/articles',
        { article: articlePayload },
        {
          headers: {
            'api-key': credentials.api_key,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const url = response.data?.url;
      this.logger.log(`Dev.to publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Dev.to');
      this.logger.error(`Dev.to publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  async publishToHashnode(
    credentials: { token: string; publication_id?: string; username?: string },
    content: string,
    title: string,
    canonicalUrl: string,
    tags: string[],
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Hashnode: "${title}"`);

      // Resolve publication_id: use stored value or look it up from username
      let publicationId: string | undefined = credentials.publication_id;
      if (!publicationId && credentials.username) {
        publicationId =
          (await this.resolveHashnodePublicationId(
            credentials.token,
            credentials.username,
          )) ?? undefined;
        if (!publicationId) {
          return {
            success: false,
            error: `Hashnode: Could not resolve publication ID for username "${credentials.username}". Please add publication_id to your credentials.`,
          };
        }
        this.logger.log(
          `Hashnode: Resolved publication ID ${publicationId} from username "${credentials.username}"`,
        );
      }

      if (!publicationId) {
        return {
          success: false,
          error:
            'Hashnode: Missing publication_id in credentials. Please reconnect with your publication ID.',
        };
      }

      const mutation = `
        mutation PublishPost($input: PublishPostInput!) {
          publishPost(input: $input) {
            post {
              url
              id
              slug
            }
          }
        }
      `;

      const input: Record<string, any> = {
        title,
        contentMarkdown: content,
        publicationId,
        tags: tags.slice(0, 5).map((t) => ({
          slug: t.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          name: t,
        })),
      };

      // Only include originalArticleURL if it's a valid external URL
      if (canonicalUrl && canonicalUrl.startsWith('http')) {
        input.originalArticleURL = canonicalUrl;
      }

      // Add cover image if provided (Hashnode uses coverImageOptions)
      if (coverImageUrl) {
        input.coverImageOptions = {
          coverImageURL: coverImageUrl,
        };
        this.logger.log(`Hashnode: Including cover image: ${coverImageUrl}`);
      }

      const variables = { input };

      const response = await axios.post(
        'https://gql.hashnode.com',
        { query: mutation, variables },
        {
          headers: {
            Authorization: credentials.token,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      if (response.data?.errors?.length) {
        const gqlError = response.data.errors[0]?.message || 'GraphQL error';
        this.logger.error(`Hashnode GraphQL error: ${gqlError}`);
        return { success: false, error: `Hashnode: ${gqlError}` };
      }

      const post = response.data?.data?.publishPost?.post;
      const url = post?.url;
      if (!url && post?.slug && credentials.username) {
        // Construct URL from slug if API doesn't return it
        const constructedUrl = `https://${credentials.username}.hashnode.dev/${post.slug}`;
        this.logger.log(`Hashnode publish success (constructed URL): ${constructedUrl}`);
        return { success: true, url: constructedUrl };
      }
      this.logger.log(`Hashnode publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Hashnode');
      this.logger.error(`Hashnode publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Resolve a Hashnode publication ID from a username/host.
   * Uses the Hashnode GraphQL API to look up the publication.
   */
  private async resolveHashnodePublicationId(
    token: string,
    username: string,
  ): Promise<string | null> {
    try {
      // First try: use the "me" query to get user's own publications
      const meQuery = `
        query Me {
          me {
            publications(first: 10) {
              edges {
                node {
                  id
                  title
                  url
                }
              }
            }
          }
        }
      `;

      const meResponse = await axios.post(
        'https://gql.hashnode.com',
        { query: meQuery },
        {
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const publications =
        meResponse.data?.data?.me?.publications?.edges ?? [];
      if (publications.length > 0) {
        const pubId = publications[0].node.id;
        this.logger.log(
          `Hashnode: Resolved publication ID ${pubId} via "me" query (${publications[0].node.title})`,
        );
        return pubId;
      }

      // Fallback: try host-based lookup with .hashnode.dev suffix
      const hostQuery = `
        query GetPublication($host: String!) {
          publication(host: $host) {
            id
          }
        }
      `;

      const host = username.includes('.')
        ? username
        : `${username}.hashnode.dev`;

      const response = await axios.post(
        'https://gql.hashnode.com',
        { query: hostQuery, variables: { host } },
        {
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const pubId = response.data?.data?.publication?.id;
      return pubId || null;
    } catch (err) {
      this.logger.warn(
        `Failed to resolve Hashnode publication ID for "${username}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  async publishToMedium(
    credentials: { token: string; author_id: string },
    content: string,
    title: string,
    canonicalUrl: string,
    tags: string[],
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Medium: "${title}"`);

      const response = await axios.post(
        `https://api.medium.com/v1/users/${credentials.author_id}/posts`,
        {
          title,
          contentFormat: 'markdown',
          content,
          canonicalUrl,
          tags: tags.slice(0, 5),
          publishStatus: 'public',
        },
        {
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const url = response.data?.data?.url;
      this.logger.log(`Medium publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Medium');
      this.logger.error(`Medium publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  async publishToLinkedIn(
    credentials: { access_token: string; author_urn: string },
    content: string,
    title: string,
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing LinkedIn article: "${title}"`);

      let imageUrn: string | undefined;

      // If cover image provided, upload it to LinkedIn first
      if (coverImageUrl) {
        imageUrn = await this.uploadImageToLinkedIn(
          credentials.access_token,
          credentials.author_urn,
          coverImageUrl,
        );
        if (imageUrn) {
          this.logger.log(`LinkedIn: Image uploaded with URN: ${imageUrn}`);
        }
      }

      const body: Record<string, any> = {
        author: credentials.author_urn,
        commentary: `${title}\n\n${content.slice(0, 2800)}`,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };

      // Attach image if uploaded successfully
      if (imageUrn) {
        body.content = {
          media: {
            id: imageUrn,
            title: title.slice(0, 100),
          },
        };
      }

      const response = await axios.post(
        'https://api.linkedin.com/rest/posts',
        body,
        {
          headers: {
            Authorization: `Bearer ${credentials.access_token}`,
            'LinkedIn-Version': '202401',
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const postId = response.headers['x-restli-id'];
      const url = postId
        ? `https://www.linkedin.com/feed/update/${postId}`
        : undefined;
      this.logger.log(`LinkedIn article publish success: ${url || postId}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'LinkedIn');
      this.logger.error(`LinkedIn article publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  async publishLinkedInPost(
    credentials: { access_token: string; author_urn: string },
    content: string,
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log('Publishing LinkedIn post (short-form)');

      let imageUrn: string | undefined;

      // If cover image provided, upload it to LinkedIn first
      if (coverImageUrl) {
        imageUrn = await this.uploadImageToLinkedIn(
          credentials.access_token,
          credentials.author_urn,
          coverImageUrl,
        );
        if (imageUrn) {
          this.logger.log(`LinkedIn: Image uploaded with URN: ${imageUrn}`);
        }
      }

      const body: Record<string, any> = {
        author: credentials.author_urn,
        commentary: content,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };

      // Attach image if uploaded successfully
      if (imageUrn) {
        body.content = {
          media: {
            id: imageUrn,
          },
        };
      }

      const response = await axios.post(
        'https://api.linkedin.com/rest/posts',
        body,
        {
          headers: {
            Authorization: `Bearer ${credentials.access_token}`,
            'LinkedIn-Version': '202401',
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const postId = response.headers['x-restli-id'];
      const url = postId
        ? `https://www.linkedin.com/feed/update/${postId}`
        : undefined;
      this.logger.log(`LinkedIn post publish success: ${url || postId}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'LinkedIn');
      this.logger.error(`LinkedIn post publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Upload an image to LinkedIn and return the image URN.
   * LinkedIn requires a 3-step process:
   * 1. Initialize upload to get uploadUrl and image URN
   * 2. PUT the image binary to the uploadUrl
   * 3. Use the image URN in the post
   */
  private async uploadImageToLinkedIn(
    accessToken: string,
    authorUrn: string,
    imageUrl: string,
  ): Promise<string | undefined> {
    try {
      // Step 1: Initialize the upload
      const initResponse = await axios.post(
        'https://api.linkedin.com/rest/images?action=initializeUpload',
        {
          initializeUploadRequest: {
            owner: authorUrn,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': '202401',
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const uploadUrl = initResponse.data?.value?.uploadUrl;
      const imageUrn = initResponse.data?.value?.image;

      if (!uploadUrl || !imageUrn) {
        this.logger.warn('LinkedIn: Failed to initialize image upload');
        return undefined;
      }

      // Step 2: Download the image from our MinIO URL
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: REQUEST_TIMEOUT_MS,
      });

      // Step 3: Upload the image binary to LinkedIn's uploadUrl
      await axios.put(uploadUrl, imageResponse.data, {
        headers: {
          'Content-Type': 'image/png',
        },
        timeout: REQUEST_TIMEOUT_MS,
      });

      return imageUrn;
    } catch (err) {
      this.logger.warn(
        `LinkedIn image upload failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  // ===== NEW TIER 1 AUTO-PUBLISH PLATFORMS =====

  async publishToGhost(
    credentials: { admin_api_key: string; api_url: string },
    content: string,
    title: string,
    canonicalUrl: string,
    tags: string[],
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Ghost: "${title}"`);

      // Ghost Admin API uses JWT authentication
      const [id, secret] = credentials.admin_api_key.split(':');
      if (!id || !secret) {
        return {
          success: false,
          error:
            'Invalid Ghost Admin API key format. Expected format: id:secret',
        };
      }

      // Create JWT token for Ghost Admin API
      const jwt = await this.createGhostJwt(id, secret);

      const postPayload: Record<string, any> = {
        title,
        html: this.markdownToHtml(content),
        status: 'published',
        canonical_url: canonicalUrl,
        tags: tags.slice(0, 5).map((t) => ({ name: t })),
      };

      // Add feature image if provided
      if (coverImageUrl) {
        postPayload.feature_image = coverImageUrl;
        this.logger.log(`Ghost: Including cover image: ${coverImageUrl}`);
      }

      const apiUrl = credentials.api_url.replace(/\/$/, '');
      const response = await axios.post(
        `${apiUrl}/ghost/api/admin/posts/`,
        { posts: [postPayload] },
        {
          headers: {
            Authorization: `Ghost ${jwt}`,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const post = response.data?.posts?.[0];
      const url = post?.url;
      this.logger.log(`Ghost publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Ghost');
      this.logger.error(`Ghost publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  private async createGhostJwt(id: string, secret: string): Promise<string> {
    // Ghost uses a simple JWT with HS256
    const crypto = await import('crypto');

    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }),
    ).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + 300, // 5 minutes
        aud: '/admin/',
      }),
    ).toString('base64url');

    const keyBuffer = Buffer.from(secret, 'hex');
    const signature = crypto
      .createHmac('sha256', keyBuffer)
      .update(`${header}.${payload}`)
      .digest('base64url');

    return `${header}.${payload}.${signature}`;
  }

  private markdownToHtml(markdown: string): string {
    // Basic markdown to HTML conversion for Ghost
    return markdown
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^\- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(.+)$/gm, (match) => {
        if (match.startsWith('<')) return match;
        return `<p>${match}</p>`;
      });
  }

  async publishToBeehiiv(
    credentials: { api_key: string; publication_id: string },
    content: string,
    title: string,
    coverImageUrl?: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Beehiiv: "${title}"`);

      const postPayload: Record<string, any> = {
        title,
        content_html: this.markdownToHtml(content),
        status: 'confirmed', // 'draft' | 'confirmed' | 'archived'
        send_to_subscribers: false, // Don't auto-send as email
      };

      // Add thumbnail image if provided
      if (coverImageUrl) {
        postPayload.thumbnail_url = coverImageUrl;
        this.logger.log(`Beehiiv: Including cover image: ${coverImageUrl}`);
      }

      const response = await axios.post(
        `https://api.beehiiv.com/v2/publications/${credentials.publication_id}/posts`,
        postPayload,
        {
          headers: {
            Authorization: `Bearer ${credentials.api_key}`,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const post = response.data?.data;
      const url = post?.web_url || post?.url;
      this.logger.log(`Beehiiv publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Beehiiv');
      this.logger.error(`Beehiiv publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  async publishToTelegraph(
    credentials: {
      access_token: string;
      author_name?: string;
      author_url?: string;
    },
    content: string,
    title: string,
    canonicalUrl: string,
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Telegraph: "${title}"`);

      // Telegraph uses a specific content format (array of Node objects)
      const telegraphContent = this.markdownToTelegraphNodes(content);

      const response = await axios.post(
        'https://api.telegra.ph/createPage',
        {
          access_token: credentials.access_token,
          title,
          author_name: credentials.author_name || 'Trndinn',
          author_url: credentials.author_url || canonicalUrl,
          content: telegraphContent,
          return_content: false,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      if (!response.data?.ok) {
        return {
          success: false,
          error: response.data?.error || 'Telegraph API error',
        };
      }

      const url = response.data?.result?.url;
      this.logger.log(`Telegraph publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Telegraph');
      this.logger.error(`Telegraph publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  private markdownToTelegraphNodes(markdown: string): any[] {
    // Convert markdown to Telegraph Node format
    const nodes: any[] = [];
    const lines = markdown.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      if (line.startsWith('### ')) {
        nodes.push({ tag: 'h4', children: [line.slice(4)] });
      } else if (line.startsWith('## ')) {
        nodes.push({ tag: 'h3', children: [line.slice(3)] });
      } else if (line.startsWith('# ')) {
        nodes.push({ tag: 'h3', children: [line.slice(2)] });
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        nodes.push({ tag: 'p', children: ['• ' + line.slice(2)] });
      } else if (/^\d+\.\s/.test(line)) {
        nodes.push({ tag: 'p', children: [line] });
      } else {
        // Process inline formatting
        const text = line
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/\*(.+?)\*/g, '<i>$1</i>')
          .replace(/`(.+?)`/g, '<code>$1</code>');

        // Parse inline HTML tags into Telegraph format
        const children: any[] = [];
        const parts = text.split(/(<[^>]+>[^<]*<\/[^>]+>)/);
        for (const part of parts) {
          const match = part.match(/<(\w+)>([^<]*)<\/\1>/);
          if (match) {
            children.push({ tag: match[1], children: [match[2]] });
          } else if (part) {
            children.push(part);
          }
        }

        if (children.length > 0) {
          nodes.push({
            tag: 'p',
            children:
              children.length === 1 && typeof children[0] === 'string'
                ? children
                : children,
          });
        }
      }
    }

    return nodes;
  }

  async publishToBlogger(
    credentials: { oauth_token: string; blog_id: string },
    content: string,
    title: string,
    canonicalUrl: string,
    tags: string[],
  ): Promise<PublishResult> {
    try {
      this.logger.log(`Publishing to Blogger: "${title}"`);

      const response = await axios.post(
        `https://www.googleapis.com/blogger/v3/blogs/${credentials.blog_id}/posts/`,
        {
          kind: 'blogger#post',
          title,
          content: this.markdownToHtml(content),
          labels: tags.slice(0, 10),
          customMetaData: JSON.stringify({ canonical_url: canonicalUrl }),
        },
        {
          headers: {
            Authorization: `Bearer ${credentials.oauth_token}`,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const url = response.data?.url;
      this.logger.log(`Blogger publish success: ${url}`);
      return { success: true, url };
    } catch (err) {
      const message = this.extractErrorMessage(err, 'Blogger');
      this.logger.error(`Blogger publish failed: ${message}`);
      return { success: false, error: message };
    }
  }

  // ===== TELEGRAPH ACCOUNT CREATION =====

  async createTelegraphAccount(
    shortName: string,
    authorName?: string,
  ): Promise<{ access_token: string; auth_url: string } | null> {
    try {
      const response = await axios.post(
        'https://api.telegra.ph/createAccount',
        {
          short_name: shortName,
          author_name: authorName || shortName,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      if (response.data?.ok) {
        return {
          access_token: response.data.result.access_token,
          auth_url: response.data.result.auth_url,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractErrorMessage(err: unknown, platform: string): string {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const data = err.response?.data;
      const apiMsg =
        typeof data === 'object' && data !== null
          ? data.message || data.error || JSON.stringify(data).slice(0, 200)
          : String(data || '').slice(0, 200);
      return `${platform} API error (HTTP ${status || 'network'}): ${apiMsg}`;
    }
    if (err instanceof Error) {
      return `${platform}: ${err.message}`;
    }
    return `${platform}: Unknown error`;
  }
}
