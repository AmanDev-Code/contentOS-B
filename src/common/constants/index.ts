export const PLAN_LIMITS = {
  free: {
    monthlyGenerations: 5,
    carouselLimit: 0,
    imageLimit: 5,
    linkedinPosts: 5,
  },
  starter: {
    monthlyGenerations: 50,
    carouselLimit: 10,
    imageLimit: 50,
    linkedinPosts: 50,
  },
  pro: {
    monthlyGenerations: 200,
    carouselLimit: 50,
    imageLimit: 200,
    linkedinPosts: 200,
  },
  enterprise: {
    monthlyGenerations: -1,
    carouselLimit: -1,
    imageLimit: -1,
    linkedinPosts: -1,
  },
};

export const QUEUE_NAMES = {
  CONTENT_GENERATION: 'content-generation',
  LINKEDIN_PUBLISH: 'linkedin-publish',
  MEDIA_SINGLE: 'media-single',
  MEDIA_CAROUSEL: 'media-carousel',
};

export const JOB_STAGES = {
  TOPIC_DISCOVERY: 'topic_discovery',
  CONTENT_GENERATION: 'content_generation',
  IMAGE_GENERATION: 'image_generation',
  CAROUSEL_GENERATION: 'carousel_generation',
  FINALIZING: 'finalizing',
};

export const RATE_LIMITS = {
  GENERATION_ENDPOINT: {
    ttl: 60000,
    limit: 10,
  },
  PUBLISH_ENDPOINT: {
    ttl: 60000,
    limit: 5,
  },
  AUTH_ENDPOINT: {
    ttl: 60000,
    limit: 20,
  },
};

export const ERROR_MESSAGES = {
  QUOTA_EXCEEDED:
    'Monthly generation quota exceeded. Please upgrade your plan.',
  INVALID_SUBSCRIPTION: 'Invalid or expired subscription.',
  LINKEDIN_NOT_CONNECTED: 'LinkedIn account not connected.',
  LINKEDIN_TOKEN_EXPIRED: 'LinkedIn token expired. Please reconnect.',
  GENERATION_FAILED: 'Content generation failed. Please try again.',
  UNAUTHORIZED: 'Unauthorized access.',
  INVALID_INPUT: 'Invalid input data.',
};

export const SUCCESS_MESSAGES = {
  GENERATION_STARTED: 'Content generation started successfully.',
  CONTENT_PUBLISHED: 'Content published to LinkedIn successfully.',
  LINKEDIN_CONNECTED: 'LinkedIn account connected successfully.',
};
