/**
 * Programmatic diagram renderer for educational carousel slides.
 *
 * Takes a validated `DiagramSpec` (from the slide schema) and returns an SVG
 * fragment that can be embedded inside the notebook / clean_document slide
 * compositor. The fragment is wrapped in a <g transform="translate(x,y)"> so
 * callers can place it anywhere on the 1080×1080 canvas.
 *
 * Design constraints:
 *   - Pure string output (no `sharp` calls here — the parent slide compositor
 *     already invokes sharp once with the assembled SVG).
 *   - No async work, no I/O. Targeting < 5 ms per call.
 *   - Two themed palettes (notebook, clean) so the same spec renders cohesively
 *     in both decks.
 *   - Defensive: gracefully degrades when `elements` is empty or `edges` reference
 *     unknown labels — never throws.
 */

import type { DiagramSpec } from './custom-topic.schemas';

export interface DiagramRenderOptions {
  theme: 'notebook' | 'clean';
  /** Bounding box origin on the parent SVG. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional unique suffix to prevent SVG <defs> id collisions. */
  idSuffix?: string;
}

/* ------------------------------------------------------------------------------------ */
/* Palette                                                                              */
/* ------------------------------------------------------------------------------------ */

interface Palette {
  ink: string;
  accent: string;
  accentSoft: string;
  warmBox: string;
  warmStroke: string;
  altBox: string;
  text: string;
  arrow: string;
  titleColor: string;
  font: string;
  monoFont: string;
}

const NOTEBOOK_PALETTE: Palette = {
  ink: '#0f172a',
  accent: '#dc2626',
  accentSoft: '#fde68a',
  warmBox: '#fef3c7',
  warmStroke: '#0f172a',
  altBox: '#dbeafe',
  text: '#0f172a',
  arrow: '#dc2626',
  titleColor: '#1d4ed8',
  font: "'Comic Neue', 'Patrick Hand', 'Caveat', 'Segoe Print', 'Segoe Script', cursive, 'DejaVu Sans', sans-serif",
  monoFont:
    "'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace",
};

const CLEAN_PALETTE: Palette = {
  ink: '#0f172a',
  accent: '#1e3a8a',
  accentSoft: '#dbeafe',
  warmBox: '#f1f5f9',
  warmStroke: '#cbd5e1',
  altBox: '#e0e7ff',
  text: '#0f172a',
  arrow: '#1e3a8a',
  titleColor: '#1e3a8a',
  font: "'Inter', 'DejaVu Sans', 'Liberation Sans', 'Helvetica Neue', Arial, sans-serif",
  monoFont:
    "'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace",
};

/** Curated highlight cycle so per-element colors look cohesive. */
const NOTEBOOK_HIGHLIGHT_CYCLE = [
  '#fde68a', // amber highlight
  '#bfdbfe', // sky
  '#fecaca', // rose
  '#bbf7d0', // green
  '#e9d5ff', // violet
  '#fdba74', // orange
];
const CLEAN_HIGHLIGHT_CYCLE = [
  '#dbeafe', // soft blue
  '#dcfce7', // mint
  '#fee2e2', // soft red
  '#ede9fe', // lavender
  '#fef3c7', // pale yellow
  '#fce7f3', // pink
];

/* ------------------------------------------------------------------------------------ */
/* Helpers                                                                              */
/* ------------------------------------------------------------------------------------ */

function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

/** Look up a usable color from element-supplied hint or palette cycle. */
function pickElementColor(
  explicit: string | undefined,
  index: number,
  theme: 'notebook' | 'clean',
): string {
  if (explicit && /^#?[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$/.test(explicit.trim())) {
    return explicit.startsWith('#') || /^[a-zA-Z]/.test(explicit)
      ? explicit
      : `#${explicit}`;
  }
  const cycle =
    theme === 'notebook' ? NOTEBOOK_HIGHLIGHT_CYCLE : CLEAN_HIGHLIGHT_CYCLE;
  return cycle[index % cycle.length];
}

