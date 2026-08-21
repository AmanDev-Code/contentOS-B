/**
 * PromptBuilderService — Assembles LLM prompts for bio generation + scoring.
 *
 * Design principles (v2 — takes focus areas + emojis SERIOUSLY):
 *
 * 1. FOCUS AREAS ARE HARD DIRECTIVES, NOT DECORATION.
 *    Every focus area the user picked must show up in every bio. If they
 *    pick "credibility + skills + achievements", each variation must lead
 *    with a credibility marker AND name specific skills AND cite a concrete
 *    achievement. The prompt now enumerates the required signals per bio
 *    and repeats them in the closing checklist.
 *
 * 2. EMOJIS ARE PLATFORM-AWARE.
 *    "Add emojis: true" behaves differently per platform because native
 *    conventions differ. Instagram/TikTok emojis-as-bullets is a native
 *    idiom; LinkedIn/GitHub/General use them sparingly as accents; Twitter
 *    is a budget game where 1-2 emojis carry semantic weight.
 *
 * 3. A BIO IS NOT A POST — retained load-bearing enforcement from v1.
 *    LLMs regress to essay/announcement structure the moment the prompt
 *    lets them. Keep the ❌ examples aggressive.
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

/**
 * Fixed angle catalogue — v1 shipped 3 angles, some code paths (variations >= 4)
 * unlocked a 4th. Keep the same enum so downstream parsing / admin analytics
 * dimensions stay stable.
 */
const ANGLES = ['credibility', 'outcome', 'positioning', 'direction'] as const;

/**
 * Emoji policy per platform when the user toggles emojis ON.
 * These are guidance strings baked into the system prompt so the LLM emits
 * emojis in the platform-native way instead of sprinkling them arbitrarily.
 */
const EMOJI_ON: Record<BioPlatform, string> = {
  linkedin:
    'Use emojis SPARINGLY — max 2 per bio, and only as section-break accents (e.g. ▸ before a proof line, or one topical emoji at end of the direction block). No mid-sentence emojis; no "💼 Senior…" resume-emoji clichés.',
  instagram:
    'Emojis-as-bullets is native. Prefix each of the 3 lines with a distinct topical emoji (skill emoji ▸ audience emoji ▸ CTA emoji). No emoji clusters (❌ 🎨✨🚀).',
  twitter:
    'Every char counts. Use exactly 1–2 emojis, and only if they replace a word (⚡ instead of "fast", 🇮🇳 instead of "based in India"). Never decorative.',
  tiktok:
    'One emoji, one purpose — as the opener OR the closer, never both. Kids/creator audience: current-trending emoji beats safe corporate ones.',
  github:
    'Developer audience — treat emojis as flags, not decoration. Max 1: a country flag, a stack indicator (🦀 for Rust, 🐍 for Python), or ✨/⚡ for a personality note. No 🚀🔥💻 chains.',
  youtube:
    'Front-load ONE emoji in the first 100 chars (visible before "MORE"). Body may use 2–3 more as pillar markers (▶ ▸ →). No emoji rows.',
  general:
    'Speaker/author bios rarely use emojis. Max 1, and only if it disambiguates identity (national flag, credential icon). Otherwise omit — third-person prose reads more credibly without them.',
};

/**
 * Emoji policy per platform when the user toggles emojis OFF.
 * We are strict: no unicode symbols at all. Some LLMs sneak in bullets,
 * arrows, or "•" — we forbid those too when emojis:false, since a bio
 * with no emojis should feel intentionally typographic, not accidentally so.
 */
const EMOJI_OFF =
  'NO emojis, NO unicode decoration (no •, ▸, →, ✓, ★, arrows, hearts, flags). Only ASCII punctuation. Use "|" or " · " as separators if you need one, or plain line breaks.';

/**
 * Focus-area directives.
 * Each area is a REQUIRED signal — if the user picks it, every variation
 * must satisfy it. That's why these read like commands, not suggestions.
 */
