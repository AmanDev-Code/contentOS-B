/**
 * PromptBuilderService — Assembles LLM prompts for bio generation + scoring.
 *
 * Pattern adopted from BioLoom (zhenxiao-yu/ai-bio-generator) and Postiz:
 * platform + tone + focus + type configs feed a builder that emits a
 * system + user message pair. The model returns strict JSON we parse into
 * typed variations.
 *
 * A BIO IS NOT A POST. This is the single most important rule we enforce
 * against the LLM. The output must read like the person's answer to
 * "tell me about yourself" — an identity statement in first person that
 * lives on a profile page — NOT a LinkedIn post, personal essay, or
 * announcement. The prompts below aggressively suppress narrative openings,
 * storytelling drift, and post-like structure that horizontal AI writers
 * default to.
 */

import { Injectable } from '@nestjs/common';

import {
  BIO_PLATFORMS,
  BUZZWORDS,
  BioPlatform,
  BioTone,
  LINKEDIN_RECRUITER_HINTS,
  PLATFORM_LIMITS,
  TONE_GUIDANCE,
} from '../config';
import type { BioGenerateInput, BioScoreInput } from '../types';

@Injectable()
export class PromptBuilderService {
  /** Build the system + user messages for a per-platform bio generation. */
  buildGeneratePrompt(input: BioGenerateInput, platform: BioPlatform): {
    system: string;
    user: string;
  } {
    const limits = PLATFORM_LIMITS[platform];
    const tone = TONE_GUIDANCE[input.tone];
    const variations = input.variations ?? 3;
    const emojis = input.emojis === true;
    const bioType = input.bioType ?? 'personal';

    const platformRules = this.rulesForPlatform(platform);
    const targetChars = this.targetLengthFor(platform, input.length);
    const focus = this.focusGuidance(input.focusAreas);

    // The system prompt is written in the second person and locked hard.
    // Every line here suppresses a specific way LLMs turn "write me a bio"
    // into "write me a LinkedIn post" — which is what was happening before.
    const system = [
      `You are a specialist ${limits.label} bio writer.`,
      `A BIO is a short first-person profile statement people read on your ${limits.label} profile — NOT a post, not an essay, not an announcement, not a story with a hook.`,
      '',
      `WHAT A BIO IS:`,
      `- First-person identity ("I'm a…", "Building…", "Helping…") describing WHO you are + WHAT you do.`,
      `- Static, evergreen text a stranger reads on your profile to decide if they should follow / DM / hire you.`,
      `- Answers: "Tell me about yourself in ${limits.maxChars} chars or less."`,
      '',
      `WHAT A BIO IS NOT (AVOID THESE — they were the top failure modes in prior versions):`,
      `- ❌ NOT a LinkedIn post. No "So I've been thinking…", no "Yesterday I realized…", no time-anchored narrative.`,
      `- ❌ NOT a personal essay. No storytelling arc about a specific moment ("The first time a bug I wrote froze someone's paycheck…").`,
      `- ❌ NOT an announcement. No "Excited to share…", no "Thrilled to announce…".`,
      `- ❌ NOT a cover letter. No "I'm passionate about…", no résumé-summary tone.`,
      `- ❌ NOT third person (unless bioType=brand or platform=general/speaker context).`,
      `- ❌ NOT a wall of paragraphs. Bios are dense; posts are prose.`,
      '',
      `BIO TYPE: ${bioType === 'brand' ? 'Brand voice — may use "we" or the brand name. Focus on what the brand does, who it serves, its edge.' : 'Personal voice — first person "I". Focus on the individual\'s role, expertise, and current work.'}`,
      '',
      `PLATFORM RULES (${limits.label}):`,
      platformRules,
      '',
      `TONE: ${tone}`,
      focus ? `\nFOCUS AREAS (weight these dimensions in every draft):\n${focus}` : '',
      '',
      `HARD CONSTRAINTS:`,
      `- Each bio MUST be between ${Math.floor(targetChars * 0.55)} and ${limits.maxChars} characters. Count characters, not words.`,
      `- Target ~${targetChars} characters; the platform's own limit is ${limits.maxChars}.`,
      `- NEVER exceed ${limits.maxChars} chars — hard platform limit.`,
      `- Return VALID JSON ONLY. No prose before or after. No markdown fences.`,
      `- Emojis: ${emojis ? 'ALLOWED tastefully (1-4 per bio, as bullet markers or accents, never mid-sentence).' : 'DO NOT USE any emojis or unicode symbols. Keep it typographic.'}`,
      `- Anti-buzzword — NEVER use these phrases: ${BUZZWORDS.join(', ')}.`,
      `- No time markers ("today", "this week", "recently", "just", "excited to announce"). Bios are evergreen.`,
      `- No dependent clauses that reference an unseen prior sentence. Every bio must stand alone.`,
      '',
      `EACH VARIATION MUST BE A DISTINCT ANGLE (three bios, three different ways to describe the SAME person):`,
      `- Variation 1 — CREDIBILITY angle: lead with the identity marker most likely to earn trust (title, company, years of experience, ex-employer, credential).`,
      `- Variation 2 — OUTCOME angle: lead with concrete results, numbers, or what you help others achieve. Format: "I help X do Y, resulting in Z" or "$Xm ARR grown, N teams hired, K customers shipped."`,
      `- Variation 3 — POSITIONING angle: lead with what makes you different or what you believe. Format: "The [role] who thinks [contrarian view]" or "Building [thing] because [conviction]."`,
      variations >= 4 ? `- Variation 4 — DIRECTION angle: lead with what you're building or where you're going next (present continuous).` : '',
      '',
      `STRICT OUTPUT SHAPE — return exactly this JSON:`,
      `{`,
      `  "bios": [`,
      `    { "text": "<the bio itself, first person, evergreen, no preamble>", "angle": "credibility" },`,
      `    { "text": "<...>", "angle": "outcome" },`,
      `    { "text": "<...>", "angle": "positioning" }`,
      `  ]`,
      `}`,
    ]
      .filter(Boolean)
      .join('\n');

    // User prompt is data-only. All instructions live in the system prompt.
    const userLines: string[] = [];
    userLines.push(`ABOUT ME: ${input.role}`);
    if (input.facts?.trim()) userLines.push(`FACTS (weave in naturally, don't list them): ${input.facts}`);
    if (input.goal?.trim()) userLines.push(`WHAT I WANT FROM THIS BIO: ${input.goal}`);
    if (input.audience?.trim()) userLines.push(`WHO READS THIS BIO: ${input.audience}`);
    userLines.push('');
    userLines.push(
      `Write ${variations} distinct bios for ${limits.label}. Return strict JSON, no other output. Remember: this is a PROFILE BIO, not a post.`,
    );

    return { system, user: userLines.join('\n') };
  }