/** Wrap label to fit a node, prefer single line. */
function wrapLabelLines(
  label: string,
  fontSize: number,
  maxWidth: number,
  maxLines = 2,
): string[] {
  const cleaned = label.trim().replace(/\s+/g, ' ');
  if (!cleaned) return [];
  const charW = fontSize * 0.55;
  const maxChars = Math.max(6, Math.floor(maxWidth / charW));
  if (cleaned.length <= maxChars) return [cleaned];
  const words = cleaned.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (t.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = t;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars) lines[maxLines - 1] = truncate(last, maxChars);
  }
  return lines.length > 0 ? lines : [truncate(cleaned, maxChars)];
}

/** Defs for arrowhead markers used by flow/graph diagrams. */
function arrowDefs(idPrefix: string, palette: Palette): string {
  return [
    '<defs>',
    `<marker id="${idPrefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">`,
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.arrow}" />`,
    '</marker>',
    '</defs>',
  ].join('');
}

/* ------------------------------------------------------------------------------------ */
/* Renderers per type                                                                   */
/* ------------------------------------------------------------------------------------ */

function renderArray(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const cells = spec.elements.slice(0, 8);
  if (cells.length === 0) return '';
  const titleH = spec.title ? 32 : 0;
  const indexH = 24;
  const gap = 8;
  const cellH = Math.min(
    78,
    Math.max(48, Math.floor((height - titleH - indexH - gap * 2) * 0.55)),
  );
  const cellW = Math.max(
    40,
    Math.floor((width - gap * (cells.length + 1)) / cells.length),
  );
  const rowY =
    y + titleH + Math.floor((height - titleH - cellH - indexH - gap) / 2);
  const out: string[] = [];

  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 22}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }

  for (let i = 0; i < cells.length; i++) {
    const cellX = x + gap + i * (cellW + gap);
    const fill = pickElementColor(cells[i].color, i, opts.theme);
    out.push(
      `<rect x="${cellX}" y="${rowY}" width="${cellW}" height="${cellH}" rx="${opts.theme === 'notebook' ? 4 : 6}" fill="${fill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.2 : 1.6}"/>`,
    );
    const labelLines = wrapLabelLines(cells[i].label, 18, cellW - 12, 2);
    let ly = rowY + cellH / 2 - (labelLines.length - 1) * 11;
    for (const ln of labelLines) {
      out.push(
        `<text x="${cellX + cellW / 2}" y="${ly + 6}" text-anchor="middle" font-family="${palette.font}" font-size="18" font-weight="600" fill="${palette.text}">${escapeXml(ln)}</text>`,
      );
      ly += 22;
    }
    // Index below
    out.push(
      `<text x="${cellX + cellW / 2}" y="${rowY + cellH + indexH - 4}" text-anchor="middle" font-family="${palette.monoFont}" font-size="14" fill="${palette.accent}">[${i}]</text>`,
    );
  }
  return out.join('\n  ');
}

function renderLinkedList(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const idPrefix = `dg-ll-${opts.idSuffix ?? 'a'}`;
  const elements = spec.elements.slice(0, 5);
  if (elements.length === 0) return '';
  const titleH = spec.title ? 30 : 0;
  const arrowGap = 30;
  const totalArrowGap = arrowGap * (elements.length - 1);
  const nodeW = Math.max(
    70,
    Math.min(150, Math.floor((width - totalArrowGap - 16) / elements.length)),
  );
  const nodeH = Math.min(78, height - titleH - 28);
  const startX =
    x +
    Math.max(
      8,
      Math.floor((width - elements.length * nodeW - totalArrowGap) / 2),
    );
  const rowY = y + titleH + Math.floor((height - titleH - nodeH) / 2);
  const out: string[] = [arrowDefs(idPrefix, palette)];

  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 20}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }

  let cursorX = startX;
  for (let i = 0; i < elements.length; i++) {
    const fill = pickElementColor(elements[i].color, i, opts.theme);
    out.push(
      `<rect x="${cursorX}" y="${rowY}" width="${nodeW}" height="${nodeH}" rx="${opts.theme === 'notebook' ? 6 : 8}" fill="${fill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.4 : 1.6}"/>`,
    );
    // Inner divider data | next pointer
    const dividerX = cursorX + nodeW * 0.7;
    out.push(
      `<line x1="${dividerX}" y1="${rowY + 4}" x2="${dividerX}" y2="${rowY + nodeH - 4}" stroke="${palette.ink}" stroke-width="1.5" opacity="0.7"/>`,
    );
    const labelLines = wrapLabelLines(
      elements[i].label,
      17,
      dividerX - cursorX - 8,
      2,
    );
    let ly = rowY + nodeH / 2 - (labelLines.length - 1) * 10;
    for (const ln of labelLines) {
      out.push(
        `<text x="${cursorX + (dividerX - cursorX) / 2}" y="${ly + 5}" text-anchor="middle" font-family="${palette.font}" font-size="17" font-weight="600" fill="${palette.text}">${escapeXml(ln)}</text>`,
      );
      ly += 20;
    }
    // Pointer slot
    const isLast = i === elements.length - 1;
    out.push(
      `<text x="${dividerX + (cursorX + nodeW - dividerX) / 2}" y="${rowY + nodeH / 2 + 5}" text-anchor="middle" font-family="${palette.monoFont}" font-size="14" font-weight="700" fill="${palette.accent}">${isLast ? '∅' : '·'}</text>`,
    );
    if (!isLast) {
      const ax1 = cursorX + nodeW;
      const ax2 = ax1 + arrowGap - 6;
      const ay = rowY + nodeH / 2;
      out.push(
        `<line x1="${ax1}" y1="${ay}" x2="${ax2}" y2="${ay}" stroke="${palette.arrow}" stroke-width="2.4" marker-end="url(#${idPrefix}-arrow)"/>`,
      );
    }
    cursorX += nodeW + arrowGap;
  }
  return out.join('\n  ');
}