const FOCUS_DIRECTIVES: Record<string, string> = {
  credibility:
    'MUST include at least one credibility signal per bio: a specific title, current employer, ex-employer, tenure ("8 years", "since 2017"), credential (PhD, YC W25, ICF PCC), or press mention. Vague like "experienced" is a fail — name the thing.',
  achievements:
    'MUST cite at least one concrete outcome with a number or named result per bio: "grew ARR to $8M", "shipped 40+ playbooks", "50K IG followers", "featured in Vogue Africa". If the user didn\'t give a number, extract one from their facts. Never leave outcomes abstract.',
  skills:
    'MUST name at least 2 specific tools / languages / frameworks / methodologies per bio (Python, TypeScript, Figma, distributed systems, GTM). Soft skills ("communication", "leadership") DO NOT count — those are personality traits, not skills for this focus.',
  personality:
    'MUST include exactly one line or clause that shows voice — a small personal detail, an admission, a hobby, a signature phrase, a self-aware joke. Not a résumé sentence. Keeps the bio from reading corporate.',
  mission:
    'MUST include a "why" clause per bio: what change the person is trying to make, who they serve and why it matters, or the belief that drives the work. Format: "Building X because Y." or "Helping X do Y so that Z."',
  creativity:
    'MUST use one unexpected phrase, metaphor, or signature line per bio. Not clichés ("thinks outside the box"). Something that a stranger would remember and quote back. Still evergreen.',
  leadership:
    'MUST reference org-level scope per bio: team size led ("leads a team of 6"), cross-functional reach ("across product, eng, ops"), or org-wide outcomes ("moved company NPS from 30 → 60"). Individual-contributor language fails this focus.',
  contrarian:
    'MUST include one clause where the person names a widely held belief in their field and disagrees with it. Format: "the [role] who thinks [contrarian view]" or "believes X while everyone else builds Y". Should feel earned, not edgy for its own sake.',
};

/**
 * Angle definitions — what each variation must DO, and how focus areas
 * combine with the angle. The v1 prompt described angles once at the top;
 * v2 attaches focus signals to each angle so the LLM can't drift.
 */
function angleDirective(angle: (typeof ANGLES)[number]): string {
  switch (angle) {
    case 'credibility':
      return [
        'Variation 1 — CREDIBILITY angle',
        'Lead with the strongest trust signal. Title, current employer, ex-employer, credential, or years of experience — pick the one that would make a stranger stop scrolling and trust this person.',
        'Opening pattern: "[Role] at [Company], ex-[Recognized brand]." or "[Credential]. [Current role]."',
      ].join('\n  ');
    case 'outcome':
      return [
        'Variation 2 — OUTCOME angle',
        'Lead with what this person has DONE for others, in numbers. Result first, role second.',
        'Opening pattern: "$XM ARR grown, N teams hired, K products shipped." or "I help [audience] do [outcome], resulting in [metric]."',
        'If the user gave you no numbers, use their facts to construct one (e.g. "3 peer-reviewed papers" from academic input).',
      ].join('\n  ');
    case 'positioning':
      return [
        'Variation 3 — POSITIONING angle',
        'Lead with what makes this person DIFFERENT from other people with the same title. A contrarian view, a signature approach, or a niche they own.',
        'Opening pattern: "The [role] who thinks [uncommon view]." or "Building [thing] because [conviction]."',
      ].join('\n  ');
    case 'direction':
      return [
        'Variation 4 — DIRECTION angle',
        'Lead with what this person is BUILDING or where they are HEADED next. Present continuous.',
        'Opening pattern: "Building [thing] for [audience]." or "Currently helping [audience] with [problem]."',
      ].join('\n  ');
  }
}

