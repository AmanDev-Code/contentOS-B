export class OffTopicError extends Error {
  readonly code = 'off_topic' as const;
  constructor() {
    super('The provided input is not suitable for a social media post.');
    this.name = 'OffTopicError';
  }
}

export class SchemaValidationError extends Error {
  readonly code = 'schema_validation' as const;
  constructor(detail: string) {
    super(`AI output failed schema validation: ${detail}`);
    this.name = 'SchemaValidationError';
  }
}

export class ContentTooLongError extends Error {
  readonly code = 'content_too_long' as const;
  constructor(actual: number, limit: number) {
    super(`Content is ${actual} words, exceeding hard cap of ${limit}`);
    this.name = 'ContentTooLongError';
  }
}

export class ProviderError extends Error {
  readonly code = 'provider_error' as const;
  constructor(detail: string) {
    super(`AI provider error: ${detail}`);
    this.name = 'ProviderError';
  }
}

export class CarouselQualityError extends Error {
  readonly errorCode = 'carousel_quality' as const;
  constructor(
    readonly issues: Array<{ code: string; detail: string }>,
  ) {
    const codes = issues.map((i) => i.code).join(', ');
    const lead = issues[0]?.detail?.slice(0, 220) ?? '';
    super(
      `Carousel did not meet quality checks (${codes}). ${lead}${issues.length > 1 ? ' (see additional codes in logs)' : ''} Try increasing specificity, reducing slide count, or retrying.`,
    );
    this.name = 'CarouselQualityError';
  }
}
