import type { BrandProfile } from '../services/brand-profiles.service';
import type { BrandVisualContext } from '../services/media-generation.service';

const SEP = '═'.repeat(72);

export function isLlmGenerationDebugEnabled(): boolean {
  const raw = process.env.AI_GENERATION_DEBUG?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return process.env.NODE_ENV !== 'production';
}

function maxDebugChars(): number | null {
  const n = parseInt(process.env.AI_GENERATION_DEBUG_MAX_CHARS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clip(text: string, label: string): string {
  const max = maxDebugChars();
  if (!max || text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n… [${label} truncated: ${text.length} chars total, showing first ${max}; set AI_GENERATION_DEBUG_MAX_CHARS=0 or omit for full dump]`
  );
}

function banner(title: string): void {
  console.log(`\n${SEP}\n  TRNDINN LLM DEBUG · ${title}\n${SEP}`);
}

function subsection(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}

export function debugLogBrandKitLoaded(
  brand: BrandProfile,
  contextBlock: string,
  mode: 'full' | 'vocabulary_only' = 'full',
): void {
  if (!isLlmGenerationDebugEnabled()) return;

  if (mode === 'vocabulary_only') {
    banner('Brand kit → text LLM (vocabulary only — toggle OFF)');
    console.log(
      JSON.stringify(
        {
          includeBrandKit: false,
          do_use: brand.do_use,
          do_not_use: brand.do_not_use,
        },
        null,
        2,
      ),
    );
  } else {
    banner('Brand kit → text LLM (full — system prompt block)');
    console.log(JSON.stringify(brandKitSnapshot(brand), null, 2));
  }

  if (contextBlock.trim()) {
    subsection('Injected context block (exact text appended to system prompt)');
    console.log(clip(contextBlock, 'brand context block'));
  } else {
    subsection('Injected context block');
    console.log('(empty — no vocabulary rules configured)');
  }
}

export function debugLogCustomTopicPrompts(opts: {
  platform: string;
  contentType: string;
  textModel: string;
  hasWebResearch: boolean;
  webResearchMeta?: {
    query: string;
    sourceCount: number;
    isResearchIntent: boolean;
    responseTimeMs: number;
  };
  researchBlock?: string;
  system: string;
  user: string;
}): void {
  if (!isLlmGenerationDebugEnabled()) return;

  banner('Custom topic → text LLM (full prompts)');
  console.log(
    JSON.stringify(
      {
        platform: opts.platform,
        contentType: opts.contentType,
        textModel: opts.textModel,
        webResearch: opts.hasWebResearch
          ? (opts.webResearchMeta ?? { note: 'block present' })
          : null,
        systemChars: opts.system.length,
        userChars: opts.user.length,
      },
      null,
      2,
    ),
  );

  if (opts.researchBlock) {
    subsection('Web research block (system)');
    console.log(clip(opts.researchBlock, 'research block'));
  }

  subsection(`System prompt (${opts.system.length} chars)`);
  console.log(clip(opts.system, 'system prompt'));

  subsection(`User prompt (${opts.user.length} chars)`);
  console.log(clip(opts.user, 'user prompt'));
}

export function debugLogGatewayTextCall(opts: {
  maxTokens: number;
  model?: string;
  userId?: string;
  system: string;
  user: string;
}): void {
  if (!isLlmGenerationDebugEnabled()) return;

  banner('Gateway text call (about to send)');
  console.log(
    JSON.stringify(
      {
        maxTokens: opts.maxTokens,
        model: opts.model ?? '(registry primary + fallback)',
        userId: opts.userId,
        systemChars: opts.system.length,
        userChars: opts.user.length,
      },
      null,
      2,
    ),
  );

  subsection(`System (${opts.system.length} chars)`);
  console.log(clip(opts.system, 'system'));

  subsection(`User (${opts.user.length} chars)`);
  console.log(clip(opts.user, 'user'));
}

export function debugLogGatewayTextResponse(opts: {
  model: string;
  durationMs: number;
  contentPreview?: string;
}): void {
  if (!isLlmGenerationDebugEnabled()) return;

  banner('Gateway text response');
  console.log(
    JSON.stringify(
      {
        model: opts.model,
        durationMs: opts.durationMs,
        contentChars: opts.contentPreview?.length ?? 0,
      },
      null,
      2,
    ),
  );
  if (opts.contentPreview) {
    subsection('Raw content (first pass before JSON extract)');
    console.log(clip(opts.contentPreview, 'raw content'));
  }
}

export function debugLogBrandVisualForImage(opts: {
  jobLabel?: string;
  brandVisual?: BrandVisualContext;
  scenePrompt: string;
  optimizedPrompt: string;
  size?: string;
  quality?: string;
}): void {
  if (!isLlmGenerationDebugEnabled()) return;

  banner(`Image generation${opts.jobLabel ? ` · ${opts.jobLabel}` : ''}`);
  console.log(
    JSON.stringify(
      {
        size: opts.size,
        quality: opts.quality,
        brandVisual: opts.brandVisual ?? null,
        scenePromptChars: opts.scenePrompt.length,
        optimizedPromptChars: opts.optimizedPrompt.length,
      },
      null,
      2,
    ),
  );

  subsection('Scene prompt (from LLM imagePrompts)');
  console.log(clip(opts.scenePrompt, 'scene prompt'));

  subsection('Final prompt sent to image model');
  console.log(clip(opts.optimizedPrompt, 'optimized prompt'));
}

function brandKitSnapshot(brand: BrandProfile) {
  const assets = (brand.assets ?? []).map((a, i) => ({
    index: i,
    kind: a.kind ?? null,
    label: a.label ?? null,
    url: a.url ?? null,
  }));

  return {
    id: brand.id,
    name: brand.name,
    logo_url: brand.logo_url,
    colors: {
      primary: brand.primary_color,
      secondary: brand.secondary_color,
      accent: brand.accent_color,
    },
    tone: brand.tone,
    target_audience: brand.target_audience,
    voice_examples: brand.voice_examples,
    do_use: brand.do_use,
    do_not_use: brand.do_not_use,
    additional_information: brand.additional_information,
    assets,
    metadata: brand.metadata,
  };
}

export function debugLogBrandKitSkipped(reason: string): void {
  if (!isLlmGenerationDebugEnabled()) return;
  banner('Brand kit');
  console.log(JSON.stringify({ loaded: false, reason }, null, 2));
}

/** Worker loaded brand profile → fields passed into each image call. */
export function debugLogWorkerBrandVisual(
  brandVisual: BrandVisualContext,
  userId: string,
): void {
  if (!isLlmGenerationDebugEnabled()) return;
  banner('Generation worker · brand visual for image pipeline');
  console.log(JSON.stringify({ userId, brandVisual }, null, 2));
}