@Injectable()
export class PromptBuilderService {
  /** Build the system + user messages for a per-platform bio generation. */
  buildGeneratePrompt(input: BioGenerateInput, platform: BioPlatform): {
    system: string;
    user: string;
  } {
    const limits = PLATFORM_LIMITS[platform];
    const tone = TONE_GUIDANCE[input.tone];
    const variations = Math.max(1, Math.min(4, input.variations ?? 3));
    const emojisOn = input.emojis === true;
    const bioType = input.bioType ?? 'personal';
    const chosenAngles = ANGLES.slice(0, variations);

    const platformRules = this.rulesForPlatform(platform);
    const targetChars = this.targetLengthFor(platform, input.length);
    const focusList = this.normalizeFocus(input.focusAreas);
    const focusBlock = this.focusBlock(focusList);

    const emojiPolicy = emojisOn ? EMOJI_ON[platform] : EMOJI_OFF;

    // Per-angle directive + injected focus reminder — this is the load-bearing
    // change vs v1. Each variation now knows exactly which focus signals it
    // must satisfy in addition to its angle.
    const angleSections = chosenAngles
      .map((angle) => {
        const base = angleDirective(angle);
        const focusReminder =
          focusList.length > 0
            ? `\n  Focus signals required in this variation: ${focusList
                .map((f) => f.toUpperCase())
                .join(', ')}.`
            : '';
        return `- ${base}${focusReminder}`;
      })
      .join('\n');

    const jsonShape = [
      '{',
      '  "bios": [',
      ...chosenAngles.map((angle, i) => {
        const comma = i < chosenAngles.length - 1 ? ',' : '';
        return `    { "text": "<${angle} bio, first person, evergreen, no preamble>", "angle": "${angle}" }${comma}`;
      }),
      '  ]',
      '}',
    ].join('\n');

    const system = [
      `You are a specialist ${limits.label} bio writer.`,
      `A BIO is a short first-person profile statement people read on your ${limits.label} profile — NOT a post, not an essay, not an announcement, not a story with a hook.`,
      '',
      'WHAT A BIO IS:',
      '- First-person identity ("I\'m a…", "Building…", "Helping…") describing WHO you are + WHAT you do.',
      '- Static, evergreen text a stranger reads on your profile to decide if they should follow / DM / hire you.',
      `- Answers: "Tell me about yourself in ${limits.maxChars} chars or less."`,
      '',
      'WHAT A BIO IS NOT (top LLM failure modes — avoid all of these):',
      '- ❌ NOT a LinkedIn post. No "So I\'ve been thinking…", no "Yesterday I realized…", no time-anchored narrative.',
      '- ❌ NOT a personal essay. No storytelling arc about a specific moment.',
      '- ❌ NOT an announcement. No "Excited to share…", no "Thrilled to announce…".',
      '- ❌ NOT a cover letter. No "I\'m passionate about…", no résumé-summary tone.',
      '- ❌ NOT third person (unless bioType=brand or platform=general).',
      '- ❌ NOT a wall of paragraphs. Bios are dense; posts are prose.',
      '',
      `BIO TYPE: ${
        bioType === 'brand'
          ? 'Brand voice — may use "we" or the brand name. Focus on what the brand does, who it serves, its edge.'
          : platform === 'general'
          ? 'Personal, third person acceptable for speaker/author use. Focus on identity and one line of proof.'
          : 'Personal voice — first person "I". Focus on the individual\'s role, expertise, and current work.'
      }`,
      '',
      `PLATFORM RULES (${limits.label}):`,
      platformRules,
      '',
      `TONE: ${tone}`,
      focusBlock,
      '',
      'HARD CONSTRAINTS:',
      `- Each bio MUST be between ${Math.floor(targetChars * 0.55)} and ${limits.maxChars} characters. Count characters, not words.`,
      `- Target ~${targetChars} characters; the platform's own limit is ${limits.maxChars}.`,
      `- NEVER exceed ${limits.maxChars} chars — hard platform limit.`,
      `- EMOJI POLICY: ${emojiPolicy}`,
      `- Anti-buzzword — NEVER use these phrases: ${BUZZWORDS.join(', ')}.`,
      '- No time markers ("today", "this week", "recently", "just", "excited to announce"). Bios are evergreen.',
      '- No dependent clauses that reference an unseen prior sentence. Every bio must stand alone.',
      '- Return VALID JSON ONLY. No prose before or after. No markdown fences.',
      '',
      'EACH VARIATION IS A DIFFERENT ANGLE ON THE SAME PERSON:',
      angleSections,
      '',
      'FINAL CHECKLIST BEFORE YOU RETURN — walk through each bio:',
      '  1. Does it read like a BIO (profile statement) or a POST (narrative)? If a post, rewrite.',
      focusList.length > 0
        ? `  2. Does every bio satisfy ALL focus signals (${focusList
            .map((f) => f.toUpperCase())
            .join(', ')})? If not, rewrite that variation.`
        : '  2. Does each variation lean into its assigned angle distinctly? If two read the same, rewrite the weaker one.',
      '  3. Is each bio within the char budget and would it read cleanly on a profile page?',
      emojisOn
        ? '  4. Are emojis used per the platform policy (not sprinkled decoratively)? Trim any that fail the policy.'
        : '  4. Confirm ZERO emojis or unicode decoration. Remove any that slipped in.',
      '  5. Any buzzwords from the block-list? Rewrite that line.',
      '',
      'STRICT OUTPUT SHAPE — return exactly this JSON:',
      jsonShape,
    ]
      .filter(Boolean)
      .join('\n');

    // User prompt is data-only. All instructions live in the system prompt.
    const userLines: string[] = [];
    userLines.push(`ABOUT ME: ${input.role}`);
    if (input.facts?.trim()) userLines.push(`FACTS (weave in naturally, don't list them): ${input.facts}`);
    if (input.goal?.trim()) userLines.push(`WHAT I WANT FROM THIS BIO: ${input.goal}`);
    if (input.audience?.trim()) userLines.push(`WHO READS THIS BIO: ${input.audience}`);
    if (focusList.length > 0) userLines.push(`FOCUS AREAS SELECTED: ${focusList.join(', ')}`);
    userLines.push(`EMOJIS: ${emojisOn ? 'ON (follow platform policy above)' : 'OFF (zero emojis, zero unicode decoration)'}`);
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
      'Score the given bio on 5 dimensions, each 0-20. Return strict JSON.',
      '',
      'DIMENSIONS (0-20 each):',
      '- hook: Does the opening line grab attention? Would a scroller stop?',
      '- clarity: Is it immediately clear WHO the person is and WHAT they do?',
      `- platformFit: Does it read like a ${limits.label} BIO (not a post)? Fits ${limits.maxChars} chars, first ${limits.softFold} visible?`,
      '- impact: Are there specific outcomes / proof / numbers, or just adjectives?',
      `- originality: Does it stand out, or read like every other ${limits.label} bio?`,
      '',
      'PENALIZE:',
      '- Reads like a post/essay/announcement instead of a bio → drop clarity + platformFit.',
      '- Uses buzzwords ("passionate about", "results-driven") → drop originality.',
      '- Time-anchored language ("recently", "just launched") → drop platformFit.',
      '',
      'Return exactly this JSON shape:',
      '{',
      '  "hook": 0-20,',
      '  "clarity": 0-20,',
      '  "platformFit": 0-20,',
      '  "impact": 0-20,',
      '  "originality": 0-20,',
      '  "tips": ["<specific rewrite fix 1>", "<specific rewrite fix 2>", "<specific rewrite fix 3>"]',
      '}',
      '',
      'Tips must be SPECIFIC rewrite suggestions (not generic advice like "be more concise").',
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
          '- This is the LinkedIn About section — a profile summary, NOT a post. Write in the voice of "here\'s who I am and what I do", not "here\'s a story I want to share".',
          '- FRONT-LOAD: the first 210 chars MUST work as a standalone bio hook — desktop truncates there and mobile shows even less.',
          '- The first sentence should answer "who is this person?" in one clause. Example: "Senior product designer at a healthcare SaaS, ex-Notion." NOT: "The first time I sketched a wireframe was in 2015…"',
          '- Include discovery keywords LinkedIn\'s recruiter Boolean search rewards, woven in naturally:',
          ...LINKEDIN_RECRUITER_HINTS.map((h) => `  · ${h}`),
          '- Structure a full About like a résumé narrative in dense prose blocks, NOT storytelling:',
          '  1) Identity line (who I am, one sentence, keyword-loaded)',
          '  2) What I do now (2-3 lines: current role, scope, stack/domain)',
          '  3) Proof block (2-4 lines: named outcomes with numbers, not vague verbs)',
          '  4) Direction / invitation (1-2 lines: what I\'m open to, DM CTA)',
          '- Line breaks are fine between blocks. But no paragraph-length narrative digressions.',
          '- No hashtags in the About section — LinkedIn doesn\'t rank on them there.',
        ].join('\n');

