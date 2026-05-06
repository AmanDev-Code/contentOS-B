/**
 * Deterministic document-deck renderer used by the educational carousel presets:
 *
 *   - `handwritten_notes`     → notebook theme (ruled paper, blue/black/red ink, yellow highlights)
 *   - `structured_document`   → clean_document theme (white surface, dark navy accent, footer page #)
 *
 * Each slide renders from validated structured content (cover / TOC / body / outro) directly
 * to a 1080×1080 JPEG; we never call the OpenAI image API in this path. The output buffer is
 * uploaded to MinIO by the worker and assembled into the carousel PDF by the existing
 * `MediaGenerationService.createCarouselPdfFromImageUrls` helper.
 *
 * Pricing remains `2 + 2.5 × slideCount` (cover + TOC counted toward the user-selected slide
 * budget) — see `customTopicCreditCost` in pricing.
 */

import sharp from 'sharp';
import type {
  CarouselDocumentTheme,
  CarouselSlideOutput,
  TipBox,
  TocEntry,
} from './custom-topic.schemas';
import {
  renderDiagramSvgFragment,
  estimateDiagramHeight,
} from './diagram-renderer';

export const DOCUMENT_DECK_CANVAS = 1080;

export interface DocumentDeckMeta {
  coverTitle: string;
  coverSubtitle?: string;
  author?: string;
  /** Optional small mark printed in footers (clean theme) or top-left (notebook). */
  brand?: string;
}

export interface RenderDocumentSlideParams {
  slide: CarouselSlideOutput;
  pageNumber: number;
  totalPages: number;
  theme: CarouselDocumentTheme;
  meta: DocumentDeckMeta;
  /** Required when `slide.sectionType === 'toc'`. Ignored otherwise. */
  tocEntries?: TocEntry[];
}

/* ------------------------------------------------------------------------------------ */
/* Shared text + SVG helpers                                                            */
/* ------------------------------------------------------------------------------------ */

function escapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitize(str: string): string {
  return (
    String(str ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Word-wrap with average char width estimate; matches existing media-generation pipeline. */
function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const avgCharW = fontSize * 0.52;
  const maxChars = Math.max(8, Math.floor(maxWidth / avgCharW));
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (test.length > maxChars && current) {
      lines.push(current);
      current = w;
      if (lines.length >= maxLines) break;
    } else {
      current = test;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.length > 0) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars - 3) {
      lines[maxLines - 1] = last.slice(0, Math.max(0, maxChars - 3)) + '…';
    }
  }
  return lines;
}

function truncate(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Pick the best available code block for a slide. Prefers the rich `codeSnippet`
 * (object with language) over the legacy `codeSnippets[]` string array. Returns
 * null when no usable snippet exists.
 */
function pickCodeBlock(
  slide: CarouselSlideOutput,
): { language: string; code: string } | null {
  const rich = slide.codeSnippet;
  if (rich && typeof rich.code === 'string' && rich.code.trim().length >= 6) {
    return {
      language: (rich.language || 'text').trim() || 'text',
      code: rich.code,
    };
  }
  const legacy = (slide.codeSnippets || []).find(
    (c) => typeof c === 'string' && sanitize(c).length >= 8,
  );
  if (legacy) {
    return {
      language: 'code',
      code: legacy,
    };
  }
  return null;
}

/**
 * Expand a code snippet into render-ready lines. Honors explicit newlines first
 * (so multi-line snippets keep structure), then word-wraps long lines to the
 * available pixel width. Returns at most `maxLines` lines.
 */
function expandCodeLines(
  code: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  if (maxLines <= 0) return [];
  const text = String(code ?? '').replace(/\t/g, '  ');
  const physicalLines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const ln of physicalLines) {
    if (out.length >= maxLines) break;
    const trimmed = ln.replace(/\s+$/g, '');
    if (!trimmed) {
      out.push('');
      continue;
    }
    // Mono fonts use ~0.6 char width at the rendered size; reuse wrapText with
    // a slightly higher avg ratio to err toward narrower wrapping.
    const wrapped = wrapText(
      trimmed,
      22,
      maxWidth,
      Math.max(1, maxLines - out.length),
    );
    for (const w of wrapped) {
      if (out.length >= maxLines) break;
      out.push(w);
    }
  }
  return out;
}

interface AccentColors {
  surface: string;
  border: string;
  text: string;
}

/** Resolve a per-tip accent palette consistent with theme conventions. */
function resolveTipAccent(
  tip: TipBox,
  theme: 'notebook' | 'clean',
): AccentColors {
  const raw = (tip.accent || '').trim().toLowerCase();
  if (theme === 'notebook') {
    if (raw === 'warning' || raw === 'danger' || raw === 'error') {
      return { surface: '#fee2e2', border: '#dc2626', text: '#991b1b' };
    }
    if (raw === 'info' || raw === 'note') {
      return { surface: '#dbeafe', border: '#1d4ed8', text: '#1e3a8a' };
    }
    if (raw && /^#[0-9a-f]{3,8}$/i.test(raw)) {
      return { surface: raw, border: '#0f172a', text: '#0f172a' };
    }
    return { surface: '#fef3c7', border: '#d97706', text: '#92400e' };
  }
  if (raw === 'warning' || raw === 'danger' || raw === 'error') {
    return { surface: '#fee2e2', border: '#dc2626', text: '#7f1d1d' };
  }
  if (raw === 'info' || raw === 'note') {
    return { surface: '#dbeafe', border: '#1e3a8a', text: '#1e3a8a' };
  }
  if (raw === 'success') {
    return { surface: '#dcfce7', border: '#15803d', text: '#14532d' };
  }
  if (raw && /^#[0-9a-f]{3,8}$/i.test(raw)) {
    return { surface: raw, border: '#0f172a', text: '#0f172a' };
  }
  return { surface: '#fef9c3', border: '#ca8a04', text: '#713f12' };
}

// IMPORTANT: SVG attribute values are double-quoted, so font-family stacks here use SINGLE
// quotes around multi-word family names. Mixing nested double quotes corrupts the XML and
// causes libxml (used by sharp) to abort parsing.
const NOTEBOOK_INK_FONT =
  "'Comic Neue', 'Patrick Hand', 'Caveat', 'Segoe Print', 'Segoe Script', 'Apple Chancery', cursive, 'DejaVu Sans', sans-serif";
const NOTEBOOK_MONO_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";
const CLEAN_SANS_FONT =
  "'Inter', 'DejaVu Sans', 'Liberation Sans', 'Helvetica Neue', Arial, sans-serif";
const CLEAN_SERIF_FONT =
  "'Source Serif Pro', 'Georgia', 'DejaVu Serif', 'Times New Roman', serif";
const CLEAN_MONO_FONT = NOTEBOOK_MONO_FONT;