function renderHashMap(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const rows = spec.elements.slice(0, 6);
  if (rows.length === 0) return '';
  const titleH = spec.title ? 32 : 0;
  const headerH = 28;
  const rowH = Math.max(
    36,
    Math.min(60, Math.floor((height - titleH - headerH - 8) / rows.length)),
  );
  const tableTop = y + titleH;
  const colSplit = x + Math.floor(width * 0.42);
  const out: string[] = [];

  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 22}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }
  out.push(
    `<rect x="${x}" y="${tableTop}" width="${width}" height="${headerH + rowH * rows.length}" rx="6" fill="${palette.warmBox}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.2 : 1.5}"/>`,
    `<rect x="${x}" y="${tableTop}" width="${width}" height="${headerH}" fill="${palette.altBox}"/>`,
    `<line x1="${colSplit}" y1="${tableTop}" x2="${colSplit}" y2="${tableTop + headerH + rowH * rows.length}" stroke="${palette.ink}" stroke-width="1.5"/>`,
    `<text x="${x + (colSplit - x) / 2}" y="${tableTop + headerH - 8}" text-anchor="middle" font-family="${palette.font}" font-size="16" font-weight="800" fill="${palette.titleColor}">key</text>`,
    `<text x="${colSplit + (x + width - colSplit) / 2}" y="${tableTop + headerH - 8}" text-anchor="middle" font-family="${palette.font}" font-size="16" font-weight="800" fill="${palette.titleColor}">value</text>`,
  );

  for (let i = 0; i < rows.length; i++) {
    const ry = tableTop + headerH + i * rowH;
    if (i > 0) {
      out.push(
        `<line x1="${x}" y1="${ry}" x2="${x + width}" y2="${ry}" stroke="${palette.ink}" stroke-width="1" opacity="0.4"/>`,
      );
    }
    const parts = rows[i].label.split(/\s*[—:|=>]\s*/);
    const left = parts[0] || rows[i].label;
    const right = parts.slice(1).join(' → ') || '∗';
    out.push(
      `<text x="${x + 10}" y="${ry + rowH / 2 + 6}" font-family="${palette.monoFont}" font-size="${opts.theme === 'notebook' ? 17 : 16}" font-weight="700" fill="${palette.accent}">${escapeXml(truncate(left, 18))}</text>`,
      `<text x="${colSplit + 10}" y="${ry + rowH / 2 + 6}" font-family="${palette.font}" font-size="${opts.theme === 'notebook' ? 17 : 16}" fill="${palette.text}">${escapeXml(truncate(right, 32))}</text>`,
    );
  }
  return out.join('\n  ');
}