  /** Build the scoring prompt — dimensional 0-20 rubric + 3 tips. */
  buildScorePrompt(input: BioScoreInput): { system: string; user: string } {
    const limits = PLATFORM_LIMITS[input.platform];
    const system = [
      `You are a bio quality auditor for ${limits.label}.`,
      `Score the given bio on 5 dimensions, each 0-20. Return strict JSON.`,
      '',
      `DIMENSIONS (0-20 each):`,
      `- hook: Does the opening line grab attention? Would a scroller stop?`,
      `- clarity: Is it immediately clear WHO the person is and WHAT they do?`,
      `- platformFit: Does it read like a ${limits.label} BIO (not a post)? Fits ${limits.maxChars} chars, first ${limits.softFold} visible?`,
      `- impact: Are there specific outcomes / proof / numbers, or just adjectives?`,
      `- originality: Does it stand out, or read like every other ${limits.label} bio?`,
      '',
      `PENALIZE:`,
      `- Reads like a post/essay/announcement instead of a bio → drop clarity + platformFit.`,
      `- Uses buzzwords ("passionate about", "results-driven") → drop originality.`,
      `- Time-anchored language ("recently", "just launched") → drop platformFit.`,
      '',
      `Return exactly this JSON shape:`,
      `{`,
      `  "hook": 0-20,`,
      `  "clarity": 0-20,`,
      `  "platformFit": 0-20,`,
      `  "impact": 0-20,`,
      `  "originality": 0-20,`,
      `  "tips": ["<specific rewrite fix 1>", "<specific rewrite fix 2>", "<specific rewrite fix 3>"]`,
      `}`,
      '',
      `Tips must be SPECIFIC rewrite suggestions (not generic advice like "be more concise").`,
    ].join('\n');

    const userLines = [`BIO (${input.text.length} chars): ${input.text}`];
    if (input.goal?.trim()) userLines.push(`GOAL CONTEXT: ${input.goal}`);
    userLines.push('', 'Score now.');

    return { system, user: userLines.join('\n') };
  }