/* ------------------------------------------------------------------------------------ */
/* NOTEBOOK theme: ruled paper, blue/black/red ink, yellow highlights, page badges       */
/* ------------------------------------------------------------------------------------ */

const NOTEBOOK_PAPER_FILL = '#fdf7ed';
const NOTEBOOK_RULE_STROKE = '#dcd2bd';
const NOTEBOOK_INK_BLUE = '#1d4ed8';
const NOTEBOOK_INK_BLACK = '#0f172a';
const NOTEBOOK_INK_RED = '#dc2626';
const NOTEBOOK_HIGHLIGHT = '#fde68a';

function notebookPaperBackground(grainId: string): string {
  return `<defs>
    <filter id="${grainId}" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.78" numOctaves="2" stitchTiles="stitch" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0.10 0"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" fill="${NOTEBOOK_PAPER_FILL}"/>
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" fill="white" filter="url(#${grainId})" opacity="0.22"/>`;
}

function notebookRuledLines(
  startY: number,
  endY: number,
  leftX: number,
  rightX: number,
  step = 44,
): string {
  const lines: string[] = [];
  for (let y = startY; y <= endY; y += step) {
    lines.push(
      `<line x1="${leftX}" y1="${y}" x2="${rightX}" y2="${y}" stroke="${NOTEBOOK_RULE_STROKE}" stroke-width="1.5" opacity="0.9"/>`,
    );
  }
  return lines.join('\n  ');
}

function notebookRedMargin(x: number, topY: number, bottomY: number): string {
  return `<line x1="${x}" y1="${topY}" x2="${x}" y2="${bottomY}" stroke="#fb7185" stroke-width="3" opacity="0.55"/>`;
}

function notebookPageBadge(pageNumber: number, totalPages: number): string {
  const x = DOCUMENT_DECK_CANVAS - 110;
  const y = 56;
  return `<g>
    <rect x="${x}" y="${y - 28}" width="78" height="40" rx="10" fill="${NOTEBOOK_PAPER_FILL}" stroke="${NOTEBOOK_INK_BLACK}" stroke-width="2.2"/>
    <text x="${x + 39}" y="${y}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="22" font-weight="700" fill="${NOTEBOOK_INK_BLACK}">${pageNumber} / ${totalPages}</text>
  </g>`;
}

function notebookHeadingUnderlined(
  headline: string,
  x: number,
  y: number,
  fontSize = 56,
  maxWidth = 880,
): string[] {
  const lines = wrapText(headline, fontSize, maxWidth, 2);
  const out: string[] = [];
  let cursorY = y;
  for (const ln of lines) {
    const txt = escapeXml(ln);
    const lineLen = Math.min(maxWidth, ln.length * fontSize * 0.52 + 8);
    out.push(
      `<text x="${x}" y="${cursorY}" font-family="${NOTEBOOK_INK_FONT}" font-size="${fontSize}" font-weight="800" fill="${NOTEBOOK_INK_RED}">${txt}</text>`,
      `<line x1="${x}" y1="${cursorY + 8}" x2="${x + lineLen}" y2="${cursorY + 8}" stroke="${NOTEBOOK_INK_RED}" stroke-width="3" opacity="0.85" stroke-linecap="round"/>`,
    );
    cursorY += fontSize * 1.15;
  }
  return out;
}

function notebookCoverSvg(
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const grainId = `nbCoverGrain${pageNumber}`;
  const title = sanitize(meta.coverTitle || 'My Notes');
  const subtitle = sanitize(meta.coverSubtitle || '');
  const rawAuthor = sanitize(meta.author || meta.brand || '');
  const isGenericPlaceholder = /^(your\s*name|author|name|placeholder)$/i.test(
    rawAuthor.trim(),
  );
  const author = isGenericPlaceholder ? 'Trndinn' : rawAuthor;

  const paperX = 80;
  const paperW = DOCUMENT_DECK_CANVAS - paperX * 2;
  const paperY = 80;
  const paperH = DOCUMENT_DECK_CANVAS - paperY * 2;
  const innerX = paperX + 80;

  const ruledStart = paperY + 220;
  const ruledEnd = paperY + paperH - 100;
  const titleLines = wrapText(title, 84, paperW - 160, 3);
  let ty = paperY + 200;
  const titleNodes: string[] = [];
  for (const tl of titleLines) {
    titleNodes.push(
      `<text x="${(paperX + paperW) / 2}" y="${ty}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="84" font-weight="800" fill="${NOTEBOOK_INK_BLACK}">${escapeXml(tl)}</text>`,
    );
    ty += 96;
  }
  const subtitleNodes: string[] = [];
  if (subtitle) {
    const subLines = wrapText(subtitle, 36, paperW - 220, 2);
    let sy = ty + 28;
    for (const sl of subLines) {
      subtitleNodes.push(
        `<text x="${(paperX + paperW) / 2}" y="${sy}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="36" font-style="italic" fill="${NOTEBOOK_INK_BLUE}">${escapeXml(sl)}</text>`,
      );
      sy += 44;
    }
  }
  const authorNode = author
    ? `<text x="${(paperX + paperW) / 2}" y="${paperY + paperH - 90}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="28" font-weight="700" fill="${NOTEBOOK_INK_BLACK}">~ ${escapeXml(author)}</text>`
    : '';
  const stickerNote = `<g transform="translate(${innerX - 24} ${paperY + 90})">
    <rect width="170" height="40" rx="6" fill="${NOTEBOOK_HIGHLIGHT}" opacity="0.85"/>
    <text x="14" y="26" font-family="${NOTEBOOK_INK_FONT}" font-size="22" font-weight="700" fill="${NOTEBOOK_INK_BLACK}">study notes</text>
  </g>`;

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  ${notebookPaperBackground(grainId)}
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="20" fill="${NOTEBOOK_PAPER_FILL}" stroke="rgba(15,23,42,0.18)" stroke-width="4"/>
  ${notebookRuledLines(ruledStart, ruledEnd, paperX + 40, paperX + paperW - 40, 44)}
  ${notebookRedMargin(innerX - 38, paperY + 60, paperY + paperH - 60)}
  ${stickerNote}
  ${titleNodes.join('\n  ')}
  ${subtitleNodes.join('\n  ')}
  ${authorNode}
  ${notebookPageBadge(pageNumber, totalPages)}
</svg>`;
}

function notebookTocSvg(
  entries: TocEntry[],
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const grainId = `nbTocGrain${pageNumber}`;
  const paperX = 80;
  const paperW = DOCUMENT_DECK_CANVAS - paperX * 2;
  const paperY = 80;
  const paperH = DOCUMENT_DECK_CANVAS - paperY * 2;
  const innerX = paperX + 80;
  const innerRight = paperX + paperW - 60;

  const headerNodes = notebookHeadingUnderlined(
    'Table of Contents',
    innerX,
    paperY + 120,
    60,
    paperW - 200,
  );

  const listStartY = paperY + 200;
  const lineStep = 56;
  const items: string[] = [];
  const visibleEntries = entries.slice(0, 14);
  for (let i = 0; i < visibleEntries.length; i++) {
    const e = visibleEntries[i];
    const y = listStartY + i * lineStep;
    if (y > paperY + paperH - 80) break;
    const idxLabel = `${i + 1}.`;
    const titleSnippet = sanitize(e.title);
    const dotsX = innerX + 80;
    const dotsRight = innerRight - 84;
    items.push(
      `<text x="${innerX}" y="${y}" font-family="${NOTEBOOK_INK_FONT}" font-size="30" font-weight="700" fill="${NOTEBOOK_INK_RED}">${escapeXml(idxLabel)}</text>`,
      `<text x="${innerX + 60}" y="${y}" font-family="${NOTEBOOK_INK_FONT}" font-size="28" font-weight="600" fill="${NOTEBOOK_INK_BLACK}">${escapeXml(titleSnippet.length > 38 ? titleSnippet.slice(0, 37) + '…' : titleSnippet)}</text>`,
      `<line x1="${dotsX + 10 + Math.min(380, titleSnippet.length * 12)}" y1="${y - 8}" x2="${dotsRight}" y2="${y - 8}" stroke="${NOTEBOOK_INK_BLACK}" stroke-dasharray="2 6" stroke-width="2" opacity="0.55"/>`,
      `<text x="${innerRight}" y="${y}" text-anchor="end" font-family="${NOTEBOOK_INK_FONT}" font-size="28" font-weight="700" fill="${NOTEBOOK_INK_BLUE}">pg ${e.pageNumber}</text>`,
    );
  }

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  ${notebookPaperBackground(grainId)}
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="20" fill="${NOTEBOOK_PAPER_FILL}" stroke="rgba(15,23,42,0.18)" stroke-width="4"/>
  ${notebookRedMargin(innerX - 38, paperY + 60, paperY + paperH - 60)}
  ${notebookRuledLines(paperY + 220, paperY + paperH - 80, paperX + 40, paperX + paperW - 40, 56)}
  ${headerNodes.join('\n  ')}
  ${items.join('\n  ')}
  ${notebookPageBadge(pageNumber, totalPages)}
</svg>`;
}

