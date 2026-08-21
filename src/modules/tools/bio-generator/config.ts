/**
 * Bio Generator config — platform limits, tones, rate limits, Redis keys.
 * Single source of truth shared by controller + service + prompt builder.
 */

export const BIO_GENERATOR_REDIS = {
  IP_COUNT: 'bio-gen:ip-count',
} as const;

export const BIO_PLATFORMS = [
  'linkedin',
  'instagram',
  'twitter',
  'tiktok',
  'github',
  'youtube',
  'general',
] as const;

export type BioPlatform = (typeof BIO_PLATFORMS)[number];

/**
 * Per-platform character limits.
 * Sources:
 *  - LinkedIn: 2,600 (About) — front-loaded first 210 chars visible desktop.
 *  - Instagram: 150 (profile bio).
 *  - Twitter/X: 160.
 *  - TikTok: 80.
 *  - GitHub: 160 (profile bio).
 *  - YouTube: 1,000 (channel description). Front-loaded first 100 chars visible.
 *  - General: 300 (safe default across platforms).
 */
export const PLATFORM_LIMITS: Record<BioPlatform, {
  maxChars: number;
  softFold: number;      // Front-loaded visible cut
  label: string;
}> = {
  linkedin:  { maxChars: 2600, softFold: 210, label: 'LinkedIn'  },
  instagram: { maxChars: 150,  softFold: 150, label: 'Instagram' },
  twitter:   { maxChars: 160,  softFold: 160, label: 'Twitter'   },
  tiktok:    { maxChars: 80,   softFold: 80,  label: 'TikTok'    },
  github:    { maxChars: 160,  softFold: 160, label: 'GitHub'    },
  youtube:   { maxChars: 1000, softFold: 100, label: 'YouTube'   },
  general:   { maxChars: 300,  softFold: 300, label: 'General'   },
};

export const BIO_TONES = [
  'professional',
  'casual',
  'creative',
  'witty',
  'authoritative',
  'storytelling',
  'inspirational',
  'friendly',
  'sarcastic',
  'confident',
  'humble',
  'humorous',
] as const;

export type BioTone = (typeof BIO_TONES)[number];

export const TONE_GUIDANCE: Record<BioTone, string> = {
  professional:   'Formal but approachable. Focus on credentials, expertise, and results. No slang.',
  casual:         'Conversational, friendly, first-person. Contractions okay. Feels like a human wrote it.',
  creative:       'Playful language, unexpected metaphors, sensory detail. Break rules gently.',
  witty:          'Clever, dry humor, a touch of self-aware. One good punchline, not a comedy set.',
  authoritative:  'Direct, confident, data-first. Lead with credibility markers and specific numbers.',
  storytelling:   'Narrative arc: where you started → what you learned → what you do now. Human beats a résumé.',
  inspirational:  'Uplifting, purpose-driven, aspirational language. Avoid buzzwords like "passionate" or "synergy".',
  friendly:       'Warm, welcoming, second-person cues ("let\'s connect"). Feels like an introduction at a meetup.',
  sarcastic:      'Ironic, self-aware, punches up. Use sparingly — one dig, not a rant.',
  confident:      'Bold claims backed by proof. No hedging words ("I try to", "kind of").',
  humble:         'Understated, credit-sharing, curiosity-forward. Downplay wins slightly for likability.',
  humorous:       'Funny, quotable, memorable. One-liner energy. Avoid inside jokes.',
};

/** Recruiter/discovery keywords LinkedIn's Boolean search rewards. Injected as guidance, not hard rules. */
export const LINKEDIN_RECRUITER_HINTS = [
  'role/title keyword (Senior Engineer, Product Marketing Manager, VP Sales)',
  'industry keyword (SaaS, fintech, healthcare, e-commerce)',
  'seniority indicator (10+ years, ex-Google, YC-backed)',
  'skill keywords (Python, React, GTM, LLM, growth loops)',
  'outcome keyword (scaled to $10M ARR, shipped 200+ features)',
] as const;

export const RATE_LIMITS = {
  /** Max generations per IP per hour. */
  maxPerIpPerHour: 15,
  /** TTL for the IP counter (seconds). */
  ttlSeconds: 3600,
} as const;

/** Anti-buzzword linter list. Trigger a warning on the output when any of these appear. */
export const BUZZWORDS = [
  'passionate about',
  'results-driven',
  'team player',
  'synergy',
  'go-getter',
  'thought leader',
  'ninja',
  'guru',
  'rockstar',
  'motivated',
  'detail-oriented',
  'hard-working',
  'self-starter',
  'strategic thinker',
  'out of the box',
  'hit the ground running',
] as const;
