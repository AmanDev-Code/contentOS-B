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

// ─── Platform-Specific Image Generation ─────────────────────────────────────

export type PlatformImageType =
  | 'linkedin'
  | 'devto'
  | 'medium'
  | 'newsletter'
  | 'twitter'
  | 'reddit';

export interface PlatformImageConfig {
  width: number;
  height: number;
  style: 'professional' | 'technical' | 'editorial' | 'branded' | 'minimal';
}

export const PLATFORM_IMAGE_CONFIGS: Record<string, PlatformImageConfig> = {
  linkedin: { width: 1200, height: 627, style: 'professional' },
  linkedin_article: { width: 1200, height: 627, style: 'professional' },
  linkedin_post: { width: 1200, height: 627, style: 'professional' },
  devto: { width: 1000, height: 420, style: 'technical' },
  hashnode: { width: 1200, height: 630, style: 'technical' },
  medium: { width: 1400, height: 700, style: 'editorial' },
  newsletter: { width: 600, height: 300, style: 'branded' },
  beehiiv: { width: 600, height: 300, style: 'branded' },
  twitter: { width: 1200, height: 675, style: 'minimal' },
  twitter_thread: { width: 1200, height: 675, style: 'minimal' },
  ghost: { width: 1200, height: 630, style: 'editorial' },
  substack: { width: 1200, height: 630, style: 'editorial' },
};

const PLATFORM_STYLES = {
  professional: {
    bgGradientStart: '#0a1628',
    bgGradientEnd: '#1a2744',
    accentColor: '#0077b5',
    accentLight: '#00a0dc',
    textColor: '#f0f4f8',
    textMuted: '#8b9ab5',
    borderColor: '#1c2a42',
  },
  technical: {
    bgGradientStart: '#0d1117',
    bgGradientEnd: '#161b22',
    accentColor: '#58a6ff',
    accentLight: '#79c0ff',
    textColor: '#f0f6fc',
    textMuted: '#8b949e',
    borderColor: '#30363d',
  },
  editorial: {
    bgGradientStart: '#1a1a1a',
    bgGradientEnd: '#2d2d2d',
    accentColor: '#00ab6c',
    accentLight: '#00d084',
    textColor: '#ffffff',
    textMuted: '#a0a0a0',
    borderColor: '#404040',
  },
  branded: {
    bgGradientStart: '#060b17',
    bgGradientEnd: '#0d1527',
    accentColor: '#f27a1a',
    accentLight: '#ff9a44',
    textColor: '#f0f4f8',
    textMuted: '#8b9ab5',
    borderColor: '#1c2a42',
  },
  minimal: {
    bgGradientStart: '#15202b',
    bgGradientEnd: '#192734',
    accentColor: '#1d9bf0',
    accentLight: '#4db5f9',
    textColor: '#ffffff',
    textMuted: '#8899a6',
    borderColor: '#38444d',
  },
};

export interface PlatformCoverImageOptions {
  title: string;
  platform: string;
  category?: string;
  excerpt?: string;
  hashtags?: string[];
}

/**
 * Generate a platform-specific cover image
 */