function renderTree(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const elements = spec.elements.slice(0, 7);
  if (elements.length === 0) return '';
  const titleH = spec.title ? 30 : 0;
  const rootR = 36;
  const childR = 32;
  const rootCx = x + width / 2;
  const rootCy = y + titleH + rootR + 10;
  const childY = rootCy + 90;
  const childCount = elements.length - 1;
  const out: string[] = [];

  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 20}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }
  // Root
  const rootFill = pickElementColor(elements[0].color, 0, opts.theme);
  out.push(
    `<circle cx="${rootCx}" cy="${rootCy}" r="${rootR}" fill="${rootFill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.4 : 1.8}"/>`,
    `<text x="${rootCx}" y="${rootCy + 5}" text-anchor="middle" font-family="${palette.font}" font-size="${elements[0].label.length > 4 ? 14 : 17}" font-weight="700" fill="${palette.text}">${escapeXml(truncate(elements[0].label, 8))}</text>`,
  );
  if (childCount === 0) return out.join('\n  ');

  const childGap =
    childCount === 1 ? 0 : Math.min(width / (childCount + 1), 220);
  const totalSpan = (childCount - 1) * childGap;
  const startX = rootCx - totalSpan / 2;
  for (let i = 0; i < childCount; i++) {
    const cx = startX + i * childGap;
    const cy = Math.min(childY, y + height - childR - 8);
    const fill = pickElementColor(elements[i + 1].color, i + 1, opts.theme);
    out.push(
      `<line x1="${rootCx}" y1="${rootCy + rootR}" x2="${cx}" y2="${cy - childR}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2 : 1.6}"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${childR}" fill="${fill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.2 : 1.6}"/>`,
      `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="${palette.font}" font-size="${elements[i + 1].label.length > 4 ? 14 : 17}" font-weight="700" fill="${palette.text}">${escapeXml(truncate(elements[i + 1].label, 8))}</text>`,
    );
  }
  return out.join('\n  ');
}

function renderFlowOrSequence(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const idPrefix = `dg-fl-${opts.idSuffix ?? 'a'}`;
  const elements = spec.elements.slice(0, 5);
  if (elements.length === 0) return '';
  const titleH = spec.title ? 30 : 0;
  const arrowGap = 22;
  const totalArrowGap = arrowGap * (elements.length - 1);
  const nodeW = Math.max(
    110,
    Math.min(220, Math.floor((width - totalArrowGap - 8) / elements.length)),
  );
  const nodeH = Math.min(80, height - titleH - 14);
  const startX =
    x +
    Math.max(
      4,
      Math.floor((width - elements.length * nodeW - totalArrowGap) / 2),
    );
  const rowY = y + titleH + Math.floor((height - titleH - nodeH) / 2);
  const out: string[] = [arrowDefs(idPrefix, palette)];

  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 20}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }
  let cursorX = startX;
  for (let i = 0; i < elements.length; i++) {
    const fill = pickElementColor(elements[i].color, i, opts.theme);
    const isDiamond = (elements[i].shape || '').toLowerCase() === 'diamond';
    if (isDiamond) {
      const cx = cursorX + nodeW / 2;
      const cy = rowY + nodeH / 2;
      out.push(
        `<polygon points="${cursorX},${cy} ${cx},${rowY} ${cursorX + nodeW},${cy} ${cx},${rowY + nodeH}" fill="${fill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.4 : 1.6}"/>`,
      );
    } else {
      out.push(
        `<rect x="${cursorX}" y="${rowY}" width="${nodeW}" height="${nodeH}" rx="${opts.theme === 'notebook' ? 10 : 12}" fill="${fill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.4 : 1.6}"/>`,
      );
    }
    const lines = wrapLabelLines(elements[i].label, 16, nodeW - 16, 2);
    let ly = rowY + nodeH / 2 - (lines.length - 1) * 9;
    for (const ln of lines) {
      out.push(
        `<text x="${cursorX + nodeW / 2}" y="${ly + 5}" text-anchor="middle" font-family="${palette.font}" font-size="16" font-weight="${opts.theme === 'notebook' ? '700' : '600'}" fill="${palette.text}">${escapeXml(ln)}</text>`,
      );
      ly += 19;
    }
    if (i < elements.length - 1) {
      const ax1 = cursorX + nodeW;
      const ax2 = ax1 + arrowGap - 6;
      const ay = rowY + nodeH / 2;
      out.push(
        `<line x1="${ax1}" y1="${ay}" x2="${ax2}" y2="${ay}" stroke="${palette.arrow}" stroke-width="2.4" marker-end="url(#${idPrefix}-arrow)"/>`,
      );
    }
    cursorX += nodeW + arrowGap;
  }
  return out.join('\n  ');
}

