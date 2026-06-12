import type { WebResearchResult } from './web-research.service';

/** User wants live data first, then a post built from findings — not a post about the instruction. */
const RESEARCH_INTENT_PATTERNS: RegExp[] = [
  /\b(find|search|look\s*up|lookup|fetch|get)\b.*\b(latest|recent|current|trending|news|updates?)\b/i,
  /\b(latest|recent|current|trending)\b.*\b(trends?|news|developments?|updates?)\b/i,
  /\b(create|write|make|generate|build)\b.*\b(post|content|caption|article)\b.*\b(around|about|based on|from)\b/i,
  /\b(research|web search|online search|google search|search the web|search online)\b/i,
  /\bwhat'?s trending\b/i,
  /\bbased on (live|real|current|recent) (data|info|information|research|web|internet)\b/i,
  /\bfind .+ and (create|write|make|generate)\b/i,
];

const META_VERB_STRIP =
  /\b(please|kindly|can you|could you|i want you to|help me)\b/gi;
const INSTRUCTION_TAIL =
  /\b(and then|then|,?\s*then)\s*(create|write|make|generate|build)\b[\s\S]*$/i;
const POST_INSTRUCTION =
  /\b(create|write|make|generate|build)\s+(a\s+)?(post|content|caption|article|linkedin post)\s+(around|about|based on|from)\s+(it|this|them|that|the results?|the findings?|the trends?)\b[\s\S]*$/i;
const AND_POST_INSTRUCTION =
  /\s+and\s+(create|write|make|generate|build)\b[\s\S]*$/i;

