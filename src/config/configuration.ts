export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || '',

  app: {
    baseUrl: process.env.BACKEND_URL || '',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL || '',
    /** Optional: dedicated workflow for carousel (post + visual.carouselSlides). Falls back to webhookUrl. */
    carouselWebhookUrl: process.env.N8N_CAROUSEL_WEBHOOK_URL || '',
    apiKey: process.env.N8N_API_KEY || '',
    /** When set, n8n webhooks must send header X-N8N-Webhook-Secret with this value. */
    webhookSecret: process.env.N8N_WEBHOOK_SECRET || '',
    /** Max time workers wait for n8n callback before failing (ms). */
    workflowTimeoutMs: parseInt(
      process.env.N8N_WORKFLOW_TIMEOUT_MS || '300000',
      10,
    ),
  },

  aiRefinement: {
    enabled: process.env.AI_REFINEMENT_ENABLED !== 'false',
    baseUrl:
      process.env.AI_REFINEMENT_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.AI_REFINEMENT_MODEL || 'z-ai/glm-4.5-air:free',
    apiKey:
      process.env.AI_REFINEMENT_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '',
    timeoutMs: parseInt(process.env.AI_REFINEMENT_TIMEOUT_MS || '12000', 10),
    referer: process.env.AI_REFINEMENT_REFERER || '',
    appTitle: process.env.AI_REFINEMENT_APP_TITLE || 'Trndinn',
  },

  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
    redirectUri: process.env.LINKEDIN_REDIRECT_URI || '',
  },

  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'contentos-media',
    useSSL: process.env.MINIO_USE_SSL === 'true',
    publicUrl: process.env.MINIO_PUBLIC_URL || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change-this-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  /** When true, free-plan image uploads/generation get the brand JPEG watermark. Default off until launch. */
  watermark: {
    freePlanEnabled:
      process.env.WATERMARK_FREE_PLAN_ENABLED === 'true' ||
      process.env.WATERMARK_FREE_PLAN_ENABLED === '1',
  },
  features: {
    mediaPipelineV2:
      process.env.FEATURE_MEDIA_PIPELINE_V2 === 'true' ||
      process.env.FEATURE_MEDIA_PIPELINE_V2 === '1',
    // Default ON so company-page posting works out of the box.
    // Set FEATURE_LINKEDIN_ORG_PUBLISHING=false to explicitly disable it.
    linkedinOrgPublishing:
      process.env.FEATURE_LINKEDIN_ORG_PUBLISHING === undefined
        ? true
        : process.env.FEATURE_LINKEDIN_ORG_PUBLISHING === 'true' ||
          process.env.FEATURE_LINKEDIN_ORG_PUBLISHING === '1',
  },

  polar: {
    provider: 'polar',
    accessToken: process.env.POLAR_ACCESS_TOKEN || '',
    webhookSecret: process.env.POLAR_WEBHOOK_SECRET || '',
    organizationId: process.env.POLAR_ORGANIZATION_ID || '',
    organizationSlug: process.env.POLAR_ORGANIZATION || '',
    /** Polar mode: 'sandbox' | 'production'. Defaults to 'sandbox'. */
    mode: process.env.POLAR_MODE || process.env.POLAR_ENV || 'sandbox',
    /**
     * Push admin display pricing to Polar when `PUT /admin/subscription-plans/:plan` saves.
     * Mirrors legacy env toggles: unset defaults to on in production when `POLAR_ACCESS_TOKEN` is set.
     */
    syncPricesOnAdminSave: process.env.POLAR_SYNC_PRICES_ON_ADMIN_SAVE,
    enableCatalogSync: process.env.POLAR_ENABLE_CATALOG_SYNC,
    /** Product IDs - these are the actual Polar product IDs used for checkout */
    products: {
      standardMonthly: process.env.POLAR_PRODUCT_STANDARD_MONTHLY || '',
      standardYearly: process.env.POLAR_PRODUCT_STANDARD_YEARLY || '',
      proMonthly: process.env.POLAR_PRODUCT_PRO_MONTHLY || '',
      proYearly: process.env.POLAR_PRODUCT_PRO_YEARLY || '',
      ultimateMonthly: process.env.POLAR_PRODUCT_ULTIMATE_MONTHLY || '',
      ultimateYearly: process.env.POLAR_PRODUCT_ULTIMATE_YEARLY || '',
    },
    /** Price IDs - deprecated but kept for backwards compatibility */
    prices: {
      standardMonthly: process.env.POLAR_PRICE_STANDARD_MONTHLY || '',
      standardYearly: process.env.POLAR_PRICE_STANDARD_YEARLY || '',
      proMonthly: process.env.POLAR_PRICE_PRO_MONTHLY || '',
      proYearly: process.env.POLAR_PRICE_PRO_YEARLY || '',
      ultimateMonthly: process.env.POLAR_PRICE_ULTIMATE_MONTHLY || '',
      ultimateYearly: process.env.POLAR_PRICE_ULTIMATE_YEARLY || '',
    },
  },

  forex: {
    apiKey: process.env.FOREX_API_KEY || '',
    baseUrl:
      process.env.FOREX_API_BASE_URL || 'https://forex-aws.silverlining.cloud',
  },
});