function notebookBodySvg(
  slide: CarouselSlideOutput,
  pageNumber: number,
  totalPages: number,
): string {
  const grainId = `nbBodyGrain${pageNumber}`;
  const paperX = 80;
  const paperW = DOCUMENT_DECK_CANVAS - paperX * 2;
  const paperY = 80;
  const paperH = DOCUMENT_DECK_CANVAS - paperY * 2;
  const innerX = paperX + 80;
  const innerRight = paperX + paperW - 70;
  const contentW = innerRight - innerX;
  const pageBottomBoundary = paperY + paperH - 100;

  const heading = sanitize(slide.title || `Page ${pageNumber}`);
  const headerNodes = notebookHeadingUnderlined(
    heading,
    innerX,
    paperY + 120,
    50,
    contentW - 40,
  );

  const headerHeight =
    headerNodes.length === 0 ? 0 : Math.ceil(headerNodes.length / 2) * 60;
  const bodyTopY = paperY + 130 + Math.max(60, headerHeight);

  let y = bodyTopY + 24;

  // 1. Paragraph (flowing prose) — drawn first when present so it acts as the lead.
  const paragraphSrc = sanitize(slide.paragraph || '');
  const paragraphNodes: string[] = [];
  if (paragraphSrc && paragraphSrc.length >= 20) {
    const maxParaLines = 5;
    const paraLines = wrapText(paragraphSrc, 22, contentW - 12, maxParaLines);
    for (const ln of paraLines) {
      if (y > pageBottomBoundary - 40) break;
      paragraphNodes.push(
        `<text x="${innerX}" y="${y}" font-family="${NOTEBOOK_INK_FONT}" font-size="22" font-weight="500" fill="${NOTEBOOK_INK_BLACK}">${escapeXml(ln)}</text>`,
      );
      y += 30;
    }
    y += 8;
  }

  // 2. Bullets (highlighted on demand)
  const bullets = collectBodyLines(slide);
  const highlights = new Set(
    (slide.highlights ?? []).filter((n) => n >= 0 && n < bullets.length),
  );
  const bulletNodes: string[] = [];
  let bIdx = 0;
  for (const b of bullets) {
    if (y > pageBottomBoundary - 50) break;
    const wrapped = wrapText(b, 24, contentW - 32, 2);
    const blockHeight = wrapped.length * 32 + 12;
    if (highlights.has(bIdx)) {
      bulletNodes.push(
        `<rect x="${innerX - 8}" y="${y - 24}" width="${contentW - 24}" height="${Math.max(32, blockHeight - 8)}" rx="6" fill="${NOTEBOOK_HIGHLIGHT}" opacity="0.6"/>`,
      );
    }
    let ty = y;
    for (let li = 0; li < wrapped.length; li++) {
      const ln = wrapped[li];
      const prefix = li === 0 ? '• ' : '  ';
      bulletNodes.push(
        `<text x="${innerX}" y="${ty}" font-family="${NOTEBOOK_INK_FONT}" font-size="24" font-weight="${highlights.has(bIdx) ? '700' : '500'}" fill="${highlights.has(bIdx) ? NOTEBOOK_INK_BLACK : NOTEBOOK_INK_BLUE}">${escapeXml(prefix + ln)}</text>`,
      );
      ty += 32;
    }
    y += blockHeight;
    bIdx += 1;
  }

  // 3. Complexity strip (red, prominent)
  const complexity = sanitize(slide.complexity || '');
  const complexityNodes: string[] = [];
  if (complexity && y < pageBottomBoundary - 56) {
    const stripH = 38;
    complexityNodes.push(
      `<rect x="${innerX - 6}" y="${y}" width="${contentW - 30}" height="${stripH}" rx="6" fill="${NOTEBOOK_HIGHLIGHT}" opacity="0.7"/>`,
      `<text x="${innerX + 4}" y="${y + 26}" font-family="${NOTEBOOK_INK_FONT}" font-size="22" font-weight="800" fill="${NOTEBOOK_INK_RED}">⌚ ${escapeXml(truncate(complexity, 92))}</text>`,
    );
    y += stripH + 14;
  }

  // 4. Code snippet block — prefer rich `codeSnippet` (object) over legacy string array.
  const codeSnippetNodes: string[] = [];
  const codeBlock = pickCodeBlock(slide);
  const availableForCode = pageBottomBoundary - y;
  if (codeBlock && availableForCode > 80) {
    const maxCodeLines = Math.min(5, Math.floor((availableForCode - 36) / 28));
    if (maxCodeLines > 0) {
      const codeLines = expandCodeLines(
        codeBlock.code,
        contentW - 60,
        maxCodeLines,
      );
      const boxH = Math.min(codeLines.length * 28 + 38, availableForCode - 18);
      codeSnippetNodes.push(
        `<rect x="${innerX - 12}" y="${y}" width="${contentW + 6}" height="${boxH}" rx="8" fill="rgba(248,250,252,0.92)" stroke="${NOTEBOOK_INK_BLACK}" stroke-width="1.6"/>`,
        `<rect x="${innerX - 12}" y="${y}" width="6" height="${boxH}" fill="${NOTEBOOK_INK_RED}"/>`,
        `<text x="${innerX + 4}" y="${y + 22}" font-family="${NOTEBOOK_INK_FONT}" font-size="14" font-weight="700" fill="${NOTEBOOK_INK_RED}" letter-spacing="1">${escapeXml(codeBlock.language.toUpperCase())}</text>`,
      );
      let cy = y + 44;
      for (const cl of codeLines) {
        if (cy > y + boxH - 10) break;
        codeSnippetNodes.push(
          `<text x="${innerX + 4}" y="${cy}" font-family="${NOTEBOOK_MONO_FONT}" font-size="20" fill="${NOTEBOOK_INK_BLACK}">${escapeXml(cl)}</text>`,
        );
        cy += 28;
      }
      y += boxH + 16;
    }
  }

  // 5. Diagram (rich diagramSpec or legacy diagramHint)
  const diagramNodes: string[] = [];
  const availableForDiagram = pageBottomBoundary - y;
  if (slide.diagramSpec && availableForDiagram > 80) {
    const desired = Math.min(
      availableForDiagram - 8,
      estimateDiagramHeight(slide.diagramSpec, contentW),
    );
    if (desired > 60) {
      diagramNodes.push(
        renderDiagramSvgFragment(slide.diagramSpec, {
          theme: 'notebook',
          x: innerX - 6,
          y,
          width: contentW + 6,
          height: desired,
          idSuffix: `nb${pageNumber}`,
        }),
      );
      y += desired + 12;
    }
  } else if (slide.diagramHint && availableForDiagram > 80) {
    if (slide.diagramHint === 'table' || slide.diagramHint === 'index') {
      diagramNodes.push(
        ...notebookTableSvg(slide, innerX, y, contentW, availableForDiagram),
      );
    } else if (
      slide.diagramHint === 'tree' ||
      slide.diagramHint === 'graph' ||
      slide.diagramHint === 'flow'
    ) {
      diagramNodes.push(...notebookFlowDiagramSvg(slide, innerX, y, contentW));
    }
  }

  // 6. Tip boxes (dropped on top in their own band when space allows)
  const tipNodes: string[] = [];
  const availableForTip = pageBottomBoundary - y;
  const firstTip = (slide.tipBoxes || []).find(
    (t) => sanitize(t.body || '').length >= 6,
  );
  if (firstTip && availableForTip > 96) {
    const accent = resolveTipAccent(firstTip, 'notebook');
    const titleLine = sanitize(firstTip.title || '').slice(0, 40) || 'Tip';
    const bodyText = sanitize(firstTip.body || '');
    const maxTipLines = Math.min(3, Math.floor((availableForTip - 60) / 26));
    if (maxTipLines > 0) {
      const lines = wrapText(bodyText, 20, contentW - 60, maxTipLines);
      const boxH = Math.min(lines.length * 26 + 50, availableForTip);
      tipNodes.push(
        `<rect x="${innerX - 12}" y="${y}" width="${contentW + 6}" height="${boxH}" rx="10" fill="${accent.surface}" stroke="${accent.border}" stroke-width="2"/>`,
        `<text x="${innerX + 4}" y="${y + 28}" font-family="${NOTEBOOK_INK_FONT}" font-size="22" font-weight="800" fill="${accent.text}">💡 ${escapeXml(truncate(titleLine, 40))}</text>`,
      );
      let ty = y + 56;
      for (const ln of lines) {
        if (ty > y + boxH - 10) break;
        tipNodes.push(
          `<text x="${innerX + 4}" y="${ty}" font-family="${NOTEBOOK_INK_FONT}" font-size="20" fill="${NOTEBOOK_INK_BLACK}">${escapeXml(ln)}</text>`,
        );
        ty += 26;
      }
    }
  }

  // 7. Margin notes (italic on right edge — outside content column)
  const marginNoteNodes: string[] = [];
  const marginNotes = (slide.marginNotes || [])
    .map(sanitize)
    .filter((m) => m.length > 0);
  let mny = paperY + 220;
  for (const m of marginNotes.slice(0, 2)) {
    const lines = wrapText(m, 18, 96, 4);
    for (const ln of lines) {
      if (mny > paperY + paperH - 100) break;
      marginNoteNodes.push(
        `<text x="${innerRight + 14}" y="${mny}" font-family="${NOTEBOOK_INK_FONT}" font-size="18" font-style="italic" fill="#475569">${escapeXml(ln)}</text>`,
      );
      mny += 22;
    }
    mny += 24;
  }

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  ${notebookPaperBackground(grainId)}
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="20" fill="${NOTEBOOK_PAPER_FILL}" stroke="rgba(15,23,42,0.18)" stroke-width="4"/>
  ${notebookRedMargin(innerX - 38, paperY + 60, paperY + paperH - 60)}
  ${notebookRuledLines(paperY + 220, paperY + paperH - 80, paperX + 40, paperX + paperW - 40, 50)}
  ${headerNodes.join('\n  ')}
  ${paragraphNodes.join('\n  ')}
  ${bulletNodes.join('\n  ')}
  ${complexityNodes.join('\n  ')}
  ${codeSnippetNodes.join('\n  ')}
  ${diagramNodes.join('\n  ')}
  ${tipNodes.join('\n  ')}
  ${marginNoteNodes.join('\n  ')}
  ${notebookPageBadge(pageNumber, totalPages)}
</svg>`;
}

function notebookOutroSvg(
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const grainId = `nbOutroGrain${pageNumber}`;
  const paperX = 80;
  const paperW = DOCUMENT_DECK_CANVAS - paperX * 2;
  const paperY = 80;
  const paperH = DOCUMENT_DECK_CANVAS - paperY * 2;
  const rawAuthor = sanitize(meta.author || meta.brand || '');
  const isGenericPlaceholder = /^(your\s*name|author|name|placeholder)$/i.test(
    rawAuthor.trim(),
  );
  const author = isGenericPlaceholder ? 'Trndinn' : rawAuthor;

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  ${notebookPaperBackground(grainId)}
  <rect x="${paperX}" y="${paperY}" width="${paperW}" height="${paperH}" rx="20" fill="${NOTEBOOK_PAPER_FILL}" stroke="rgba(15,23,42,0.18)" stroke-width="4"/>
  ${notebookRedMargin(paperX + 80 - 38, paperY + 60, paperY + paperH - 60)}
  <text x="${(paperX + paperW) / 2}" y="${paperY + paperH / 2 - 40}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="72" font-weight="800" fill="${NOTEBOOK_INK_RED}">Thanks for studying!</text>
  <text x="${(paperX + paperW) / 2}" y="${paperY + paperH / 2 + 40}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="32" font-style="italic" fill="${NOTEBOOK_INK_BLUE}">${escapeXml(sanitize(meta.coverTitle || ''))}</text>
  ${author ? `<text x="${(paperX + paperW) / 2}" y="${paperY + paperH - 100}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="28" font-weight="700" fill="${NOTEBOOK_INK_BLACK}">~ ${escapeXml(author)}</text>` : ''}
  ${notebookPageBadge(pageNumber, totalPages)}
</svg>`;
}

function notebookTableSvg(
  slide: CarouselSlideOutput,
  x: number,
  topY: number,
  width: number,
  maxHeight: number,
): string[] {
  const allRows = collectBodyLines(slide);
  if (allRows.length === 0 || maxHeight < 50) return [];

  const minRowH = 40;
  const maxRows = Math.min(allRows.length, Math.floor(maxHeight / minRowH), 5);
  if (maxRows === 0) return [];

  const rows = allRows.slice(0, maxRows);
  const rowH = Math.min(
    56,
    Math.max(minRowH, Math.floor(maxHeight / rows.length)),
  );
  const tableHeight = rowH * rows.length;

  if (tableHeight > maxHeight) return [];

  const colSplit = x + Math.round(width * 0.34);
  const leftColW = colSplit - x - 24;
  const rightColW = width - (colSplit - x) - 28;
  const out: string[] = [];

  out.push(
    `<rect x="${x}" y="${topY}" width="${width}" height="${tableHeight}" fill="rgba(254,252,232,0.6)" stroke="${NOTEBOOK_INK_BLACK}" stroke-width="1.6" rx="4"/>`,
  );
  out.push(
    `<line x1="${colSplit}" y1="${topY}" x2="${colSplit}" y2="${topY + tableHeight}" stroke="${NOTEBOOK_INK_BLACK}" stroke-width="1.4"/>`,
  );

  for (let i = 0; i < rows.length; i++) {
    const ry = topY + (i + 1) * rowH;
    if (i < rows.length - 1) {
      out.push(
        `<line x1="${x}" y1="${ry}" x2="${x + width}" y2="${ry}" stroke="${NOTEBOOK_INK_BLACK}" stroke-width="1" opacity="0.55"/>`,
      );
    }
    const parts = rows[i].split(/\s*[—:|]\s*/);
    const leftRaw = sanitize(parts[0] || rows[i]);
    const rightRaw = sanitize(parts.slice(1).join(' — '));
    const leftMaxChars = Math.floor(leftColW / (22 * 0.52));
    const rightMaxChars = Math.floor(rightColW / (22 * 0.52));
    const left =
      leftRaw.length > leftMaxChars
        ? leftRaw.slice(0, leftMaxChars - 1) + '…'
        : leftRaw;
    const right =
      rightRaw.length > rightMaxChars
        ? rightRaw.slice(0, rightMaxChars - 1) + '…'
        : rightRaw;
    out.push(
      `<text x="${x + 12}" y="${topY + i * rowH + rowH / 2 + 8}" font-family="${NOTEBOOK_INK_FONT}" font-size="22" font-weight="700" fill="${NOTEBOOK_INK_RED}">${escapeXml(left)}</text>`,
      `<text x="${colSplit + 14}" y="${topY + i * rowH + rowH / 2 + 8}" font-family="${NOTEBOOK_INK_FONT}" font-size="22" fill="${NOTEBOOK_INK_BLUE}">${escapeXml(right)}</text>`,
    );
  }
  return out;
}

function notebookFlowDiagramSvg(
  slide: CarouselSlideOutput,
  x: number,
  topY: number,
  width: number,
): string[] {
  const items = collectBodyLines(slide).slice(0, 4);
  if (items.length === 0) return [];
  const out: string[] = [];
  const boxW = Math.min(
    220,
    Math.floor((width - 40) / Math.max(1, Math.min(items.length, 3))),
  );
  const boxH = 64;
  let x0 = x + 8;
  const y = topY + 6;
  for (let i = 0; i < items.length; i++) {
    out.push(
      `<rect x="${x0}" y="${y}" width="${boxW}" height="${boxH}" rx="10" fill="white" stroke="${NOTEBOOK_INK_BLACK}" stroke-width="2"/>`,
      `<text x="${x0 + boxW / 2}" y="${y + boxH / 2 + 6}" text-anchor="middle" font-family="${NOTEBOOK_INK_FONT}" font-size="20" font-weight="700" fill="${NOTEBOOK_INK_BLACK}">${escapeXml(sanitize(items[i]).slice(0, 18))}</text>`,
    );
    if (i < items.length - 1) {
      const arrowStartX = x0 + boxW;
      const arrowEndX = x0 + boxW + 30;
      const arrowY = y + boxH / 2;
      out.push(
        `<line x1="${arrowStartX}" y1="${arrowY}" x2="${arrowEndX - 6}" y2="${arrowY}" stroke="${NOTEBOOK_INK_RED}" stroke-width="2.4"/>`,
        `<polygon points="${arrowEndX},${arrowY} ${arrowEndX - 10},${arrowY - 6} ${arrowEndX - 10},${arrowY + 6}" fill="${NOTEBOOK_INK_RED}"/>`,
      );
    }
    x0 += boxW + 36;
    if (x0 + boxW > x + width) break;
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* CLEAN_DOCUMENT theme: white surface, dark navy accent, footer page #                  */
/* ------------------------------------------------------------------------------------ */

const CLEAN_BG = '#ffffff';
const CLEAN_SURFACE_ALT = '#f8fafc';
const CLEAN_TEXT_PRIMARY = '#0f172a';
const CLEAN_TEXT_MUTED = '#64748b';
const CLEAN_ACCENT = '#1e3a8a';
const CLEAN_ACCENT_SOFT = '#dbeafe';
const CLEAN_RULE = '#e2e8f0';

function cleanFooter(
  pageNumber: number,
  totalPages: number,
  brand?: string,
): string {
  const brandText = brand ? sanitize(brand) : '';
  const cy = DOCUMENT_DECK_CANVAS - 56;
  return `<line x1="80" y1="${cy - 24}" x2="${DOCUMENT_DECK_CANVAS - 80}" y2="${cy - 24}" stroke="${CLEAN_RULE}" stroke-width="1.5"/>
    <text x="80" y="${cy}" font-family="${CLEAN_SANS_FONT}" font-size="20" fill="${CLEAN_TEXT_MUTED}">${brandText ? escapeXml(brandText) : ''}</text>
    <text x="${DOCUMENT_DECK_CANVAS - 80}" y="${cy}" text-anchor="end" font-family="${CLEAN_SANS_FONT}" font-size="20" font-weight="600" fill="${CLEAN_ACCENT}">${pageNumber} / ${totalPages}</text>`;
}

function cleanCoverSvg(
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const title = sanitize(meta.coverTitle || 'Untitled Document');
  const subtitle = sanitize(meta.coverSubtitle || '');
  const author = sanitize(meta.author || '');
  const titleLines = wrapText(title, 88, DOCUMENT_DECK_CANVAS - 200, 3);
  const subtitleLines = subtitle
    ? wrapText(subtitle, 32, DOCUMENT_DECK_CANVAS - 240, 3)
    : [];

  let y = 360;
  const titleNodes: string[] = [];
  for (const tl of titleLines) {
    titleNodes.push(
      `<text x="100" y="${y}" font-family="${CLEAN_SERIF_FONT}" font-size="84" font-weight="700" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(tl)}</text>`,
    );
    y += 96;
  }
  y += 16;
  const subNodes: string[] = [];
  for (const sl of subtitleLines) {
    subNodes.push(
      `<text x="100" y="${y}" font-family="${CLEAN_SANS_FONT}" font-size="32" font-weight="400" fill="${CLEAN_TEXT_MUTED}">${escapeXml(sl)}</text>`,
    );
    y += 42;
  }

  const rule = `<line x1="100" y1="${y + 22}" x2="${100 + 200}" y2="${y + 22}" stroke="${CLEAN_ACCENT}" stroke-width="3"/>`;
  const authorNode = author
    ? `<text x="100" y="${y + 90}" font-family="${CLEAN_SANS_FONT}" font-size="26" font-weight="600" fill="${CLEAN_TEXT_PRIMARY}">By ${escapeXml(author)}</text>`
    : '';
  const brandPill = `<g transform="translate(100 130)">
    <rect width="160" height="38" rx="19" fill="${CLEAN_ACCENT_SOFT}"/>
    <text x="80" y="25" text-anchor="middle" font-family="${CLEAN_SANS_FONT}" font-size="18" font-weight="700" fill="${CLEAN_ACCENT}">${escapeXml(sanitize(meta.brand || 'Study Guide').toUpperCase())}</text>
  </g>`;

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" fill="${CLEAN_BG}"/>
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="80" fill="${CLEAN_ACCENT}"/>
  <rect x="0" y="${DOCUMENT_DECK_CANVAS - 12}" width="${DOCUMENT_DECK_CANVAS}" height="12" fill="${CLEAN_ACCENT}"/>
  ${brandPill}
  ${titleNodes.join('\n  ')}
  ${subNodes.join('\n  ')}
  ${rule}
  ${authorNode}
  ${cleanFooter(pageNumber, totalPages, meta.brand)}
</svg>`;
}

