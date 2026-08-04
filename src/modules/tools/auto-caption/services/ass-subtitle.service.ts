/**
 * ASS Subtitle Service — Generates styled ASS subtitle files.
 *
 * Based on analysis of real viral caption implementations:
 * - nicolaigaina/ai-video-captions (Python/pysubs2)
 * - MakeAIClips (Deepgram + ASS + ffmpeg)
 *
 * TECHNIQUE: One ASS Dialogue event per word (for animated styles).
 * Each event contains the FULL LINE of text, but only the active word
 * is highlighted with a color override. This creates the word-by-word
 * highlight effect seen in Hormozi/Karaoke viral content.
 *
 * For static styles (MrBeast, Minimal): simple timed line groups.
 * For typewriter: character-by-character reveal via progressive text.
 * For bounce (Gradient Pop): each word pops in with scale animation.
 *
 * Font sizes are calibrated for 1080x1920 vertical video (PlayResY=1920).
 * Real implementations use 75-120px fonts at this resolution.
 *
 * Lightweight: pure string generation, no external deps.
 */

import { Injectable, Logger } from '@nestjs/common';

import { CaptionStyleId, CaptionStyleConfig, CaptionCustomization, WordTiming } from '../types';

// ─── Animation Types ─────────────────────────────────────────────────────────

/**
 * - "highlight": One event per word, full line visible, active word gets color swap
 * - "karaoke": Same but active word uses \kf sweep (progressive fill left-to-right)
 * - "static": Simple timed lines, no per-word animation (MrBeast, Minimal)
 * - "typewriter": Character-by-character reveal within each line
 * - "bounce": Each word pops in with scale-up animation (Gradient Pop)
 */
type AnimationType = 'highlight' | 'karaoke' | 'static' | 'typewriter' | 'bounce';

// ─── Style Preset Interface ──────────────────────────────────────────────────

interface StylePreset {
  id: CaptionStyleId;
  fontFamily: string;
  fontSize: number; // At PlayResY 1920
  primaryColor: string; // ASS &H00BBGGRR& — default text color
  highlightColor: string; // ASS &H00BBGGRR& — active word color (for highlight/karaoke)
  outlineColor: string;
  outlineWidth: number;
  shadowDepth: number;
  bold: boolean;
  uppercase: boolean;
  animation: AnimationType;
  /** Max characters per line (determines word grouping) */
  maxCharsPerLine: number;
}

// ─── Style Presets (calibrated for 1080x1920 vertical video) ─────────────────

