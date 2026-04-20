import { MediaPostType } from '../dto/media-intent.dto';

export type SlidePayload = {
  headline: string;
  body: string;
  imagePrompt: string;
};

export type NormalizedN8nCallback = {
  jobId: string;
  status: 'success' | 'failed';
  content?: {
    title: string;
    content: string;
    hashtags?: string[];
    postType?: MediaPostType;
    imagePrompt?: string;
    slides?: SlidePayload[];
    visualUrl?: string;
    carouselUrls?: string[];
    aiScore?: number;
    aiReasoning?: string;
    performancePrediction?: Record<string, unknown>;
  };
  error?: string;
};

/**
 * Accepts either legacy backend shape or new n8n carousel workflow shape
 * (array with { post, hashtags, visual.carouselSlides, jobId }).
 */
export function normalizeN8nCallbackBody(raw: unknown): NormalizedN8nCallback {
  let root: Record<string, unknown> | null = null;

  if (Array.isArray(raw) && raw.length > 0) {
    root = raw[0] as Record<string, unknown>;
  } else if (raw && typeof raw === 'object') {
    root = raw as Record<string, unknown>;
  }

  if (!root) {
    throw new Error('Invalid n8n callback: empty body');
  }

  const jobId = String(root.jobId || '').trim();
  if (!jobId) {
    throw new Error('Invalid n8n callback: jobId is required');
  }

  const status = root.status === 'failed' ? 'failed' : 'success';

  if (status === 'failed') {
    return {
      jobId,
      status: 'failed',
      error: typeof root.error === 'string' ? root.error : 'Unknown error',
    };
  }

  // New workflow: top-level post + visual (single/carousel)
  const post = root.post as Record<string, unknown> | undefined;
  const visual = root.visual as Record<string, unknown> | undefined;
  const hashtags = (root.hashtags as string[] | undefined) || undefined;

  if (post) {
    const visualType = String(visual?.type ?? '').trim().toLowerCase();
    const rawSlides = Array.isArray(visual?.carouselSlides)
      ? (visual.carouselSlides as Array<Record<string, unknown>>)
      : [];
    const slides: SlidePayload[] = rawSlides
      .map((s: Record<string, unknown>) => ({
        headline: String(s.headline ?? '')
          .trim()
          .slice(0, 200),
        body: String(s.body ?? '')
          .trim()
          .slice(0, 500),
        imagePrompt: String(s.imagePrompt ?? '')
          .trim()
          .slice(0, 1500),
      }))
      .filter((s) => Boolean(s.headline || s.body || s.imagePrompt));

    const isCarousel =
      visualType === 'carousel' || (!visualType && slides.length >= 2);
    if (isCarousel && slides.length < 2) {
      throw new Error(
        'Invalid n8n carousel payload: visual.carouselSlides must have at least 2 slides',
      );
    }
    const title =
      String(post.title ?? '')
        .trim()
        .slice(0, 180) || 'Untitled';
    const content = String(post.content ?? '')
      .trim()
      .slice(0, 5000);
    const aiScore =
      typeof post.finalScore === 'number'
        ? post.finalScore
        : typeof post.aiScore === 'number'
          ? post.aiScore
          : undefined;
    const aiReasoning =
      typeof post.reason === 'string' ? post.reason : undefined;

    const performancePrediction: Record<string, unknown> = {
      source: 'n8n-post',
      visualType: visualType || undefined,
      visualStyle:
        typeof visual?.style === 'string' ? visual.style : undefined,
      slides: slides.length > 0 ? slides : undefined,
      postMeta: {
        link: typeof post.link === 'string' ? post.link : undefined,
        source: typeof post.source === 'string' ? post.source : undefined,
        category: typeof post.category === 'string' ? post.category : undefined,
        originalScore: post.originalScore,
        finalScore: post.finalScore,
      },
    };

    return {
      jobId,
      status: 'success',
      content: {
        title,
        content,
        hashtags,
        postType: isCarousel ? MediaPostType.CAROUSEL : MediaPostType.SINGLE,
        imagePrompt:
          !isCarousel && typeof visual?.imagePrompt === 'string'
            ? String(visual.imagePrompt).trim().slice(0, 1500)
            : undefined,
        slides: isCarousel ? slides : undefined,
        aiScore,
        aiReasoning,
        performancePrediction,
      },
    };
  }

  // Legacy flat shape: { jobId, status, content: { title, content, postType, slides, ... } }
  const contentRaw = root.content as Record<string, unknown> | undefined;
  if (!contentRaw || typeof contentRaw !== 'object') {
    // Topics workflow shape support:
    // Accept payloads where n8n returns topics list instead of content object.
    const topicsRaw =
      (Array.isArray(root.topics) ? root.topics : undefined) ||
      (Array.isArray((root.data as any)?.topics) ? (root.data as any).topics : undefined) ||
      (Array.isArray((root.output as any)?.topics) ? (root.output as any).topics : undefined);

    if (Array.isArray(topicsRaw) && topicsRaw.length > 0) {
      const topicLines = topicsRaw
        .slice(0, 12)
        .map((topic: any, idx: number) => {
          if (typeof topic === 'string') {
            return `${idx + 1}. ${topic.trim()}`;
          }
          const title = String(topic?.title || topic?.topic || topic?.name || '').trim();
          const reason = String(topic?.reason || topic?.why || '').trim();
          if (title && reason) return `${idx + 1}. ${title} — ${reason}`;
          if (title) return `${idx + 1}. ${title}`;
          return `${idx + 1}. Topic idea`;
        })
        .join('\n');

      const synthesizedContent = `Here are current viral topic ideas:\n\n${topicLines}`.slice(
        0,
        5000,
      );

      return {
        jobId,
        status: 'success',
        content: {
          title: 'Viral Topic Ideas',
          content: synthesizedContent,
          hashtags: [],
          performancePrediction: {
            source: 'n8n-topics',
            topics: topicsRaw.slice(0, 12),
          },
        },
      };
    }

    throw new Error('Invalid n8n callback: content or topics[] is required on success');
  }

  const title = String(contentRaw.title ?? '')
    .trim()
    .slice(0, 180);
  const content = String(contentRaw.content ?? '')
    .trim()
    .slice(0, 5000);
  const flatSlides = contentRaw.slides as
    | Array<Record<string, unknown>>
    | undefined;
  const nestedVisual = contentRaw.visual as Record<string, unknown> | undefined;
  const nestedSlides = nestedVisual?.carouselSlides as
    | Array<Record<string, unknown>>
    | undefined;

  let slides: SlidePayload[] | undefined;

  if (Array.isArray(flatSlides) && flatSlides.length > 0) {
    slides = flatSlides.map((s) => ({
      headline: String(s.headline ?? '')
        .trim()
        .slice(0, 200),
      body: String(s.body ?? '')
        .trim()
        .slice(0, 500),
      imagePrompt: String(s.imagePrompt ?? '')
        .trim()
        .slice(0, 1500),
    }));
  } else if (Array.isArray(nestedSlides) && nestedSlides.length > 0) {
    slides = nestedSlides.map((s) => ({
      headline: String(s.headline ?? '')
        .trim()
        .slice(0, 200),
      body: String(s.body ?? '')
        .trim()
        .slice(0, 500),
      imagePrompt: String(s.imagePrompt ?? '')
        .trim()
        .slice(0, 1500),
    }));
  }

  let postType = contentRaw.postType as MediaPostType | undefined;
  if (!postType && slides && slides.length >= 2) {
    postType = MediaPostType.CAROUSEL;
  }

  const extraPerf = contentRaw.performancePrediction as
    | Record<string, unknown>
    | undefined;
  const performancePrediction: Record<string, unknown> | undefined =
    extraPerf ||
    (slides && postType === MediaPostType.CAROUSEL
      ? { source: 'n8n', slides }
      : undefined);

  return {
    jobId,
    status: 'success',
    content: {
      title,
      content,
      hashtags: contentRaw.hashtags as string[] | undefined,
      postType,
      imagePrompt:
        typeof contentRaw.imagePrompt === 'string'
          ? contentRaw.imagePrompt
          : undefined,
      slides,
      visualUrl:
        typeof contentRaw.visualUrl === 'string'
          ? contentRaw.visualUrl
          : undefined,
      carouselUrls: contentRaw.carouselUrls as string[] | undefined,
      aiScore:
        typeof contentRaw.aiScore === 'number' ? contentRaw.aiScore : undefined,
      aiReasoning:
        typeof contentRaw.aiReasoning === 'string'
          ? contentRaw.aiReasoning
          : undefined,
      performancePrediction,
    },
  };
}