function cleanTocSvg(
  entries: TocEntry[],
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const headlineY = 180;
  const ruleY = headlineY + 30;
  const visible = entries.slice(0, 14);
  const items: string[] = [];
  let y = ruleY + 80;
  const lineStep = 56;
  for (let i = 0; i < visible.length; i++) {
    if (y > DOCUMENT_DECK_CANVAS - 130) break;
    const e = visible[i];
    const idx = String(i + 1).padStart(2, '0');
    const titleSnippet = sanitize(e.title);
    const dotsX = 200;
    const dotsRight = DOCUMENT_DECK_CANVAS - 200;
    items.push(
      `<text x="100" y="${y}" font-family="${CLEAN_SANS_FONT}" font-size="26" font-weight="700" fill="${CLEAN_ACCENT}">${idx}</text>`,
      `<text x="160" y="${y}" font-family="${CLEAN_SANS_FONT}" font-size="26" font-weight="500" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(titleSnippet.length > 44 ? titleSnippet.slice(0, 43) + '…' : titleSnippet)}</text>`,
      `<line x1="${dotsX + 14 + Math.min(440, titleSnippet.length * 13)}" y1="${y - 8}" x2="${dotsRight}" y2="${y - 8}" stroke="${CLEAN_RULE}" stroke-dasharray="3 6" stroke-width="1.5"/>`,
      `<text x="${DOCUMENT_DECK_CANVAS - 100}" y="${y}" text-anchor="end" font-family="${CLEAN_SANS_FONT}" font-size="26" font-weight="700" fill="${CLEAN_ACCENT}">${e.pageNumber}</text>`,
    );
    y += lineStep;
  }

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" fill="${CLEAN_BG}"/>
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="80" fill="${CLEAN_ACCENT}"/>
  <text x="100" y="${headlineY}" font-family="${CLEAN_SERIF_FONT}" font-size="64" font-weight="700" fill="${CLEAN_TEXT_PRIMARY}">Table of Contents</text>
  <line x1="100" y1="${ruleY}" x2="380" y2="${ruleY}" stroke="${CLEAN_ACCENT}" stroke-width="3"/>
  ${items.join('\n  ')}
  ${cleanFooter(pageNumber, totalPages, meta.brand)}
</svg>`;
}

function cleanBodySvg(
  slide: CarouselSlideOutput,
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const heading = sanitize(slide.title || `Page ${pageNumber}`);
  // Per-page accent so multi-slide decks read as a colorful magazine, not a
  // flat one-color document. We pick from a curated palette using pageNumber.
  const pageAccent = pickCleanPageAccent(pageNumber);
  const bullets = collectBodyLines(slide);
  const highlights = new Set(
    (slide.highlights ?? []).filter((n) => n >= 0 && n < bullets.length),
  );

  const contentX = 100;
  const contentRight = DOCUMENT_DECK_CANVAS - 100;
  const contentW = contentRight - contentX;
  const pageBottomBoundary = DOCUMENT_DECK_CANVAS - 100;

  const headingLines = wrapText(heading, 52, contentW, 2);
  let y = 170;
  const headingNodes: string[] = [];
  for (const ln of headingLines) {
    headingNodes.push(
      `<text x="${contentX}" y="${y}" font-family="${CLEAN_SERIF_FONT}" font-size="52" font-weight="700" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(ln)}</text>`,
    );
    y += 60;
  }
  const accentRule = `<line x1="${contentX}" y1="${y + 4}" x2="${contentX + 200}" y2="${y + 4}" stroke="${pageAccent.solid}" stroke-width="4" stroke-linecap="round"/>`;
  y += 28;

  // 1. Paragraph (lead, full prose)
  const paragraphNodes: string[] = [];
  const paragraphSrc = sanitize(slide.paragraph || slide.body || '');
  if (paragraphSrc && paragraphSrc.length >= 16) {
    const paraLines = wrapText(paragraphSrc, 22, contentW, 5);
    for (const ln of paraLines) {
      if (y > pageBottomBoundary - 40) break;
      paragraphNodes.push(
        `<text x="${contentX}" y="${y}" font-family="${CLEAN_SANS_FONT}" font-size="22" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(ln)}</text>`,
      );
      y += 30;
    }
    y += 6;
  }

  // 2. Bullets
  const bulletNodes: string[] = [];
  if (bullets.length > 0) {
    y += 6;
    let bIdx = 0;
    for (const b of bullets) {
      if (y > pageBottomBoundary - 100) break;
      const wrapped = wrapText(b, 22, contentW - 30, 2);
      const blockH = wrapped.length * 30 + 6;
      if (highlights.has(bIdx)) {
        bulletNodes.push(
          `<rect x="${contentX - 6}" y="${y - 24}" width="${contentW + 12}" height="${blockH + 6}" rx="6" fill="${pageAccent.soft}"/>`,
        );
      }
      bulletNodes.push(
        `<circle cx="${contentX + 8}" cy="${y - 9}" r="5" fill="${pageAccent.solid}"/>`,
      );
      let ty = y;
      for (let li = 0; li < wrapped.length; li++) {
        bulletNodes.push(
          `<text x="${contentX + 30}" y="${ty}" font-family="${CLEAN_SANS_FONT}" font-size="22" font-weight="${highlights.has(bIdx) ? '600' : '500'}" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(wrapped[li])}</text>`,
        );
        ty += 30;
      }
      y += blockH + 10;
      bIdx += 1;
    }
  }

  // 3. Complexity badge
  const complexity = sanitize(slide.complexity || '');
  const complexityNodes: string[] = [];
  if (complexity && y < pageBottomBoundary - 60) {
    const stripH = 40;
    complexityNodes.push(
      `<rect x="${contentX - 4}" y="${y}" width="${contentW + 8}" height="${stripH}" rx="8" fill="${pageAccent.soft}" stroke="${pageAccent.solid}" stroke-width="1.5"/>`,
      `<text x="${contentX + 12}" y="${y + 26}" font-family="${CLEAN_SANS_FONT}" font-size="20" font-weight="700" fill="${pageAccent.solid}" letter-spacing="1">COMPLEXITY</text>`,
      `<text x="${contentX + 170}" y="${y + 26}" font-family="${CLEAN_MONO_FONT}" font-size="20" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(truncate(complexity, 60))}</text>`,
    );
    y += stripH + 14;
  }

  // 4. Code snippet (rich object preferred)
  const codeBlock = pickCodeBlock(slide);
  const codeNodes: string[] = [];
  const availableForCode = pageBottomBoundary - y;
  if (codeBlock && availableForCode > 80) {
    const maxCodeLines = Math.min(5, Math.floor((availableForCode - 36) / 28));
    if (maxCodeLines > 0) {
      const codeLines = expandCodeLines(
        codeBlock.code,
        contentW - 50,
        maxCodeLines,
      );
      const boxH = Math.min(codeLines.length * 28 + 44, availableForCode - 16);
      codeNodes.push(
        `<rect x="${contentX - 8}" y="${y}" width="${contentW + 16}" height="${boxH}" rx="10" fill="${CLEAN_SURFACE_ALT}" stroke="${CLEAN_RULE}" stroke-width="1.4"/>`,
        `<rect x="${contentX - 8}" y="${y}" width="6" height="${boxH}" fill="${pageAccent.solid}"/>`,
        `<text x="${contentX + 8}" y="${y + 24}" font-family="${CLEAN_SANS_FONT}" font-size="14" font-weight="700" fill="${pageAccent.solid}" letter-spacing="2">${escapeXml(codeBlock.language.toUpperCase())}</text>`,
      );
      let cy = y + 50;
      for (const cl of codeLines) {
        if (cy > y + boxH - 10) break;
        codeNodes.push(
          `<text x="${contentX + 8}" y="${cy}" font-family="${CLEAN_MONO_FONT}" font-size="20" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(cl)}</text>`,
        );
        cy += 28;
      }
      y += boxH + 14;
    }
  }

  // 5. Diagram (rich diagramSpec preferred)
  const diagramNodes: string[] = [];
  const availableForDiagram = pageBottomBoundary - y;
  if (slide.diagramSpec && availableForDiagram > 90) {
    const desired = Math.min(
      availableForDiagram - 12,
      estimateDiagramHeight(slide.diagramSpec, contentW),
    );
    if (desired > 70) {
      diagramNodes.push(
        renderDiagramSvgFragment(slide.diagramSpec, {
          theme: 'clean',
          x: contentX - 4,
          y,
          width: contentW + 8,
          height: desired,
          idSuffix: `cl${pageNumber}`,
        }),
      );
      y += desired + 16;
    }
  }

  // 6. Tip box / callout — prefer rich `tipBoxes`, fall back to first marginNote.
  const calloutNodes: string[] = [];
  const availableForCallout = pageBottomBoundary - y;
  const firstTip = (slide.tipBoxes || []).find(
    (t) => sanitize(t.body || '').length >= 6,
  );
  if (firstTip && availableForCallout > 96) {
    const accent = resolveTipAccent(firstTip, 'clean');
    const titleLine = sanitize(firstTip.title || '').slice(0, 42) || 'Pro Tip';
    const bodyText = sanitize(firstTip.body || '');
    const maxLines = Math.min(3, Math.floor((availableForCallout - 60) / 26));
    if (maxLines > 0) {
      const lines = wrapText(bodyText, 22, contentW - 30, maxLines);
      const boxH = Math.min(lines.length * 26 + 56, availableForCallout);
      calloutNodes.push(
        `<rect x="${contentX - 8}" y="${y}" width="${contentW + 16}" height="${boxH}" rx="12" fill="${accent.surface}" stroke="${accent.border}" stroke-width="1.5"/>`,
        `<text x="${contentX + 8}" y="${y + 28}" font-family="${CLEAN_SANS_FONT}" font-size="16" font-weight="800" fill="${accent.text}" letter-spacing="2">${escapeXml(truncate(titleLine, 42).toUpperCase())}</text>`,
      );
      let cy = y + 56;
      for (const ln of lines) {
        if (cy > y + boxH - 10) break;
        calloutNodes.push(
          `<text x="${contentX + 8}" y="${cy}" font-family="${CLEAN_SANS_FONT}" font-size="22" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(ln)}</text>`,
        );
        cy += 26;
      }
    }
  } else {
    const calloutNote = (slide.marginNotes || [])
      .map(sanitize)
      .find((m) => m.length >= 16 && m.length <= 220);
    if (calloutNote && availableForCallout > 100) {
      const maxCalloutLines = Math.min(
        3,
        Math.floor((availableForCallout - 56) / 28),
      );
      if (maxCalloutLines > 0) {
        const lines = wrapText(calloutNote, 22, contentW - 30, maxCalloutLines);
        const boxH = Math.min(lines.length * 28 + 38, availableForCallout);
        calloutNodes.push(
          `<rect x="${contentX - 8}" y="${y}" width="${contentW + 16}" height="${boxH}" rx="10" fill="${pageAccent.soft}" stroke="${pageAccent.solid}" stroke-width="1.5"/>`,
          `<text x="${contentX + 8}" y="${y + 28}" font-family="${CLEAN_SANS_FONT}" font-size="16" font-weight="700" fill="${pageAccent.solid}" letter-spacing="2">KEY TAKEAWAY</text>`,
        );
        let cy = y + 56;
        for (const ln of lines) {
          if (cy > y + boxH - 10) break;
          calloutNodes.push(
            `<text x="${contentX + 8}" y="${cy}" font-family="${CLEAN_SANS_FONT}" font-size="22" fill="${CLEAN_TEXT_PRIMARY}">${escapeXml(ln)}</text>`,
          );
          cy += 28;
        }
      }
    }
  }

  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" fill="${CLEAN_BG}"/>
  <rect x="0" y="0" width="6" height="${DOCUMENT_DECK_CANVAS}" fill="${pageAccent.solid}"/>
  ${headingNodes.join('\n  ')}
  ${accentRule}
  ${paragraphNodes.join('\n  ')}
  ${bulletNodes.join('\n  ')}
  ${complexityNodes.join('\n  ')}
  ${codeNodes.join('\n  ')}
  ${diagramNodes.join('\n  ')}
  ${calloutNodes.join('\n  ')}
  ${cleanFooter(pageNumber, totalPages, meta.brand)}
</svg>`;
}