const STYLE_PRESETS: Record<CaptionStyleId, StylePreset> = {
  /**
   * HORMOZI — Bold, ALL CAPS, word-by-word yellow highlight
   * Full sentence visible in WHITE, one word at a time turns YELLOW.
   * Heavy black outline for readability on any background.
   */
  hormozi: {
    id: 'hormozi',
    fontFamily: 'DejaVu Sans',
    fontSize: 100,
    primaryColor: '&H00FFFFFF&', // white (base text)
    highlightColor: '&H0000FFFF&', // yellow (#FFFF00 -> BGR 00FFFF)
    outlineColor: '&H00000000&', // black
    outlineWidth: 5,
    shadowDepth: 0,
    bold: true,
    uppercase: true,
    animation: 'highlight',
    maxCharsPerLine: 14,
  },
  /**
   * MRBEAST — Chunky white + colored stroke, mixed case
   * Static lines (no per-word animation). The visual punch comes from
   * the THICK pink/magenta outline on white bold text.
   * Lines appear/disappear as timed groups.
   */
  mrbeast: {
    id: 'mrbeast',
    fontFamily: 'DejaVu Sans',
    fontSize: 110,
    primaryColor: '&H00FFFFFF&', // white text
    highlightColor: '&H008C1EE9&', // unused (static style)
    outlineColor: '&H008C1EE9&', // pink/magenta OUTLINE (#E91E8C -> BGR)
    outlineWidth: 7,
    shadowDepth: 0,
    bold: true,
    uppercase: false,
    animation: 'static',
    maxCharsPerLine: 12,
  },
  /**
   * MINIMAL — Clean light-weight, soft shadow, bottom-third
   * Static lines, NO animation. Thin font, subtle shadow.
   * The elegance is in its simplicity.
   */
  minimal: {
    id: 'minimal',
    fontFamily: 'DejaVu Sans',
    fontSize: 80,
    primaryColor: '&H00FFFFFF&', // white
    highlightColor: '&H00FFFFFF&', // unused (static)
    outlineColor: '&H00000000&', // black (very thin)
    outlineWidth: 1,
    shadowDepth: 2,
    bold: false,
    uppercase: false,
    animation: 'static',
    maxCharsPerLine: 20,
  },
  /**
   * KARAOKE — Full line visible, active word in color
   * Full sentence shows in GRAY (dimmed), the currently-spoken word
   * turns ORANGE with a smooth sweep (\kf fill from left to right).
   */
  karaoke: {
    id: 'karaoke',
    fontFamily: 'DejaVu Sans',
    fontSize: 95,
    primaryColor: '&H00888888&', // gray (dimmed inactive words)
    highlightColor: '&H000080FF&', // orange (#FF8000 -> BGR 0080FF)
    outlineColor: '&H00000000&', // black
    outlineWidth: 3,
    shadowDepth: 0,
    bold: true,
    uppercase: false,
    animation: 'karaoke',
    maxCharsPerLine: 16,
  },
  /**
   * TYPEWRITER — Monospace, letter-by-letter reveal
   * Characters appear progressively. Green monospace text on black outline.
   * Each character appears at a constant rate across the word's duration.
   */
  typewriter: {
    id: 'typewriter',
    fontFamily: 'DejaVu Sans Mono',
    fontSize: 75,
    primaryColor: '&H0000FF88&', // green (#88FF00 -> BGR 00FF88)
    highlightColor: '&H0000FF88&', // same
    outlineColor: '&H00000000&', // black
    outlineWidth: 3,
    shadowDepth: 0,
    bold: false,
    uppercase: false,
    animation: 'typewriter',
    maxCharsPerLine: 16,
  },
  /**
   * GRADIENT POP — Bold text, bounce & scale pop
   * Each word POPS IN with a scale animation (0% -> 120% -> 100%).
   * Alternating orange/pink colors per word. Uppercase, high energy.
   */
  'gradient-pop': {
    id: 'gradient-pop',
    fontFamily: 'DejaVu Sans',
    fontSize: 105,
    primaryColor: '&H004895F9&', // orange (#F99548 -> BGR 4895F9)
    highlightColor: '&H00B469FF&', // pink (#FF69B4 -> BGR B469FF)
    outlineColor: '&H00000000&', // black
    outlineWidth: 5,
    shadowDepth: 0,
    bold: true,
    uppercase: true,
    animation: 'bounce',
    maxCharsPerLine: 12,
  },
};

/** User position/size overrides that get written into the ASS file */
export interface AssUserOverrides {
  fontSize?: number; // User slider value (12-36) — will be SCALED to ASS units
  marginV?: number; // Pixels from bottom (at video resolution)
  alignment?: 1 | 2 | 3; // ASS: 1=left, 2=center, 3=right
}

@Injectable()
export class AssSubtitleService {
  private readonly logger = new Logger(AssSubtitleService.name);

  /**
   * Generate a complete ASS subtitle file from word timings.
   */
  generate(
    words: WordTiming[],
    styleId: CaptionStyleId,
    videoWidth: number,
    videoHeight: number,
    customization?: CaptionCustomization,
    overrides?: AssUserOverrides,
  ): string {
    const style = { ...STYLE_PRESETS[styleId] };

    // Apply customizations
    if (customization?.primaryColor) {
      style.primaryColor = this.hexToAss(customization.primaryColor);
    }
    if (customization?.highlightColor) {
      style.highlightColor = this.hexToAss(customization.highlightColor);
    }

    // Scale font size relative to video height (presets are for 1920px)
    const dimensionScale = Math.max(videoHeight / 1920, 0.35);

    // User fontSize override: scale from slider range (12-36) to ASS units
    // Slider 12 = 50% of base, slider 24 = 100% of base, slider 36 = 150% of base
    let finalFontSize = Math.round(style.fontSize * dimensionScale);
    if (overrides?.fontSize != null) {
      const userScale = 0.5 + (overrides.fontSize - 12) / 24; // 12->0.5, 24->1.0, 36->1.5
      finalFontSize = Math.round(style.fontSize * dimensionScale * userScale);
    }

    const header = this.buildHeader(style, videoWidth, videoHeight, finalFontSize, overrides);
    const events = this.buildEvents(words, style, videoHeight, finalFontSize);

    this.logger.log(`ASS generated: style=${styleId}, fontSize=${finalFontSize}, words=${words.length}, animation=${style.animation}`);

    return `${header}\n\n${events}`;
  }

  getStylePreset(styleId: CaptionStyleId): StylePreset {
    return { ...STYLE_PRESETS[styleId] };
  }

  // ─── Private: Header ───────────────────────────────────────────────────────