function renderComparisonTable(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const rows = spec.elements.slice(0, 6);
  if (rows.length === 0) return '';
  const titleH = spec.title ? 30 : 0;
  const rowH = Math.max(
    34,
    Math.min(56, Math.floor((height - titleH - 8) / rows.length)),
  );
  const tableTop = y + titleH;
  const out: string[] = [];

  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 20}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }
  out.push(
    `<rect x="${x}" y="${tableTop}" width="${width}" height="${rowH * rows.length}" rx="6" fill="${palette.warmBox}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2 : 1.4}"/>`,
  );
  for (let i = 0; i < rows.length; i++) {
    const ry = tableTop + i * rowH;
    if (i > 0) {
      out.push(
        `<line x1="${x}" y1="${ry}" x2="${x + width}" y2="${ry}" stroke="${palette.ink}" stroke-width="1" opacity="0.4"/>`,
      );
    }
    const fill = pickElementColor(rows[i].color, i, opts.theme);
    out.push(
      `<rect x="${x}" y="${ry}" width="14" height="${rowH}" fill="${fill}" stroke="${palette.ink}" stroke-width="0.5"/>`,
    );
    const parts = rows[i].label.split(/\s*[—:|]\s*/);
    const heading = parts[0] || rows[i].label;
    const detail = parts.slice(1).join(' — ');
    out.push(
      `<text x="${x + 24}" y="${ry + rowH / 2 + 6}" font-family="${palette.font}" font-size="${opts.theme === 'notebook' ? 17 : 16}" font-weight="700" fill="${palette.accent}">${escapeXml(truncate(heading, 22))}</text>`,
    );
    if (detail) {
      out.push(
        `<text x="${x + Math.floor(width * 0.4)}" y="${ry + rowH / 2 + 6}" font-family="${palette.font}" font-size="${opts.theme === 'notebook' ? 16 : 15}" fill="${palette.text}">${escapeXml(truncate(detail, 50))}</text>`,
      );
    }
  }
  return out.join('\n  ');
}

function renderGraph(
  spec: DiagramSpec,
  opts: DiagramRenderOptions,
  palette: Palette,
): string {
  const { x, y, width, height } = opts;
  const idPrefix = `dg-gr-${opts.idSuffix ?? 'a'}`;
  const elements = spec.elements.slice(0, 6);
  if (elements.length === 0) return '';
  const titleH = spec.title ? 28 : 0;
  const usable = {
    x: x + 12,
    y: y + titleH + 10,
    w: width - 24,
    h: height - titleH - 22,
  };
  const out: string[] = [arrowDefs(idPrefix, palette)];
  if (spec.title) {
    out.push(
      `<text x="${x + width / 2}" y="${y + 20}" text-anchor="middle" font-family="${palette.font}" font-size="20" font-weight="700" fill="${palette.titleColor}">${escapeXml(truncate(spec.title, 60))}</text>`,
    );
  }

  // Position nodes around the perimeter of an ellipse to avoid label overlaps.
  const cx = usable.x + usable.w / 2;
  const cy = usable.y + usable.h / 2;
  const rx = usable.w / 2 - 30;
  const ry = usable.h / 2 - 26;
  const positions: { x: number; y: number; label: string }[] = elements.map(
    (el, i) => {
      const a = (i / elements.length) * Math.PI * 2 - Math.PI / 2;
      return {
        x: cx + Math.cos(a) * rx,
        y: cy + Math.sin(a) * ry,
        label: el.label,
      };
    },
  );

  // Edges
  const labelToIndex = new Map<string, number>();
  for (let i = 0; i < positions.length; i++) {
    labelToIndex.set(positions[i].label.toLowerCase(), i);
  }
  for (const e of spec.edges ?? []) {
    const fi = labelToIndex.get(e.from.toLowerCase());
    const ti = labelToIndex.get(e.to.toLowerCase());
    if (fi == null || ti == null) continue;
    const p1 = positions[fi];
    const p2 = positions[ti];
    out.push(
      `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${e.color || palette.arrow}" stroke-width="2" opacity="0.85" marker-end="url(#${idPrefix}-arrow)"/>`,
    );
    if (e.label) {
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      out.push(
        `<text x="${mx}" y="${my - 4}" text-anchor="middle" font-family="${palette.font}" font-size="13" fill="${palette.accent}" font-weight="600">${escapeXml(truncate(e.label, 18))}</text>`,
      );
    }
  }
  // Nodes on top
  for (let i = 0; i < positions.length; i++) {
    const fill = pickElementColor(elements[i].color, i, opts.theme);
    const r = 28;
    out.push(
      `<circle cx="${positions[i].x}" cy="${positions[i].y}" r="${r}" fill="${fill}" stroke="${palette.ink}" stroke-width="${opts.theme === 'notebook' ? 2.2 : 1.6}"/>`,
      `<text x="${positions[i].x}" y="${positions[i].y + 5}" text-anchor="middle" font-family="${palette.font}" font-size="${positions[i].label.length > 4 ? 13 : 16}" font-weight="700" fill="${palette.text}">${escapeXml(truncate(positions[i].label, 8))}</text>`,
    );
  }
  return out.join('\n  ');
}