/**
 * Curated per-page accent palette so a 5–12 page clean deck reads as a polished
 * magazine spread — different page accents per slide, but cohesive together.
 */
const CLEAN_PAGE_ACCENTS: { solid: string; soft: string }[] = [
  { solid: '#1e3a8a', soft: '#dbeafe' },
  { solid: '#0f766e', soft: '#ccfbf1' },
  { solid: '#9333ea', soft: '#ede9fe' },
  { solid: '#dc2626', soft: '#fee2e2' },
  { solid: '#ca8a04', soft: '#fef3c7' },
  { solid: '#0369a1', soft: '#e0f2fe' },
  { solid: '#15803d', soft: '#dcfce7' },
];
function pickCleanPageAccent(pageNumber: number): {
  solid: string;
  soft: string;
} {
  const safe = Math.max(0, Math.floor(pageNumber - 1));
  return CLEAN_PAGE_ACCENTS[safe % CLEAN_PAGE_ACCENTS.length];
}

function cleanOutroSvg(
  meta: DocumentDeckMeta,
  pageNumber: number,
  totalPages: number,
): string {
  const title = sanitize(meta.coverTitle || 'Thank you');
  const rawAuthor = sanitize(meta.author || '');
  const isGenericPlaceholder = /^(your\s*name|author|name|placeholder)$/i.test(
    rawAuthor.trim(),
  );
  const author = isGenericPlaceholder ? 'Trndinn' : rawAuthor;
  return `<svg width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="${DOCUMENT_DECK_CANVAS}" fill="${CLEAN_BG}"/>
  <rect x="0" y="0" width="${DOCUMENT_DECK_CANVAS}" height="80" fill="${CLEAN_ACCENT}"/>
  <text x="${DOCUMENT_DECK_CANVAS / 2}" y="${DOCUMENT_DECK_CANVAS / 2 - 40}" text-anchor="middle" font-family="${CLEAN_SERIF_FONT}" font-size="80" font-weight="700" fill="${CLEAN_TEXT_PRIMARY}">Thanks for reading.</text>
  <text x="${DOCUMENT_DECK_CANVAS / 2}" y="${DOCUMENT_DECK_CANVAS / 2 + 26}" text-anchor="middle" font-family="${CLEAN_SANS_FONT}" font-size="32" fill="${CLEAN_TEXT_MUTED}">${escapeXml(title)}</text>
  ${author ? `<text x="${DOCUMENT_DECK_CANVAS / 2}" y="${DOCUMENT_DECK_CANVAS / 2 + 90}" text-anchor="middle" font-family="${CLEAN_SANS_FONT}" font-size="24" font-weight="600" fill="${CLEAN_ACCENT}">— ${escapeXml(author)}</text>` : ''}
  ${cleanFooter(pageNumber, totalPages, meta.brand)}
</svg>`;
}