  private buildHeader(
    style: StylePreset,
    w: number,
    h: number,
    fontSize: number,
    overrides?: AssUserOverrides,
  ): string {
    // Alignment: user override > default bottom-center
    const alignment = overrides?.alignment ?? 2;

    // MarginV: user override > default 10% from bottom
    const marginV = overrides?.marginV ?? Math.round(h * 0.10);

    return `[Script Info]
Title: Trndinn Auto Caption
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 3
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${fontSize},${style.primaryColor},${style.primaryColor},${style.outlineColor},&H80000000&,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outlineWidth},${style.shadowDepth},${alignment},40,40,${marginV},1`;
  }

  // ─── Private: Events ───────────────────────────────────────────────────────

  private buildEvents(words: WordTiming[], style: StylePreset, videoHeight: number, fontSize: number): string {
    const lines: string[] = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];

    // Group words into display lines based on max chars
    const groups = this.groupWordsByChars(words, style.maxCharsPerLine, style.uppercase);

    for (const group of groups) {
      if (group.length === 0) continue;

      switch (style.animation) {
        case 'highlight':
          lines.push(...this.buildHighlightEvents(group, style));
          break;
        case 'karaoke':
          lines.push(...this.buildKaraokeEvents(group, style));
          break;
        case 'static':
          lines.push(...this.buildStaticEvents(group, style));
          break;
        case 'typewriter':
          lines.push(...this.buildTypewriterEvents(group, style));
          break;
        case 'bounce':
          lines.push(...this.buildBounceEvents(group, style));
          break;
      }
    }