export async function generatePlatformCoverImage(
  options: PlatformCoverImageOptions,
): Promise<Buffer> {
  const { title, platform, category, excerpt, hashtags } = options;
  const config = PLATFORM_IMAGE_CONFIGS[platform] || PLATFORM_IMAGE_CONFIGS.linkedin;
  const style = PLATFORM_STYLES[config.style];
  const { width, height } = config;

  const titleLines = wrapText(title, Math.floor(width / 28));
  const titleFontSize = titleLines.length > 2 ? Math.floor(width / 28) : Math.floor(width / 24);
  const titleLineHeight = titleFontSize + 12;
  const titleStartY = Math.floor(height * 0.35);

  const titleTspans = titleLines
    .map(
      (line, i) =>
        `<tspan x="80" dy="${i === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  const excerptLines = excerpt ? wrapText(excerpt, Math.floor(width / 16)).slice(0, 2) : [];
  const excerptY = titleStartY + titleLines.length * titleLineHeight + 24;
  const excerptTspans = excerptLines
    .map(
      (line, i) =>
        `<tspan x="80" dy="${i === 0 ? 0 : 24}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  const categoryBadge = category
    ? `<g transform="translate(${width - 80 - category.length * 9}, 50)">
        <rect width="${category.length * 9 + 24}" height="28" rx="14" fill="${style.accentColor}" opacity="0.2"/>
        <text x="${(category.length * 9 + 24) / 2}" y="19" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="${style.accentColor}" text-anchor="middle" letter-spacing="0.5">${escapeXml(category.toUpperCase())}</text>
      </g>`
    : '';

  const hashtagsText = hashtags?.slice(0, 3).join(' ') || '';
  const hashtagsElement = hashtagsText
    ? `<text x="80" y="${height - 40}" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="${style.accentColor}" letter-spacing="0.3">${escapeXml(hashtagsText)}</text>`
    : '';

  const platformLabel = getPlatformLabel(platform);

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${style.bgGradientStart}"/>
      <stop offset="100%" stop-color="${style.bgGradientEnd}"/>
    </linearGradient>
    <linearGradient id="accent-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${style.accentColor}"/>
      <stop offset="100%" stop-color="${style.accentLight}"/>
    </linearGradient>
    <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${style.accentColor}" stop-opacity="0.12"/>
      <stop offset="50%" stop-color="${style.accentColor}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="transparent" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.6" fill="${style.textMuted}" opacity="0.06"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${width}" height="${height}" fill="url(#bg-gradient)"/>
  <rect width="${width}" height="${height}" fill="url(#grid)"/>

  <!-- Glow effect -->
  <ellipse cx="${width - 150}" cy="100" rx="250" ry="180" fill="url(#glow)"/>

  <!-- Left accent stripe -->
  <rect x="0" y="0" width="5" height="${height}" fill="url(#accent-gradient)"/>

  <!-- Inner card border -->
  <rect x="40" y="30" width="${width - 80}" height="${height - 60}" rx="12" ry="12" fill="none" stroke="${style.borderColor}" stroke-width="1" opacity="0.4"/>

  <!-- Brand -->
  <text x="80" y="75" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="16" font-weight="700" fill="${style.accentColor}" letter-spacing="2.5">TRNDINN</text>

  <!-- Category badge -->
  ${categoryBadge}

  <!-- Decorative line -->
  <line x1="80" y1="100" x2="180" y2="100" stroke="${style.accentColor}" stroke-width="2" opacity="0.5"/>

  <!-- Title -->
  <text x="80" y="${titleStartY}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${titleFontSize}" font-weight="700" fill="${style.textColor}" letter-spacing="-0.5">
    ${titleTspans}
  </text>

  <!-- Excerpt -->
  ${excerptLines.length > 0 ? `<text x="80" y="${excerptY}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="16" fill="${style.textMuted}" letter-spacing="0.2">${excerptTspans}</text>` : ''}

  <!-- Bottom separator -->
  <line x1="80" y1="${height - 65}" x2="${width - 80}" y2="${height - 65}" stroke="${style.borderColor}" stroke-width="1"/>

  <!-- Footer -->
  <text x="80" y="${height - 40}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="13" fill="${style.textMuted}" letter-spacing="0.4">trndinn.com</text>
  ${hashtagsText ? `<text x="${width - 80}" y="${height - 40}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="${style.accentColor}" text-anchor="end" letter-spacing="0.3">${escapeXml(hashtagsText)}</text>` : ''}

  <!-- Platform indicator -->
  <text x="${width - 80}" y="75" font-family="system-ui, -apple-system, sans-serif" font-size="11" fill="${style.textMuted}" text-anchor="end" letter-spacing="0.5">${escapeXml(platformLabel)}</text>

  <!-- Accent dots -->
  <circle cx="${width - 60}" cy="${height - 45}" r="3" fill="${style.accentColor}" opacity="0.5"/>
  <circle cx="${width - 72}" cy="${height - 50}" r="2" fill="${style.accentLight}" opacity="0.3"/>
</svg>`;

  const pngBuffer = await sharp(Buffer.from(svg))
    .png({ quality: 95 })
    .toBuffer();

  return pngBuffer;
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    linkedin: 'LinkedIn',
    linkedin_article: 'LinkedIn Article',
    linkedin_post: 'LinkedIn Post',
    devto: 'DEV.to',
    hashnode: 'Hashnode',
    medium: 'Medium',
    newsletter: 'Newsletter',
    beehiiv: 'Beehiiv',
    twitter: 'Twitter/X',
    twitter_thread: 'Twitter Thread',
    ghost: 'Ghost',
    substack: 'Substack',
    reddit: 'Reddit',
    hackernews: 'Hacker News',
  };
  return labels[platform] || platform.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Generate a section/inline image for content
 */
export async function generateSectionImage(
  title: string,
  sectionNumber: number,
  platform: string,
): Promise<Buffer> {
  const config = PLATFORM_IMAGE_CONFIGS[platform] || PLATFORM_IMAGE_CONFIGS.linkedin;
  const style = PLATFORM_STYLES[config.style];
  const width = Math.floor(config.width * 0.8);
  const height = Math.floor(config.height * 0.6);

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${style.bgGradientStart}"/>
      <stop offset="100%" stop-color="${style.bgGradientEnd}"/>
    </linearGradient>
    <linearGradient id="accent-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${style.accentColor}"/>
      <stop offset="100%" stop-color="${style.accentLight}"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg-gradient)"/>
  
  <!-- Section number circle -->
  <circle cx="60" cy="${height / 2}" r="30" fill="url(#accent-gradient)"/>
  <text x="60" y="${height / 2 + 8}" font-family="system-ui, -apple-system, sans-serif" font-size="24" font-weight="700" fill="${style.textColor}" text-anchor="middle">${sectionNumber}</text>

  <!-- Section title -->
  <text x="120" y="${height / 2 + 6}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="22" font-weight="600" fill="${style.textColor}">${escapeXml(title.substring(0, 50))}</text>

  <!-- Decorative line -->
  <line x1="120" y1="${height / 2 + 20}" x2="${width - 60}" y2="${height / 2 + 20}" stroke="${style.borderColor}" stroke-width="1"/>
</svg>`;

  const pngBuffer = await sharp(Buffer.from(svg))
    .png({ quality: 90 })
    .toBuffer();

  return pngBuffer;
}

/**
 * Get recommended image dimensions for a platform
 */
export function getPlatformImageDimensions(platform: string): { width: number; height: number } {
  const config = PLATFORM_IMAGE_CONFIGS[platform];
  if (config) {
    return { width: config.width, height: config.height };
  }
  return { width: 1200, height: 630 };
}

/**
 * Check if a platform typically uses images
 */
export function platformUsesImages(platform: string): boolean {
  const noImagePlatforms = new Set([
    'reddit',
    'hackernews',
    'indiehackers',
    'producthunt_discussions',
    'growthhackers',
    'huggingface_community',
  ]);
  return !noImagePlatforms.has(platform);
}