      case 'instagram':
        return [
          base,
          '- Instagram bio field — 150 chars, sits under the profile pic. Users scan it in 2 seconds.',
          '- Structure (works for 90% of niches):',
          '  Line 1: What you do / who you are (with keyword)',
          '  Line 2: Who you serve or what makes you different',
          '  Line 3: A call — "DM to work with me", "New posts every Tuesday", or a note about the link',
          '- No URLs in the bio text — Instagram only clicks the link slot. Reference it as "link below" or "↓".',
        ].join('\n');

      case 'twitter':
        return [
          base,
          '- Twitter/X bio — 160 chars, brutal budget. Every word carries weight, no filler.',
          '- Native format that works: "[Identity] · [what you post about] · [personality note or handle]".',
          '- Example structure: "Senior engineer @stripe · writing about distributed systems · reply guy on ledger design"',
          '- @-mentions of a company handle count against the char limit but signal affiliation.',
          '- No time markers. Bios stay live for years.',
        ].join('\n');

      case 'tiktok':
        return [
          base,
          '- TikTok bio — 80 chars, this is a TAGLINE, not a bio.',
          '- Optimize for the "why should I follow?" answer in a single glance.',
          '- Format that works: "[Who I am] making [content type] for [audience]" or "[Value prop in one clause]".',
          '- No URLs, no @s (they don\'t render as links).',
        ].join('\n');

