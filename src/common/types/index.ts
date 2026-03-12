export enum ContentStatus {
  DRAFT = 'draft',
  GENERATING = 'generating',
  READY = 'ready',
  PUBLISHED = 'published',
  FAILED = 'failed',
}

export enum JobStatus {
  PENDING = 'pending',
  GENERATING = 'generating',
  READY = 'ready',
  FAILED = 'failed',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  TRIALING = 'trialing',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
}

export enum PlanType {
  FREE = 'free',
  STARTER = 'starter',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export enum VisualType {
  IMAGE = 'image',
  CAROUSEL = 'carousel',
  NONE = 'none',
}

export interface GeneratedContent {
  id: string;
  userId: string;
  title: string;
  content: string;
  categoryId?: string;
  aiScore?: number;
  status: ContentStatus;
  visualUrl?: string;
  visualType: VisualType;
  carouselUrls?: string[];
  hashtags?: string[];
  aiReasoning?: string;
  performancePrediction?: Record<string, any>;
  suggestedImprovements?: string[];
  linkedinPostUrl?: string;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface GenerationJob {
  id: string;
  userId: string;
  contentId?: string;
  status: JobStatus;
  progress: number;
  currentStage?: string;
  webhookUrl?: string;
  response?: Record<string, any>;
  error?: string;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Profile {
  id: string;
  username?: string;
  full_name?: string;
  avatar_url?: string;
  plan: PlanType;
  credits_remaining: number;
  monthly_credits: number;
  daily_credits_used: number;
  daily_credits_reset_at: Date;
  preferences?: Record<string, any>;
  linkedin_access_token?: string;
  linkedin_refresh_token?: string;
  linkedin_expires_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Subscription {
  id: string;
  userId: string;
  plan: PlanType;
  status: SubscriptionStatus;
  currentPeriodEnd?: Date;
  createdAt: Date;
}

export interface N8nWebhookPayload {
  jobId: string;
  userId: string;
  callbackUrl: string;
  topics?: string[];
  preferences?: Record<string, any>;
}

export interface N8nCallbackPayload {
  jobId: string;
  status: 'success' | 'failed';
  content?: {
    title: string;
    content: string;
    hashtags: string[];
    visualType: VisualType;
    visualUrl?: string;
    carouselUrls?: string[];
    aiScore?: number;
    aiReasoning?: string;
    category?: string;
    sourceLink?: string;
    imagePrompt?: string;
  };
  error?: string;
}