    return lines.join('\n');
  }

  // ─── HIGHLIGHT: Full line visible, one word colored at a time ──────────────

  /**
   * Hormozi style: One event per word. Full line always visible.
   * Active word gets {\c<highlight>}WORD{\r}, others show in default color.
   */
  private buildHighlightEvents(group: WordTiming[], style: StylePreset): string[] {
    const events: string[] = [];
    const lineEnd = group[group.length - 1].end;

    for (let idx = 0; idx < group.length; idx++) {
      const wordStart = group[idx].start;
      const wordEnd = idx < group.length - 1 ? group[idx + 1].start : lineEnd;

      const start = this.formatTime(wordStart);
      const end = this.formatTime(wordEnd);

      // Build full line with only active word highlighted
      const parts: string[] = [];
      for (let i = 0; i < group.length; i++) {
        const word = style.uppercase ? group[i].word.toUpperCase() : group[i].word;
        const escaped = this.escapeAssText(word);

        if (i === idx) {
          parts.push(`{\\c${style.highlightColor}}${escaped}{\\r}`);
        } else {
          parts.push(escaped);
        }
      }

      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${parts.join(' ')}`);
    }

    return events;
  }

  // ─── KARAOKE: Full line visible, active word gets \kf sweep fill ───────────

  /**
   * Karaoke style: One event per word. Full line always visible.
   * Active word gets {\kf<cs>\c<highlight>}WORD{\r} for smooth left-to-right fill.
   * Inactive words stay in the dim primaryColor.
   */
  private buildKaraokeEvents(group: WordTiming[], style: StylePreset): string[] {
    const events: string[] = [];
    const lineEnd = group[group.length - 1].end;

    for (let idx = 0; idx < group.length; idx++) {
      const wordStart = group[idx].start;
      const wordEnd = idx < group.length - 1 ? group[idx + 1].start : lineEnd;
      const durationCs = Math.max(1, Math.round((group[idx].end - group[idx].start) * 100));

      const start = this.formatTime(wordStart);
      const end = this.formatTime(wordEnd);

      // Build full line with active word having karaoke sweep
      const parts: string[] = [];
      for (let i = 0; i < group.length; i++) {
        const word = style.uppercase ? group[i].word.toUpperCase() : group[i].word;
        const escaped = this.escapeAssText(word);

        if (i === idx) {
          parts.push(`{\\kf${durationCs}\\c${style.highlightColor}}${escaped}{\\r}`);
        } else {
          parts.push(escaped);
        }
      }

      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${parts.join(' ')}`);
    }

    return events;
  }

  // ─── STATIC: Simple timed lines, no per-word animation ─────────────────────

  /**
   * MrBeast / Minimal: Lines appear and disappear as groups.
   * No per-word animation — the style itself (thick outline, shadow) is the effect.
   */
  private buildStaticEvents(group: WordTiming[], style: StylePreset): string[] {
    const start = this.formatTime(group[0].start);
    const end = this.formatTime(group[group.length - 1].end);

    const text = group
      .map((w) => this.escapeAssText(style.uppercase ? w.word.toUpperCase() : w.word))
      .join(' ');

    return [`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`];
  }

  // ─── TYPEWRITER: Character-by-character reveal ─────────────────────────────

  /**
   * Typewriter: Characters appear one at a time across the line duration.
   * Uses many short events, each showing one more character than the previous.
   * Only ONE event visible at any time (each ends when next begins).
   */
  private buildTypewriterEvents(group: WordTiming[], style: StylePreset): string[] {
    const events: string[] = [];
    const lineStart = group[0].start;
    const lineEnd = group[group.length - 1].end;
    const lineDuration = lineEnd - lineStart;

    // Build the full line text
    const fullText = group
      .map((w) => this.escapeAssText(style.uppercase ? w.word.toUpperCase() : w.word))
      .join(' ');

    const totalChars = fullText.length;
    if (totalChars === 0) return [];

    // Time per character
    const charDuration = lineDuration / totalChars;

    // Generate one event per character reveal (batch every 2 chars for performance)
    const step = Math.max(1, Math.min(2, Math.floor(totalChars / 20)));

    for (let i = step; i <= totalChars; i += step) {
      const charStart = lineStart + (i - step) * charDuration;
      const charEnd = i < totalChars ? lineStart + i * charDuration : lineEnd;

      const start = this.formatTime(charStart);
      const end = this.formatTime(charEnd);

      const visibleText = fullText.substring(0, i);
      const cursor = i < totalChars ? '_' : '';

      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${visibleText}${cursor}`);
    }

    // Ensure the full text is shown at the end
    if (events.length > 0) {
      const lastCharEnd = lineStart + Math.floor(totalChars / step) * step * charDuration;
      if (lastCharEnd < lineEnd) {
        const start = this.formatTime(lastCharEnd);
        const end = this.formatTime(lineEnd);
        events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${fullText}`);
      }
    }

    return events;
  }

  // ─── BOUNCE: Each word pops in with scale animation ────────────────────────

  /**
   * Gradient Pop: Each word pops in with a spring scale effect.
   * Uses \t (transition) to animate from 0% to 120% then back to 100%.
   * Words accumulate — once popped in, they stay visible until line ends.
   * Colors alternate between primaryColor and highlightColor per word.
   */
  private buildBounceEvents(group: WordTiming[], style: StylePreset): string[] {
    const events: string[] = [];
    const lineEnd = group[group.length - 1].end;

    for (let idx = 0; idx < group.length; idx++) {
      const wordStart = group[idx].start;
      const wordEnd = idx < group.length - 1 ? group[idx + 1].start : lineEnd;

      const start = this.formatTime(wordStart);
      const end = this.formatTime(lineEnd); // Word stays visible until line ends

      // Build text: all words up to current index visible, current word has bounce
      const parts: string[] = [];
      for (let i = 0; i <= idx; i++) {
        const word = style.uppercase ? group[i].word.toUpperCase() : group[i].word;
        const escaped = this.escapeAssText(word);

        // Alternate colors per word
        const color = i % 2 === 0 ? style.primaryColor : style.highlightColor;

        if (i === idx) {
          // Current word: bounce in (scale 0 -> 120 -> 100) over 200ms
          parts.push(`{\\fscx0\\fscy0\\t(0,100,\\fscx130\\fscy130)\\t(100,200,\\fscx100\\fscy100)\\c${color}}${escaped}{\\r}`);
        } else {
          // Previous words: static, already visible
          parts.push(`{\\c${color}}${escaped}{\\r}`);
        }
      }

      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${parts.join(' ')}`);
    }

    return events;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Group words into lines based on character count (not word count).
   * At 100px font on 1080px width: ~14 chars per line for bold, ~20 for light.
   */
  private groupWordsByChars(words: WordTiming[], maxCharsPerLine: number, uppercase: boolean): WordTiming[][] {
    const groups: WordTiming[][] = [];
    let currentGroup: WordTiming[] = [];
    let currentChars = 0;

    for (const word of words) {
      const wordText = uppercase ? word.word.toUpperCase() : word.word;
      const wordLen = wordText.length;

      // If adding this word exceeds max chars, start a new group
      if (currentGroup.length > 0 && (currentChars + 1 + wordLen) > maxCharsPerLine) {
        groups.push(currentGroup);
        currentGroup = [word];
        currentChars = wordLen;
      } else {
        currentGroup.push(word);
        currentChars += (currentGroup.length > 1 ? 1 : 0) + wordLen;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  /** Escape ASS special characters in word text */
  private escapeAssText(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}');
  }

  /** Convert #RRGGBB hex to ASS &H00BBGGRR& format */
  private hexToAss(hex: string): string {
    const clean = hex.replace('#', '');
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    return `&H00${b}${g}${r}&`.toUpperCase();
  }
}