      case 'github':
        return [
          base,
          '- GitHub profile bio — 160 chars. Audience is developers; they smell marketing fluff instantly.',
          '- Format: "[Role]. [Stack/domain]. [What I build / write / maintain]."',
          '- Concrete tools/languages beat abstract skills every time. "Rust, distributed systems, WASM" > "backend engineer passionate about performance".',
          '- Mention open-source work if relevant. Handle-mentions (@org) render as links.',
        ].join('\n');

      case 'youtube':
        return [
          base,
          '- YouTube channel description — 1,000 chars, first 100 visible on the channel page before "MORE".',
          '- Front-load channel value prop in the first 100 chars: "I make [content type] about [topic] for [audience]. New videos every [cadence]."',
          '- Body should cover: upload cadence, content pillars, audience, credentials, and where else to find you (other socials, newsletter).',
          '- Not a résumé — describe the channel from the viewer\'s perspective ("what you\'ll get if you subscribe"), not yours.',
        ].join('\n');

      case 'general':
        return [
          base,
          '- Cross-platform / speaker / author bio — 300 chars, works on conference pages, book jackets, PR sheets.',
          '- Third person is acceptable here and often preferred for speaker/author use.',
          '- Structure: "[Full name] is a [role] at [company/context]. [One line of context or proof]. [What they\'re known for or writing about]."',
          '- No platform-specific handles or hashtags.',
        ].join('\n');
    }
  }

  /**
   * Normalize the user's focus-area picks. Trims, lowercases, drops unknowns
   * so we don't inject garbage into the prompt.
   */
  private normalizeFocus(focus?: string[]): string[] {
    if (!focus || focus.length === 0) return [];
    const seen = new Set<string>();
    for (const f of focus) {
      const k = f.trim().toLowerCase();
      if (k && FOCUS_DIRECTIVES[k]) seen.add(k);
    }
    return Array.from(seen).slice(0, 3);
  }

  /**
   * Full FOCUS section — enumerates each selected focus as a required signal
   * with a concrete "MUST include …" directive. This is where "take focus
   * areas seriously" lives; the LLM can't ignore a directive it just read.
   */
  private focusBlock(focusList: string[]): string {
    if (focusList.length === 0) return '';
    const lines = focusList.map((f) => FOCUS_DIRECTIVES[f]).filter(Boolean);
    return [
      '',
      `FOCUS AREAS (REQUIRED signals — every variation must satisfy ALL of these, not just one):`,
      ...lines.map((l) => `- ${l}`),
    ].join('\n');
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