  /** Platform-specific rules block — this is the encoded domain expertise. */
  private rulesForPlatform(platform: BioPlatform): string {
    const limits = PLATFORM_LIMITS[platform];
    const base = `- Max ${limits.maxChars} chars. First ${limits.softFold} chars visible before "…more" on ${limits.label}.`;

    switch (platform) {
      case 'linkedin':
        return [
          base,
          `- This is the LinkedIn About section — a profile summary, NOT a post. Write in the voice of "here's who I am and what I do", not "here's a story I want to share".`,
          `- FRONT-LOAD: the first 210 chars MUST work as a standalone bio hook — desktop truncates there and mobile shows even less.`,
          `- The first sentence should answer "who is this person?" in one clause. Example: "Senior product designer at a healthcare SaaS, ex-Notion." NOT: "The first time I sketched a wireframe was in 2015…" (that's a post opener, not a bio opener).`,
          `- Include discovery keywords LinkedIn's recruiter Boolean search rewards, woven in naturally:`,
          ...LINKEDIN_RECRUITER_HINTS.map((h) => `  · ${h}`),
          `- Structure a full About like a résumé narrative in dense prose blocks, NOT storytelling:`,
          `  1) Identity line (who I am, one sentence, keyword-loaded)`,
          `  2) What I do now (2-3 lines: current role, scope, stack/domain)`,
          `  3) Proof block (2-4 lines: named outcomes with numbers, not vague verbs)`,
          `  4) Direction / invitation (1-2 lines: what I'm open to, DM CTA)`,
          `- Line breaks are fine between blocks. But no paragraph-length narrative digressions.`,
          `- No hashtags in the About section — LinkedIn doesn't rank on them there.`,
          `- Avoid the "hero's journey" trap: "I started at X → I learned Y → now I do Z" reads as a post, not a bio. Compress the arc into one identity line if it matters.`,
        ].join('\n');

      case 'instagram':
        return [
          base,
          `- Instagram bio field — 150 chars, sits under the profile pic. Users scan it in 2 seconds.`,
          `- Structure (works for 90% of niches):`,
          `  Line 1: What you do / who you are (with keyword)`,
          `  Line 2: Who you serve or what makes you different`,
          `  Line 3: A call — "DM to work with me", "New posts every Tuesday", or a note about the link`,
          `- Emoji as bullet markers is a native pattern (only if emojis allowed).`,
          `- No URLs in the bio text — Instagram only clicks the link slot. Reference it as "link below" or "↓".`,
          `- Personal handles + hashtags are fine but they cost chars.`,
        ].join('\n');

      case 'twitter':
        return [
          base,
          `- Twitter/X bio — 160 chars, brutal budget. Every word carries weight, no filler.`,
          `- Native format that works: "[Identity] · [what you post about] · [personality note or handle]".`,
          `- Example structure: "Senior engineer @stripe · writing about distributed systems · reply guy on ledger design"`,
          `- @-mentions of a company handle count against the char limit but signal affiliation.`,
          `- No time markers. Bios stay live for years.`,
        ].join('\n');

      case 'tiktok':
        return [
          base,
          `- TikTok bio — 80 chars, this is a TAGLINE, not a bio.`,
          `- Optimize for the "why should I follow?" answer in a single glance.`,
          `- Format that works: "[Who I am] making [content type] for [audience]" or "[Value prop in one clause]".`,
          `- No URLs, no @s (they don't render as links).`,
        ].join('\n');

      case 'github':
        return [
          base,
          `- GitHub profile bio — 160 chars. Audience is developers; they smell marketing fluff instantly.`,
          `- Format: "[Role]. [Stack/domain]. [What I build / write / maintain]."`,
          `- Concrete tools/languages beat abstract skills every time. "Rust, distributed systems, WASM" > "backend engineer passionate about performance".`,
          `- Mention open-source work if relevant. Handle-mentions (@org) render as links.`,
        ].join('\n');

      case 'youtube':
        return [
          base,
          `- YouTube channel description — 1,000 chars, first 100 visible on the channel page before "MORE".`,
          `- Front-load channel value prop in the first 100 chars: "I make [content type] about [topic] for [audience]. New videos every [cadence]."`,
          `- Body should cover: upload cadence, content pillars, audience, credentials, and where else to find you (other socials, newsletter).`,
          `- Not a résumé — describe the channel from the viewer's perspective ("what you'll get if you subscribe"), not yours.`,
        ].join('\n');

      case 'general':
        return [
          base,
          `- Cross-platform / speaker / author bio — 300 chars, works on conference pages, book jackets, PR sheets.`,
          `- Third person is acceptable here and often preferred for speaker/author use.`,
          `- Structure: "[Full name] is a [role] at [company/context]. [One line of context or proof]. [What they're known for or writing about]."`,
          `- No platform-specific handles or hashtags.`,
        ].join('\n');
    }
  }

