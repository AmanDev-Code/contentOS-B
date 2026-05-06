export { PostAiModule } from './post-ai.module';
export { CustomTopicGenerationService } from './custom-topic-generation.service';
export type {
  CustomTopicResult,
  CustomTopicGenerateLifecycle,
} from './custom-topic-generation.service';

export {
  PostGenerationInputSchema,
  TextPostOutputSchema,
  ImagePostOutputSchema,
  CarouselPostOutputSchema,
  OffTopicOutputSchema,
  PostOutputSchema,
  normalizeCustomTopicLlmPayload,
  safeParseCustomTopicPostOutput,
} from './custom-topic.schemas';

export type {
  PostGenerationInput,
  TextPostOutput,
  ImagePostOutput,
  CarouselPostOutput,
  PostOutput,
} from './custom-topic.schemas';

export { resolveWordLimit, countWords, isWithinLimit } from './word-limit';
export type { WordLimitConfig } from './word-limit';

export {
  TONALITY_GUIDES,
  getTonalityGuide,
  buildTonalityFragment,
} from './tonality';
export type { TonalityGuide, PlatformOverrides } from './tonality';

export { buildCustomTopicPrompt } from './prompt-builder';
export { selectHashtags } from './hashtag-selector';

export {
  OffTopicError,
  SchemaValidationError,
  ContentTooLongError,
  ProviderError,
  CarouselQualityError,
} from './errors';
