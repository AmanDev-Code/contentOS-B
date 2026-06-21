/**
 * Image Generation Utility
 * Provides functions to generate actual visual diagrams for blog posts
 * Integrates with the enhanced diagram generation script
 */

import { createCanvas } from 'canvas';
import { Client as MinioClient } from 'minio';
import sharp from 'sharp';

// Brand colors
const COLORS = {
  primary: '#6366f1',
  secondary: '#8b5cf6',
  accent: '#ff8a1f',
  success: '#10b981',
  background: '#ffffff',
  text: '#1e293b',
  textMuted: '#64748b',
  border: '#e2e8f0',
};

export interface ImageGenerationOptions {
  type: 'comparison' | 'workflow' | 'process' | 'chart' | 'hero';
  title: string;
  data?: any;
  width?: number;
  height?: number;
}

/**
 * Generate a visual diagram based on type and data
 */
export async function generateDiagram(
  options: ImageGenerationOptions,
): Promise<Buffer> {
  const { type, title, data, width = 1000, height = 600 } = options;

  switch (type) {
    case 'comparison':
      return generateComparisonChart(title, data, width, height);
    case 'workflow':
      return generateWorkflowDiagram(title, data, width, height);
    case 'process':
      return generateProcessFlow(title, data, width, height);
    case 'chart':
      return generateDataChart(title, data, width, height);
    case 'hero':
      return generateHeroImage(title, width, height);
    default:
      return generateHeroImage(title, width, height);
  }
}

/**
 * Generate comparison chart (horizontal bars)
 */