  /** Focus areas prompt block — weights the AI toward specific dimensions. */
  private focusGuidance(focus?: string[]): string | null {
    if (!focus || focus.length === 0) return null;
    const map: Record<string, string> = {
      achievements: '- ACHIEVEMENTS: lead with concrete wins, quantified outcomes, named brands worked with.',
      skills:       '- SKILLS: name specific tools, languages, frameworks, methodologies (not soft skills).',
      personality:  '- PERSONALITY: show voice, humor, or a small personal detail that humanizes the bio.',
      mission:      '- MISSION: state what you\'re trying to change or why the work matters to you.',
      creativity:   '- CREATIVITY: use unexpected phrasing, a memorable metaphor, or a signature line — but keep it evergreen.',
      leadership:   '- LEADERSHIP: emphasize team size led, cross-functional scope, or org-level outcomes.',
      credibility:  '- CREDIBILITY: front-load titles, tenure, ex-employers, credentials, or press mentions.',
      contrarian:   '- CONTRARIAN: name a widely held belief in your field you disagree with.',
    };
    return focus
      .map((f) => map[f.toLowerCase()] ?? `- ${f.toUpperCase()}: weight this dimension prominently.`)
      .join('\n');
  }

  /** Map user's length hint to a target char count for the platform. */
  private targetLengthFor(platform: BioPlatform, length?: 'short' | 'medium' | 'long'): number {
    const { maxChars, softFold } = PLATFORM_LIMITS[platform];
    if (length === 'short') return Math.max(60, Math.min(softFold, Math.round(maxChars * 0.35)));
    if (length === 'long') return Math.round(maxChars * 0.9);
    // medium (default): 60% of max, capped by softFold * 3 for readable density
    return Math.min(Math.round(maxChars * 0.6), softFold * 3);
  }

  /** Utility exposed for the service — enum of platforms we support. */
  static readonly SUPPORTED_PLATFORMS = BIO_PLATFORMS;
}
