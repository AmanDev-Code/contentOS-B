/**
 * Pure helpers shared by carousel quality gates and PNG compositor.
 */

import type { NotebookSection } from './custom-topic.schemas';

export function collectStructuredNotebookLines(slide: {
  body?: string;
  bullets?: string[];
  denseBullets?: string[];
  codeSnippets?: string[];
  notebookSections?: NotebookSection[];
  marginNotes?: string[];
  title?: string;
}): string[] {
  const out: string[] = [];
  if (slide.notebookSections?.length) {
    for (const sec of slide.notebookSections) {
      const sh = (sec.subheading || '').trim();
      if (sh) out.push(sh);
      for (const ln of sec.lines || []) {
        const t = ln.trim();
        if (t) out.push(t);
      }
      for (const b of sec.bulletItems || []) {
        const t = b.trim();
        if (t) out.push(`• ${t}`);
      }
    }
  }
  for (const ln of String(slide.body || '').split(/\n+/)) {
    const t = ln.trim();
    if (t) out.push(t);
  }
  for (const b of slide.bullets || []) {
    const t = b.trim();
    if (t) out.push(`• ${t}`);
  }
  for (const b of slide.denseBullets || []) {
    const t = b.trim();
    if (t) out.push(`• ${t}`);
  }
  for (const c of slide.codeSnippets || []) {
    const t = c.trim();
    if (t) out.push(t);
  }
  return out;
}

const CODEBLOCK_PREFIX = 'CODEBLOCK|||';

/** Marks a Java/code excerpt row for monospace compositor rendering */
export function packCodeRowForCompositor(snippet: string): string {
  return `${CODEBLOCK_PREFIX}${snippet}`;
}

export function isCompositorCodeRow(row: string): boolean {
  return row.startsWith(CODEBLOCK_PREFIX);
}

export function unpackCompositorCodeRow(row: string): string {
  return row.slice(CODEBLOCK_PREFIX.length);
}

/** Logical rows consumed by notebook compositor prior to wrapping */
export function expandNotebookStructuredRows(
  headline: string,
  notebookSections?: NotebookSection[],
  marginNotes?: string[],
  denseBullets?: string[],
  codeSnippets?: string[],
): { mainRows: string[]; sidebarLabels: string[] } {
  const mainRows: string[] = [];
  if (headline.trim()) mainRows.push(headline.trim());

  if (notebookSections?.length) {
    for (const sec of notebookSections) {
      if (sec.subheading?.trim()) {
        mainRows.push(`§ ${sec.subheading.trim()}`);
      }
      for (const ln of sec.lines || []) {
        if (ln.trim()) mainRows.push(ln.trim());
      }
      for (const b of sec.bulletItems || []) {
        if (b.trim()) mainRows.push(`• ${b.trim()}`);
      }
    }
  }

  for (const b of denseBullets || []) {
    if (b.trim()) mainRows.push(`• ${b.trim()}`);
  }

  for (const c of codeSnippets || []) {
    const t = c.trim();
    if (t) mainRows.push(packCodeRowForCompositor(t));
  }

  const sidebarLabels = (marginNotes || []).map((m) =>
    m.replace(/\s+/g, ' ').trim(),
  );

  return { mainRows, sidebarLabels };
}

export function structuredBlocksCount(slide: {
  notebookSections?: NotebookSection[];
}): number {
  return slide.notebookSections?.length ?? 0;
}
