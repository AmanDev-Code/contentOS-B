export interface PlatformOverrides {
  linkedin?: string;
  instagram?: string;
  x?: string;
}

export interface TonalityGuide {
  voice: string;
  rhythm: string;
  formatting: string;
  emoji: string;
  platformOverrides: PlatformOverrides;
}

export const TONALITY_GUIDES: Record<string, TonalityGuide> = {
  professional: {
    voice:
      'Authoritative, data-backed, measured. Speak with confidence and credibility. Use precise language; avoid slang and hyperbole.',
    rhythm:
      'Mix short declarative sentences with medium-length ones. Open with a strong claim or insight. Close with a clear takeaway.',
    formatting:
      'Use bullets for lists of 3+ items. Keep paragraphs to 2-3 sentences max. Use line breaks generously for readability.',
    emoji:
      'Sparingly — at most 1 emoji per post, never in the opening line. Prefer unicode arrows (→) or checkmarks (✓) over emojis.',
    platformOverrides: {
      linkedin:
        'Lead with a hook question or bold statement. Never gush. End with a question or CTA to drive comments. Use "I" sparingly — prefer "we" or third-person framing for credibility.',
      instagram:
        'Keep the professional tone but soften slightly. Add 1-2 relevant emojis in the body. Hashtag block at the end.',
      x: 'Extremely concise. Lead with the sharpest insight. No filler words. Thread only if truly necessary.',
    },
  },

  casual_friendly: {
    voice:
      'Warm, approachable, conversational. Write like talking to a smart friend over coffee. Use contractions freely.',
    rhythm:
      'Vary sentence length naturally. Start with something relatable or a mini-story. Use rhetorical questions to engage.',
    formatting:
      'Flowing paragraphs preferred over bullets unless listing tips. Keep it breezy — short paragraphs, natural breaks.',
    emoji:
      '2-4 emojis throughout the post. Use them to add warmth, not to replace words. Never stack emojis.',
    platformOverrides: {
      linkedin:
        'Stay warm but not too informal — no internet slang. Use first-person storytelling. End with a question to the audience.',
      instagram:
        'Lean into the friendly vibe. Emojis at paragraph starts work well. Hashtag block at the end. Use line breaks via blank lines.',
      x: 'Quick, punchy, fun. Use 1-2 emojis max. Feel like a real person sharing a hot take or tip.',
    },
  },

  trendy: {
    voice:
      'Current, culturally aware, meme-literate. Reference trends, pop culture, or viral moments when relevant. Edgy but not offensive.',
    rhythm:
      'Short punchy bursts. Fragment sentences are OK. Build to a punchline or unexpected twist. Hook in the first 5 words.',
    formatting:
      'Single-line paragraphs. Use ALL CAPS for 1-2 words max for emphasis. Avoid traditional bullet lists — use stacked single lines instead.',
    emoji:
      '3-5 emojis, used strategically for tone and pacing. Can open with an emoji. Use trending/relevant emojis, not generic smileys.',
    platformOverrides: {
      linkedin:
        'Trendy on LinkedIn means fresh perspectives on business topics — not memes. Use a pattern interrupt opening. Keep it smart-trendy, not Gen-Z-trendy.',
      instagram:
        'Full trendy mode. Pop culture references welcome. Visual language (emojis, line breaks) matters. Hashtags should include trending ones.',
      x: 'Maximum trend energy. Reference current events or viral moments. Hot takes welcome. Keep it under 280 chars.',
    },
  },

  storytelling: {
    voice:
      'Narrative, immersive, emotionally resonant. Paint scenes with vivid details. Use sensory language. Build tension and payoff.',
    rhythm:
      'Open in media res or with a surprising detail. Build through rising action. Short sentence for impact at the climax. Wrap with a reflection or lesson.',
    formatting:
      'Flowing prose — no bullets. Line breaks for dramatic pacing. Each paragraph advances the narrative. Never break the story flow with lists.',
    emoji:
      '0-2 emojis max. Only if they genuinely enhance the emotional beat. Never let emojis interrupt narrative flow.',
    platformOverrides: {
      linkedin:
        'Business storytelling — tie the narrative to a professional lesson. Open with a moment, not a thesis. End with the takeaway, framed as a reflection.',
      instagram:
        'Sensory and emotional storytelling. Paint the scene. Use line breaks for pacing. Caption should make them feel something before the CTA.',
      x: 'Micro-storytelling. One vivid scene or moment. Punchline landing. Thread for longer stories — each tweet must stand alone.',
    },
  },

  bold_punchy: {
    voice:
      'Confident, direct, unapologetic. Strong opinions stated clearly. No hedging. Short sentences that hit hard.',
    rhythm:
      'Staccato rhythm. Punch. Breathe. Punch again. Open with the boldest claim. Close with a mic-drop line or challenge.',
    formatting:
      'Single-line paragraphs. One idea per line. Bullets only for rapid-fire lists. Use whitespace aggressively.',
    emoji:
      '1-3 emojis, used for emphasis not decoration. Fire (🔥), pointing (👉), or stop (🛑) work well. No cute emojis.',
    platformOverrides: {
      linkedin:
        'Bold but respectful — strong opinions backed by experience. Controversial takes are OK if substantive. Avoid clickbait energy.',
      instagram:
        'High-energy captions. Each line a punch. Use emojis as bullet markers (🔥, ⚡, 💡). CTA should be direct.',
      x: 'Maximum impact in minimum words. Lead with the hottest take. No preamble. No "I think" — just state it.',
    },
  },

  educational: {
    voice:
      'Clear, structured, helpful. Expert explaining to a curious learner. Use analogies and examples. Define jargon when used.',
    rhythm:
      'Hook with a common misconception or surprising fact. Build understanding step by step. Close with a practical takeaway.',
    formatting:
      'Bullets and numbered lists are encouraged for steps/tips. Use headers or bold markers for sections in longer posts. Structure aids learning.',
    emoji:
      '1-3 emojis for section markers (📌, 💡, ✅). Never decorative. Use them to signal "tip", "key point", or "warning".',
    platformOverrides: {
      linkedin:
        'Framework-style posts work well. "5 things I learned about X" format. End with "Save this for later" or "Which one resonated?"',
      instagram:
        'Carousel-friendly content even in single posts. Numbered tips with emoji markers. Clear, scannable structure. Hashtag block at end.',
      x: 'One golden nugget per tweet. If threading, number each tip. End with "RT if this helped" or similar engagement hook.',
    },
  },

  inspirational: {
    voice:
      'Uplifting, motivating, authentic. Share genuine wins, lessons from failure, or perspectives that shift mindset. Avoid toxic positivity — keep it real.',
    rhythm:
      'Build from struggle/challenge to insight/triumph. Use contrast (then vs. now, fear vs. action). End on an empowering note.',
    formatting:
      'Flowing paragraphs with strategic line breaks for emphasis. Key phrases on their own lines. Avoid bullets — this is about feeling, not listing.',
    emoji:
      '1-3 emojis at emotional peaks. Stars (✨), muscle (💪), or heart (❤️). Never overload — the words should carry the weight.',
    platformOverrides: {
      linkedin:
        'Ground inspiration in professional context. Real stories > generic quotes. Vulnerability about failures works well. End with encouragement to the reader.',
      instagram:
        'Lean into the visual + caption synergy. Caption should build emotion. Use line breaks for emphasis. End with a community-building CTA.',
      x: 'One powerful line. Or a before/after contrast. Keep it punchy and quotable. Thread for the full story if needed.',
    },
  },
};

export function getTonalityGuide(tonality: string): TonalityGuide {
  const guide = TONALITY_GUIDES[tonality];
  if (!guide) {
    return TONALITY_GUIDES.professional;
  }
  return guide;
}

export function buildTonalityFragment(
  guide: TonalityGuide,
  platform: string,
): string {
  const override =
    guide.platformOverrides[platform as keyof PlatformOverrides] || '';

  const lines = [
    `VOICE: ${guide.voice}`,
    `SENTENCE RHYTHM: ${guide.rhythm}`,
    `FORMATTING: ${guide.formatting}`,
    `EMOJI POLICY: ${guide.emoji}`,
  ];

  if (override) {
    lines.push(`PLATFORM-SPECIFIC (${platform.toUpperCase()}): ${override}`);
  }

  return lines.join('\n');
}