export interface ResearchPromptContext {
  /** True when the user asked to find/search trends or news first. */
  isResearchIntent: boolean;
  /** Query sent to Tavily (may differ from raw user topic). */
  searchQuery: string;
  /** Suggested Tavily topic category. */
  tavilyTopic: 'general' | 'news' | 'finance';
  /** Optional recency filter for trend/news queries. */
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

export function detectResearchIntent(topic: string): boolean {
  const cleaned = topic.trim();
  if (!cleaned) return false;
  return RESEARCH_INTENT_PATTERNS.some((p) => p.test(cleaned));
}

const INVALID_RESEARCH_SUBJECT =
  /^(it|this|that|them|the results?|the findings?|the trends?)$/i;

export function buildResearchPromptContext(
  topic: string,
  platform?: string,
): ResearchPromptContext {
  const cleaned = topic.trim().replace(/\s+/g, ' ');
  const isResearchIntent = detectResearchIntent(cleaned);
  const year = new Date().getFullYear();

  const subjectMatch = cleaned.match(
    /\b(?:in|on|about|regarding|for)\s+([^.!?,]+?)(?:\s+and\s+(?:create|write|make|generate)|[.!?]|$)/i,
  );
  const trendInSubjectMatch = cleaned.match(
    /\b(?:latest|recent|current|trending)\s+trends?\s+(?:in|on|about|for)\s+([^.!?,]+)/i,
  );

  let searchQuery = cleaned
    .replace(META_VERB_STRIP, '')
    .replace(INSTRUCTION_TAIL, '')
    .replace(AND_POST_INSTRUCTION, '')
    .replace(POST_INSTRUCTION, '')
    .replace(/\b(find|search|look up|lookup|fetch|get)\b/gi, '')
    .replace(/\b(the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const subjectFromMatch = subjectMatch?.[1]?.trim().replace(/\s+and\s*$/i, '');
  if (subjectFromMatch && !INVALID_RESEARCH_SUBJECT.test(subjectFromMatch)) {
    searchQuery = `latest ${subjectFromMatch} trends news ${year}`;
  } else if (trendInSubjectMatch?.[1]?.trim()) {
    const subject = trendInSubjectMatch[1]
      .trim()
      .replace(/\s+and\s+(create|write|make|generate).*$/i, '');
    if (!INVALID_RESEARCH_SUBJECT.test(subject)) {
      searchQuery = `latest ${subject} trends ${year}`;
    }
  }

  const genericTrendRequest =
    isResearchIntent &&
    (/^(latest|recent|current|trending)\s+trends?(\s+news)?(\s+\d{4})?$/i.test(
      searchQuery,
    ) ||
      /^(latest|recent|current|trending)(\s+(it|this|that|them))?$/i.test(
        searchQuery,
      ) ||
      /^trends?$/i.test(searchQuery));

  if (
    isResearchIntent &&
    (searchQuery.length < 8 ||
      INVALID_RESEARCH_SUBJECT.test(searchQuery) ||
      genericTrendRequest)
  ) {
    const platformHint =
      platform && platform !== 'general'
        ? `${platform} social media marketing`
        : 'social media marketing business';
    searchQuery = genericTrendRequest
      ? `latest ${platformHint} trends news ${year}`
      : (() => {
          const stripped = searchQuery
            .replace(/\b(it|this|that|them|around)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const strippedTooShort =
            stripped.length < 8 ||
            /^(latest|recent|current|trending)(\s+(it|this|that|them))?$/i.test(
              stripped,
            );
          return strippedTooShort
            ? `latest ${platformHint} trends news ${year}`
            : `latest ${stripped} trends news ${year}`;
        })();
  }

  if (searchQuery.length > 120) {
    searchQuery = searchQuery.slice(0, 120).replace(/\s\S*$/, '');
  }

  const wantsNews =
    isResearchIntent &&
    /\b(trend|trends|news|latest|recent|current|breaking|today|this week)\b/i.test(
      cleaned,
    );

  return {
    isResearchIntent,
    searchQuery: searchQuery || cleaned,
    tavilyTopic: wantsNews ? 'news' : 'general',
    timeRange: wantsNews ? 'week' : undefined,
  };
}

export function formatResearchSystemBlock(
  research: WebResearchResult,
  ctx: ResearchPromptContext,
  originalTopic: string,
): string {
  const lines: string[] = [];

  if (ctx.isResearchIntent) {
    lines.push(
      '--- LIVE WEB RESEARCH (PRIMARY TOPIC MATERIAL — write the post from THIS, not from the user instruction) ---',
      `The user asked you to research first, then write a post from the findings.`,
      `Do NOT write a post about "finding trends" or "creating content". Write about the ACTUAL trends, facts, events, and data discovered below.`,
      `User instruction (context only — NOT the post subject): "${originalTopic}"`,
      '',
    );
  } else {
    lines.push(
      '--- LIVE WEB RESEARCH (grounding context — use these facts to make the post authentic, current, and data-driven) ---',
      `User topic: "${originalTopic}"`,
      '',
    );
  }

  if (research.answer) {
    lines.push(`Research summary: ${research.answer}`);
    lines.push('');
  }

  lines.push('Sources & facts:');
  for (const src of research.sources.slice(0, 8)) {
    const datePart = src.publishedDate ? ` (${src.publishedDate})` : '';
    lines.push(`- [${src.title}](${src.url})${datePart}`);
    lines.push(`  ${src.snippet.slice(0, 350)}`);
  }

  lines.push('');
  lines.push(
    ctx.isResearchIntent
      ? 'Your post MUST be about the specific trends/topics/data in the research above. Use concrete names, numbers, and events from sources. Do NOT fabricate facts. Do NOT meta-comment on the research process.'
      : 'Use the above facts, statistics, names, and recent events to ground the post. Cite specific data points when relevant. Do NOT fabricate facts — only use what the research provides.',
  );

  return lines.join('\n');
}

export function buildResearchUserMessage(
  originalTopic: string,
  research: WebResearchResult,
  ctx: ResearchPromptContext,
): string {
  const derivedSubject =
    research.answer?.split(/[.!?]/)[0]?.trim().slice(0, 200) ||
    research.sources[0]?.title ||
    ctx.searchQuery;

  if (ctx.isResearchIntent) {
    return [
      `Write the post based on the LIVE WEB RESEARCH in the system prompt.`,
      `Primary subject (from research): ${derivedSubject}`,
      `Do NOT write about this instruction text — write about what was found online.`,
      `User's original request (for context only): "${originalTopic}"`,
    ].join('\n');
  }

  return [
    `Topic: ${originalTopic}`,
    `Ground the post in the LIVE WEB RESEARCH provided in the system prompt.`,
    `Primary angle from research: ${derivedSubject}`,
  ].join('\n');
}