/* ------------------------------------------------------------------------------------ */
/* Public entry point                                                                   */
/* ------------------------------------------------------------------------------------ */

/**
 * Render a single diagram spec to an SVG fragment positioned at (x,y).
 * Always returns valid SVG (empty `<g/>` for invalid specs) so callers can
 * concatenate without conditional logic.
 */
export function renderDiagramSvgFragment(
  spec: DiagramSpec | undefined | null,
  opts: DiagramRenderOptions,
): string {
  try {
    if (!spec || !Array.isArray(spec.elements) || spec.elements.length === 0) {
      return '';
    }
    const palette =
      opts.theme === 'notebook' ? NOTEBOOK_PALETTE : CLEAN_PALETTE;
    let inner = '';
    switch (spec.type) {
      case 'array':
        inner = renderArray(spec, opts, palette);
        break;
      case 'linked-list':
        inner = renderLinkedList(spec, opts, palette);
        break;
      case 'hash-map':
        inner = renderHashMap(spec, opts, palette);
        break;
      case 'tree':
        inner = renderTree(spec, opts, palette);
        break;
      case 'flowchart':
      case 'sequence':
        inner = renderFlowOrSequence(spec, opts, palette);
        break;
      case 'comparison-table':
        inner = renderComparisonTable(spec, opts, palette);
        break;
      case 'graph':
        inner = renderGraph(spec, opts, palette);
        break;
      default:
        inner = '';
    }
    if (!inner) return '';
    // Return a simple <g> wrapper. The parent compositor places the diagram via
    // its own (x,y) coordinates inside the parent SVG — these renderers already
    // emit absolute coordinates so no extra transform is needed.
    return `<g data-diagram-type="${escapeXml(spec.type)}">${inner}</g>`;
  } catch {
    // Defensive: never crash a slide render because of a broken diagram spec.
    return '';
  }
}

/**
 * Estimate the natural height a diagram needs for its bounding box, given a
 * fixed width. Compositor uses this to allocate vertical space without trial
 * rendering.
 */
export function estimateDiagramHeight(
  spec: DiagramSpec,
  availableWidth: number,
): number {
  if (!spec || !spec.elements || spec.elements.length === 0) return 0;
  const titleH = spec.title ? 32 : 0;
  switch (spec.type) {
    case 'array':
      return titleH + 110;
    case 'linked-list':
      return titleH + 110;
    case 'hash-map':
      return titleH + 28 + Math.min(spec.elements.length, 6) * 46;
    case 'tree':
      return titleH + 200;
    case 'flowchart':
    case 'sequence':
      return titleH + 110;
    case 'comparison-table':
      return titleH + Math.min(spec.elements.length, 6) * 50;
    case 'graph':
      return titleH + Math.min(280, Math.max(200, availableWidth * 0.55));
    default:
      return 0;
  }
}
