/**
 * OpenAPI 3.1 specification for the Trndinn Public API v1 (Sprint 1.8).
 *
 * Hand-authored (clean-room) and served verbatim at GET /api/v1/openapi.json so
 * SDK/codegen tools and Gate G5 (API Contract Lock) have a single source of
 * truth for the public contract. No framework reflection is used so the
 * published contract never drifts with internal refactors.
 *
 * LOCKED v1 contract — Gate G5. Additive changes only; no breaking changes
 * without a v2. (info.version is the contract version, not the build version.)
 */
export const OPENAPI_V1_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Trndinn Public API',
    version: '1.0.0',
    description:
      'Public REST API for creating/scheduling posts, listing connected social accounts, and uploading media. Authenticate with an API key: `Authorization: Bearer trnd_...`.',
  },
  servers: [{ url: '/api/v1', description: 'Public API v1' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/posts': {
      post: {
        summary: 'Create a post (publish now or schedule)',
        operationId: 'createPost',
        security: [{ bearerAuth: ['posts:write'] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePostRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Post created/published/scheduled',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreatePostResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
      get: {
        summary: 'List posts / check status',
        operationId: 'listPosts',
        security: [{ bearerAuth: ['posts:read'] }],
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Filter by status (scheduled, processing, published, failed, cancelled).',
          },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 20, maximum: 100 },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated list of posts',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ListPostsResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/posts/{id}': {
      delete: {
        summary: 'Cancel a scheduled post',
        operationId: 'cancelPost',
        security: [{ bearerAuth: ['posts:write'] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'The scheduled post id returned by createPost.',
          },
        ],
        responses: {
          '200': {
            description: 'Post cancelled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    status: { type: 'string', example: 'cancelled' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/social-accounts': {
      get: {
        summary: 'List connected social accounts',
        operationId: 'listSocialAccounts',
        security: [{ bearerAuth: ['accounts:read'] }],
        responses: {
          '200': {
            description: 'Connected accounts',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/SocialAccount' },
                    },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/social-accounts/{id}': {
      delete: {
        summary: 'Disconnect a connected social account',
        operationId: 'disconnectSocialAccount',
        security: [{ bearerAuth: ['accounts:write'] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description:
              'The connected account id returned by listSocialAccounts.',
          },
        ],
        responses: {
          '200': {
            description: 'Account disconnected',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    id: { type: 'string', format: 'uuid' },
                    platform: { type: 'string', example: 'linkedin' },
                    status: { type: 'string', example: 'disconnected' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/social-accounts/{id}/refresh': {
      post: {
        summary: 'Refresh / revalidate a connected account connection state',
        operationId: 'refreshSocialAccount',
        security: [{ bearerAuth: ['accounts:write'] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description:
              'The connected account id returned by listSocialAccounts.',
          },
        ],
        responses: {
          '200': {
            description:
              'Connection state revalidated. Active OAuth token rotation is a Phase 2 no-op stub.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    id: { type: 'string', format: 'uuid' },
                    platform: { type: 'string', example: 'linkedin' },
                    status: { type: 'string', example: 'active' },
                    tokenExpiresAt: {
                      type: 'string',
                      format: 'date-time',
                      nullable: true,
                    },
                    tokenValid: { type: 'boolean', nullable: true },
                    refreshed: { type: 'boolean', example: false },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/media': {
      post: {
        summary: 'Upload media (base64 or remote URL)',
        operationId: 'uploadMedia',
        security: [{ bearerAuth: ['media:write'] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  image: {
                    type: 'string',
                    description: 'Base64 image bytes (data URI prefix optional).',
                  },
                  url: {
                    type: 'string',
                    format: 'uri',
                    description: 'Alternative: public image URL to fetch.',
                  },
                  filename: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Uploaded media',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    id: { type: 'string', format: 'uuid' },
                    url: { type: 'string', format: 'uri' },
                    fileType: { type: 'string', example: 'image' },
                    fileSize: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'Insufficient credits' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '413': { description: 'Payload too large' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'trnd_*',
        description:
          'API key issued from Settings → API Keys. Send as `Authorization: Bearer trnd_...`.',
      },
    },
    schemas: {
      CreatePostRequest: {
        type: 'object',
        required: ['type', 'content'],
        properties: {
          type: {
            type: 'string',
            enum: ['now', 'schedule'],
            description: 'Publish immediately or schedule for later.',
          },
          content: { type: 'string', description: 'Post body text.' },
          title: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          mediaUrls: {
            type: 'array',
            items: { type: 'string', format: 'uri' },
            description: 'Image URLs (first is primary). Use POST /media first.',
          },
          carouselUrls: {
            type: 'array',
            items: { type: 'string', format: 'uri' },
          },
          pdfUrl: { type: 'string', format: 'uri' },
          scheduledFor: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 (UTC). Required when type=schedule.',
          },
          platform: { type: 'string', default: 'linkedin' },
          actorType: { type: 'string', enum: ['member', 'organization'] },
          organizationUrn: {
            type: 'string',
            description: 'Required when actorType=organization.',
          },
        },
      },
      CreatePostResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          type: { type: 'string', enum: ['now', 'schedule'] },
          postId: { type: 'string' },
          contentId: { type: 'string', format: 'uuid' },
          status: { type: 'string' },
          platformPostId: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date-time' },
        },
      },
      ListPostsResponse: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Post' } },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              limit: { type: 'integer' },
              total: { type: 'integer' },
              totalPages: { type: 'integer' },
              hasMore: { type: 'boolean' },
            },
          },
        },
      },
      Post: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          contentId: { type: 'string', format: 'uuid', nullable: true },
          status: { type: 'string' },
          platform: { type: 'string', nullable: true },
          scheduledFor: { type: 'string', format: 'date-time', nullable: true },
          publishedAt: { type: 'string', format: 'date-time', nullable: true },
          platformPostId: { type: 'string', nullable: true },
          content: { type: 'string', nullable: true },
          title: { type: 'string', nullable: true },
        },
      },
      SocialAccount: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          platform: { type: 'string', example: 'linkedin' },
          accountType: {
            type: 'string',
            enum: ['personal', 'organization'],
          },
          platformAccountId: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          profileUrl: { type: 'string', nullable: true },
          avatarUrl: { type: 'string', nullable: true },
          status: { type: 'string' },
          connectedAt: { type: 'string', format: 'date-time', nullable: true },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Error: {
        type: 'object',
        properties: {
          statusCode: { type: 'integer' },
          message: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'Invalid request',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
      Unauthorized: {
        description: 'Missing or invalid API key',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
      Forbidden: {
        description: 'API key lacks the required scope',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
      RateLimited: {
        description:
          'Rate limit exceeded. See X-RateLimit-* and Retry-After headers.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
    },
  },
} as const;