function generateComparisonChart(
  title: string,
  items: Array<{ label: string; value: number; color?: string }>,
  width: number,
  height: number,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 28px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 50);

  // Chart
  const chartX = 150;
  const chartY = 100;
  const chartWidth = width - 300;
  const chartHeight = height - 150;
  const barHeight = chartHeight / items.length - 15;
  const maxValue = Math.max(...items.map((i) => i.value));

  items.forEach((item, index) => {
    const y = chartY + index * (barHeight + 15);
    const barWidth = (item.value / maxValue) * chartWidth;
    const color =
      item.color ||
      [COLORS.primary, COLORS.accent, COLORS.secondary, COLORS.success][
        index % 4
      ];

    // Label
    ctx.fillStyle = COLORS.text;
    ctx.font = '16px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(item.label, chartX - 10, y + barHeight / 2 + 5);

    // Bar
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(chartX, y, chartWidth, barHeight);
    ctx.fillStyle = color;
    ctx.fillRect(chartX, y, barWidth, barHeight);

    // Value
    ctx.fillStyle = COLORS.background;
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${item.value}%`,
      chartX + barWidth - 50,
      y + barHeight / 2 + 5,
    );
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Generate workflow diagram
 */
function generateWorkflowDiagram(
  title: string,
  steps: Array<{ title: string; description: string }>,
  width: number,
  height: number,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 40);

  // Layout
  const cols = Math.min(steps.length, 3);
  const rows = Math.ceil(steps.length / cols);
  const boxWidth = 280;
  const boxHeight = 100;
  const padding = 60;
  const startX = (width - (cols * boxWidth + (cols - 1) * padding)) / 2;
  const startY = 80;

  steps.forEach((step, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = startX + col * (boxWidth + padding);
    const y = startY + row * (boxHeight + 60);

    // Box gradient
    const gradient = ctx.createLinearGradient(x, y, x, y + boxHeight);
    gradient.addColorStop(0, COLORS.primary);
    gradient.addColorStop(1, COLORS.secondary);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, boxWidth, boxHeight);

    // Step number
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(`${index + 1}`, x + boxWidth - 10, y + 40);

    // Title
    ctx.fillStyle = COLORS.background;
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(step.title.substring(0, 30), x + 15, y + 35);

    // Description
    ctx.font = '12px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(step.description.substring(0, 40), x + 15, y + 60);
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Generate process flow (vertical)
 */
function generateProcessFlow(
  title: string,
  steps: Array<{ number: number; title: string }>,
  width: number,
  height: number,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#ffffff');
  bgGradient.addColorStop(1, '#f8fafc');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 50);

  const stepHeight = 100;
  const startY = 100;
  const centerX = width / 2;

  steps.forEach((step, index) => {
    const y = startY + index * 120;

    // Circle
    ctx.fillStyle = COLORS.primary;
    ctx.beginPath();
    ctx.arc(centerX, y, 35, 0, Math.PI * 2);
    ctx.fill();

    // Number
    ctx.fillStyle = COLORS.background;
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(step.number.toString(), centerX, y);

    // Title
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 18px Arial';
    ctx.textBaseline = 'top';
    ctx.fillText(step.title, centerX, y + 50);
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Generate data chart (bar chart)
 */
function generateDataChart(
  title: string,
  data: Array<{ label: string; value: number }>,
  width: number,
  height: number,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 40);

  // Chart
  const chartX = 80;
  const chartY = 80;
  const chartWidth = width - 160;
  const chartHeight = height - 160;
  const barWidth = chartWidth / data.length - 15;
  const maxValue = Math.max(...data.map((d) => d.value));

  data.forEach((item, index) => {
    const x = chartX + index * (barWidth + 15);
    const barHeightPx = (item.value / maxValue) * chartHeight;
    const y = chartY + chartHeight - barHeightPx;

    // Bar
    const gradient = ctx.createLinearGradient(x, y, x, chartY + chartHeight);
    gradient.addColorStop(0, COLORS.primary);
    gradient.addColorStop(1, COLORS.accent);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, barHeightPx);

    // Value
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(item.value.toString(), x + barWidth / 2, y - 10);

    // Label
    ctx.save();
    ctx.translate(x + barWidth / 2, chartY + chartHeight + 10);
    ctx.rotate(-Math.PI / 6);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '12px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(item.label, 0, 0);
    ctx.restore();
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Generate hero image (gradient with text)
 */
function generateHeroImage(
  title: string,
  width: number,
  height: number,
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Gradient background
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, COLORS.primary);
  gradient.addColorStop(1, COLORS.secondary);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.fillStyle = COLORS.background;
  ctx.font = 'bold 48px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Wrap text
  const words = title.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  words.forEach((word) => {
    const testLine = currentLine + word + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > width - 100 && currentLine !== '') {
      lines.push(currentLine);
      currentLine = word + ' ';
    } else {
      currentLine = testLine;
    }
  });
  lines.push(currentLine);

  const lineHeight = 60;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;

  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, startY + i * lineHeight);
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Parse image type from heading or content
 */
export function detectImageType(
  heading: string,
  content?: string,
): ImageGenerationOptions['type'] {
  const text = `${heading} ${content || ''}`.toLowerCase();

  if (/(?:vs\.?|versus|compar|alternative|difference)/i.test(text)) {
    return 'comparison';
  }
  if (/(?:process|workflow|steps|how to|guide|tutorial)/i.test(text)) {
    return 'workflow';
  }
  if (/(?:chart|graph|data|statistics|metrics|performance)/i.test(text)) {
    return 'chart';
  }

  return 'hero';
}

/**
 * Extract data from content for charts
 */
export function extractChartData(content: string): any {
  // Simple extraction logic - can be enhanced
  const items: Array<{ label: string; value: number }> = [];

  // Look for patterns like "X: 85%" or "X - 85%"
  const matches = content.matchAll(/([^:\-\n]+)[\:\-]\s*(\d+)%/g);
  for (const match of matches) {
    items.push({
      label: match[1].trim().substring(0, 30),
      value: parseInt(match[2]),
    });
  }

  if (items.length > 0) {
    return items;
  }

  // Default sample data
  return [
    { label: 'Category A', value: 85 },
    { label: 'Category B', value: 70 },
    { label: 'Category C', value: 60 },
    { label: 'Category D', value: 50 },
  ];
}

/**
 * Extract workflow steps from content
 */
export function extractWorkflowSteps(content: string): any {
  const steps: Array<{ title: string; description: string }> = [];

  // Look for numbered lists or step patterns
  const matches = content.matchAll(/(?:^|\n)(?:\d+\.|\*|\-)\s*([^\n]+)/g);
  let count = 0;

  for (const match of matches) {
    if (count >= 6) break; // Max 6 steps
    const text = match[1].trim();
    if (text.length > 10) {
      steps.push({
        title: text.substring(0, 35),
        description: text.substring(35, 75),
      });
      count++;
    }
  }

  // Default if nothing found
  if (steps.length === 0) {
    return [
      { title: 'Step 1', description: 'Get started' },
      { title: 'Step 2', description: 'Configure settings' },
      { title: 'Step 3', description: 'Launch' },
    ];
  }

  return steps;
}

// ─── Premium OG Image Generation ────────────────────────────────────────────

export interface OGImageOptions {
  title: string;
  category?: string;
  excerpt?: string;
  width?: number;
  height?: number;
}

const OG_BRAND = {
  bgDark: '#060b17',
  bgCard: '#0d1527',
  primary: '#f27a1a',
  primaryLight: '#ff9a44',
  textWhite: '#f0f4f8',
  textMuted: '#8b9ab5',
  border: '#1c2a42',
  accentGradientStart: '#f27a1a',
  accentGradientEnd: '#e04e1b',
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > maxCharsPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.slice(0, 4);
}

/**
 * Generate a premium OG image (1200x630) using SVG → PNG via sharp.
 * Produces a professional social card with brand identity.
 */
export async function generateOGImage(options: OGImageOptions): Promise<Buffer> {
  const { title, category, excerpt, width = 1200, height = 630 } = options;
  const b = OG_BRAND;

  const titleLines = wrapText(title, 38);
  const titleFontSize = titleLines.length > 2 ? 38 : 44;
  const titleLineHeight = titleFontSize + 12;
  const titleStartY = 220;

  const titleTspans = titleLines
    .map(
      (line, i) =>
        `<tspan x="80" dy="${i === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  const excerptLines = excerpt ? wrapText(excerpt, 70).slice(0, 2) : [];
  const excerptY = titleStartY + titleLines.length * titleLineHeight + 24;
  const excerptTspans = excerptLines
    .map(
      (line, i) =>
        `<tspan x="80" dy="${i === 0 ? 0 : 24}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  const categoryBadge = category
    ? `<g transform="translate(${width - 80 - category.length * 9}, 60)">
        <rect width="${category.length * 9 + 24}" height="32" rx="16" fill="${b.primary}" opacity="0.15"/>
        <text x="${(category.length * 9 + 24) / 2}" y="21" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" fill="${b.primary}" text-anchor="middle" letter-spacing="0.5">${escapeXml(category.toUpperCase())}</text>
      </g>`
    : '';

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${b.bgDark}"/>
      <stop offset="100%" stop-color="#0a1628"/>
    </linearGradient>
    <linearGradient id="accent-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${b.accentGradientStart}"/>
      <stop offset="100%" stop-color="${b.accentGradientEnd}"/>
    </linearGradient>
    <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${b.primary}" stop-opacity="0.08"/>
      <stop offset="50%" stop-color="${b.primary}" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="transparent" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.8" fill="${b.textMuted}" opacity="0.08"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${width}" height="${height}" fill="url(#bg-gradient)"/>

  <!-- Subtle dot grid pattern -->
  <rect width="${width}" height="${height}" fill="url(#grid)"/>

  <!-- Top-right glow orb -->
  <ellipse cx="${width - 200}" cy="120" rx="300" ry="200" fill="url(#glow)"/>

  <!-- Left accent stripe -->
  <rect x="0" y="0" width="6" height="${height}" fill="url(#accent-gradient)"/>

  <!-- Inner card area with subtle border -->
  <rect x="50" y="40" width="${width - 100}" height="${height - 80}" rx="16" ry="16" fill="none" stroke="${b.border}" stroke-width="1" opacity="0.5"/>

  <!-- Brand name -->
  <text x="80" y="90" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="18" font-weight="700" fill="${b.primary}" letter-spacing="3">TRNDINN</text>

  <!-- Category badge -->
  ${categoryBadge}

  <!-- Decorative line below brand -->
  <line x1="80" y1="120" x2="200" y2="120" stroke="${b.primary}" stroke-width="2" opacity="0.4"/>

  <!-- Title -->
  <text x="80" y="${titleStartY}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${titleFontSize}" font-weight="700" fill="${b.textWhite}" letter-spacing="-0.5">
    ${titleTspans}
  </text>

  <!-- Excerpt -->
  ${excerptLines.length > 0 ? `<text x="80" y="${excerptY}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="18" fill="${b.textMuted}" letter-spacing="0.2">${excerptTspans}</text>` : ''}

  <!-- Bottom separator -->
  <line x1="80" y1="${height - 80}" x2="${width - 80}" y2="${height - 80}" stroke="${b.border}" stroke-width="1"/>

  <!-- Footer: domain + read article -->
  <text x="80" y="${height - 45}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="14" fill="${b.textMuted}" letter-spacing="0.5">trndinn.com</text>
  <circle cx="178" cy="${height - 49}" r="2" fill="${b.textMuted}" opacity="0.5"/>
  <text x="196" y="${height - 45}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="14" fill="${b.primary}" letter-spacing="0.5">Read Article</text>

  <!-- Bottom-right brand accent dot cluster -->
  <circle cx="${width - 100}" cy="${height - 50}" r="4" fill="${b.primary}" opacity="0.6"/>
  <circle cx="${width - 115}" cy="${height - 56}" r="2.5" fill="${b.primaryLight}" opacity="0.4"/>
  <circle cx="${width - 88}" cy="${height - 60}" r="2" fill="${b.primary}" opacity="0.3"/>
</svg>`;

  const pngBuffer = await sharp(Buffer.from(svg))
    .png({ quality: 95 })
    .toBuffer();

  return pngBuffer;
}
