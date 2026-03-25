export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  app: {
    baseUrl: process.env.BACKEND_URL || 'http://localhost:3000',
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
    apiKey: process.env.N8N_API_KEY || '',
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
    bucket: process.env.MINIO_BUCKET || 'contentos-assets',
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

  paddle: {
    env: process.env.PADDLE_ENV || 'sandbox',
    apiKey: process.env.PADDLE_API_KEY || '',
    webhookSecret: process.env.PADDLE_WEBHOOK_SECRET || '',
    webhookUrl: process.env.PADDLE_WEBHOOK_URL || '',
    prices: {
      standardMonthly: process.env.PADDLE_PRICE_STANDARD_MONTHLY || '',
      standardYearly: process.env.PADDLE_PRICE_STANDARD_YEARLY || '',
      proMonthly: process.env.PADDLE_PRICE_PRO_MONTHLY || '',
      proYearly: process.env.PADDLE_PRICE_PRO_YEARLY || '',
      ultimateMonthly: process.env.PADDLE_PRICE_ULTIMATE_MONTHLY || '',
      ultimateYearly: process.env.PADDLE_PRICE_ULTIMATE_YEARLY || '',
    },
  },
});