/* ------------------------------------------------------------------------------------ */
/* Body line collector                                                                  */
/* ------------------------------------------------------------------------------------ */

function collectBodyLines(slide: CarouselSlideOutput): string[] {
  const out: string[] = [];
  for (const sec of slide.notebookSections || []) {
    for (const ln of sec.lines || []) {
      const t = sanitize(ln);
      if (t) out.push(t);
    }
    for (const b of sec.bulletItems || []) {
      const t = sanitize(b);
      if (t) out.push(t);
    }
  }
  for (const b of slide.bullets || []) {
    const t = sanitize(b);
    if (t) out.push(t);
  }
  for (const b of slide.denseBullets || []) {
    const t = sanitize(b);
    if (t) out.push(t);
  }
  // De-dup
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const o of out) {
    const key = o.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(o);
  }
  return dedup;
}

/* ------------------------------------------------------------------------------------ */
/* Public entry point                                                                   */
/* ------------------------------------------------------------------------------------ */

/**
 * Render one document-deck slide to a 1080×1080 JPEG buffer. Selects layout based on
 * `slide.sectionType` (cover/toc/body/outro) and the requested theme. Skips the OpenAI
 * image API entirely.
 */
export async function renderDocumentDeckSlide(
  params: RenderDocumentSlideParams,
): Promise<Buffer> {
  const svg = buildDocumentDeckSlideSvg(params);
  return sharp(Buffer.from(svg))
    .resize(DOCUMENT_DECK_CANVAS, DOCUMENT_DECK_CANVAS, { fit: 'cover' })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Test/preview-friendly: returns the SVG string without invoking sharp. */
export function buildDocumentDeckSlideSvg(
  params: RenderDocumentSlideParams,
): string {
  const { slide, pageNumber, totalPages, theme, meta, tocEntries } = params;
  const section = slide.sectionType ?? 'body';
  const safeToc = Array.isArray(tocEntries) ? tocEntries : [];

  if (theme === 'notebook') {
    if (section === 'cover')
      return notebookCoverSvg(meta, pageNumber, totalPages);
    if (section === 'toc')
      return notebookTocSvg(safeToc, meta, pageNumber, totalPages);
    if (section === 'outro')
      return notebookOutroSvg(meta, pageNumber, totalPages);
    return notebookBodySvg(slide, pageNumber, totalPages);
  }

  if (section === 'cover') return cleanCoverSvg(meta, pageNumber, totalPages);
  if (section === 'toc')
    return cleanTocSvg(safeToc, meta, pageNumber, totalPages);
  if (section === 'outro') return cleanOutroSvg(meta, pageNumber, totalPages);
  return cleanBodySvg(slide, meta, pageNumber, totalPages);
}
