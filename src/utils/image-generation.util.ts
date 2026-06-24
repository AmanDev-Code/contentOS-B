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

  <!-- Brand name - removed for clean design -->

  <!-- Category badge -->
  ${categoryBadge}

  <!-- Decorative line -->
  <line x1="80" y1="120" x2="200" y2="120" stroke="${b.primary}" stroke-width="2" opacity="0.4"/>

  <!-- Title -->
  <text x="80" y="${titleStartY}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${titleFontSize}" font-weight="700" fill="${b.textWhite}" letter-spacing="-0.5">
    ${titleTspans}
  </text>

  <!-- Excerpt -->
  ${excerptLines.length > 0 ? `<text x="80" y="${excerptY}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="18" fill="${b.textMuted}" letter-spacing="0.2">${excerptTspans}</text>` : ''}

  <!-- Bottom separator -->
  <line x1="80" y1="${height - 80}" x2="${width - 80}" y2="${height - 80}" stroke="${b.border}" stroke-width="1"/>

  <!-- Footer: Read article CTA only, no branding -->
  <text x="80" y="${height - 45}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="14" fill="${b.primary}" letter-spacing="0.5">Read Article</text>

  <!-- Bottom-right accent dot cluster -->
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
  showPlatformBranding?: boolean;
}

export type InlineImageStyle = 
  | 'infographic'
  | 'comparison'
  | 'workflow'
  | 'quote'
  | 'statistic'
  | 'checklist'
  | 'timeline';

export interface InlineImageOptions {
  title: string;
  style: InlineImageStyle;
  platform: string;
  data?: any;
  sectionNumber?: number;
}

/**
 * Generate a platform-specific cover image
 * Note: Images are clean without any branding watermarks.
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

  <!-- Clean design - no branding watermark -->

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

  <!-- Footer - hashtags only, no branding -->
  ${hashtagsText ? `<text x="${width - 80}" y="${height - 40}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="${style.accentColor}" text-anchor="end" letter-spacing="0.3">${escapeXml(hashtagsText)}</text>` : ''}

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

// ─── Diverse Inline Image Generation ─────────────────────────────────────────

const INLINE_IMAGE_STYLES: Record<InlineImageStyle, {
  bgStart: string;
  bgEnd: string;
  accent: string;
  accentLight: string;
  text: string;
  textMuted: string;
}> = {
  infographic: {
    bgStart: '#1a1f35',
    bgEnd: '#0f1629',
    accent: '#6366f1',
    accentLight: '#818cf8',
    text: '#f8fafc',
    textMuted: '#94a3b8',
  },
  comparison: {
    bgStart: '#0c1222',
    bgEnd: '#1a2744',
    accent: '#10b981',
    accentLight: '#34d399',
    text: '#f0fdf4',
    textMuted: '#86efac',
  },
  workflow: {
    bgStart: '#18181b',
    bgEnd: '#27272a',
    accent: '#f59e0b',
    accentLight: '#fbbf24',
    text: '#fefce8',
    textMuted: '#fde047',
  },
  quote: {
    bgStart: '#1e1b4b',
    bgEnd: '#312e81',
    accent: '#a78bfa',
    accentLight: '#c4b5fd',
    text: '#f5f3ff',
    textMuted: '#ddd6fe',
  },
  statistic: {
    bgStart: '#0c4a6e',
    bgEnd: '#075985',
    accent: '#38bdf8',
    accentLight: '#7dd3fc',
    text: '#f0f9ff',
    textMuted: '#bae6fd',
  },
  checklist: {
    bgStart: '#14532d',
    bgEnd: '#166534',
    accent: '#4ade80',
    accentLight: '#86efac',
    text: '#f0fdf4',
    textMuted: '#bbf7d0',
  },
  timeline: {
    bgStart: '#4c0519',
    bgEnd: '#881337',
    accent: '#fb7185',
    accentLight: '#fda4af',
    text: '#fff1f2',
    textMuted: '#fecdd3',
  },
};

/**
 * Generate a diverse inline image with a specific style
 */
export async function generateInlineImage(
  options: InlineImageOptions,
): Promise<Buffer> {
  const { title, style, platform, data, sectionNumber } = options;
  const config = PLATFORM_IMAGE_CONFIGS[platform] || PLATFORM_IMAGE_CONFIGS.linkedin;
  const colors = INLINE_IMAGE_STYLES[style];
  const width = Math.floor(config.width * 0.85);
  const height = Math.floor(config.height * 0.65);

  switch (style) {
    case 'infographic':
      return generateInfographicImage(title, data, colors, width, height);
    case 'comparison':
      return generateComparisonImage(title, data, colors, width, height);
    case 'workflow':
      return generateWorkflowImage(title, data, colors, width, height);
    case 'quote':
      return generateQuoteImage(title, data, colors, width, height);
    case 'statistic':
      return generateStatisticImage(title, data, colors, width, height);
    case 'checklist':
      return generateChecklistImage(title, data, colors, width, height);
    case 'timeline':
      return generateTimelineImage(title, data, colors, width, height);
    default:
      return generateInfographicImage(title, data, colors, width, height);
  }
}

async function generateInfographicImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.infographic,
  width: number,
  height: number,
): Promise<Buffer> {
  const items = data?.items || [
    { label: 'Efficiency', value: 85 },
    { label: 'Quality', value: 92 },
    { label: 'Speed', value: 78 },
  ];

  const barHeight = 28;
  const barGap = 16;
  const startY = 120;
  const maxValue = Math.max(...items.map((i: any) => i.value));

  const bars = items.map((item: any, i: number) => {
    const y = startY + i * (barHeight + barGap);
    const barWidth = (item.value / maxValue) * (width - 200);
    return `
      <text x="60" y="${y + barHeight / 2 + 5}" font-family="system-ui, sans-serif" font-size="14" fill="${colors.textMuted}" text-anchor="end">${escapeXml(item.label)}</text>
      <rect x="80" y="${y}" width="${width - 160}" height="${barHeight}" rx="4" fill="${colors.bgEnd}" opacity="0.5"/>
      <rect x="80" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="${colors.accent}"/>
      <text x="${80 + barWidth - 10}" y="${y + barHeight / 2 + 5}" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="${colors.text}" text-anchor="end">${item.value}%</text>
    `;
  }).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect x="0" y="0" width="4" height="${height}" fill="${colors.accent}"/>
    <text x="60" y="60" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="700" fill="${colors.text}">${escapeXml(title.substring(0, 45))}</text>
    <line x1="60" y1="80" x2="200" y2="80" stroke="${colors.accent}" stroke-width="2" opacity="0.6"/>
    ${bars}
    <text x="${width - 40}" y="${height - 20}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

async function generateComparisonImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.comparison,
  width: number,
  height: number,
): Promise<Buffer> {
  const leftLabel = data?.left?.label || 'Before';
  const rightLabel = data?.right?.label || 'After';
  const leftItems = data?.left?.items || ['Manual process', 'Time-consuming', 'Error-prone'];
  const rightItems = data?.right?.items || ['Automated', 'Fast', 'Accurate'];

  const colWidth = (width - 100) / 2;
  const itemStartY = 130;
  const itemGap = 36;

  const leftItemsSvg = leftItems.slice(0, 4).map((item: string, i: number) => `
    <circle cx="70" cy="${itemStartY + i * itemGap}" r="6" fill="#ef4444" opacity="0.8"/>
    <text x="90" y="${itemStartY + i * itemGap + 5}" font-family="system-ui, sans-serif" font-size="14" fill="${colors.textMuted}">${escapeXml(item.substring(0, 25))}</text>
  `).join('');

  const rightItemsSvg = rightItems.slice(0, 4).map((item: string, i: number) => `
    <circle cx="${width / 2 + 30}" cy="${itemStartY + i * itemGap}" r="6" fill="${colors.accent}"/>
    <text x="${width / 2 + 50}" y="${itemStartY + i * itemGap + 5}" font-family="system-ui, sans-serif" font-size="14" fill="${colors.text}">${escapeXml(item.substring(0, 25))}</text>
  `).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <text x="${width / 2}" y="45" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${colors.text}" text-anchor="middle">${escapeXml(title.substring(0, 40))}</text>
    
    <!-- Divider -->
    <line x1="${width / 2}" y1="70" x2="${width / 2}" y2="${height - 40}" stroke="${colors.accent}" stroke-width="2" stroke-dasharray="6,4" opacity="0.5"/>
    
    <!-- Left column header -->
    <rect x="40" y="75" width="${colWidth - 20}" height="32" rx="6" fill="#ef4444" opacity="0.15"/>
    <text x="${40 + (colWidth - 20) / 2}" y="97" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#fca5a5" text-anchor="middle">${escapeXml(leftLabel)}</text>
    
    <!-- Right column header -->
    <rect x="${width / 2 + 20}" y="75" width="${colWidth - 20}" height="32" rx="6" fill="${colors.accent}" opacity="0.2"/>
    <text x="${width / 2 + 20 + (colWidth - 20) / 2}" y="97" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${colors.accentLight}" text-anchor="middle">${escapeXml(rightLabel)}</text>
    
    ${leftItemsSvg}
    ${rightItemsSvg}
    
    <text x="${width - 30}" y="${height - 15}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

async function generateWorkflowImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.workflow,
  width: number,
  height: number,
): Promise<Buffer> {
  const steps = data?.steps || ['Research', 'Plan', 'Execute', 'Review'];
  const stepWidth = (width - 100) / steps.length;
  const centerY = height / 2;

  const stepsSvg = steps.slice(0, 5).map((step: string, i: number) => {
    const x = 50 + i * stepWidth + stepWidth / 2;
    const isLast = i === steps.length - 1;
    return `
      <circle cx="${x}" cy="${centerY}" r="28" fill="${colors.accent}"/>
      <text x="${x}" y="${centerY + 6}" font-family="system-ui, sans-serif" font-size="18" font-weight="700" fill="${colors.bgStart}" text-anchor="middle">${i + 1}</text>
      <text x="${x}" y="${centerY + 55}" font-family="system-ui, sans-serif" font-size="13" fill="${colors.text}" text-anchor="middle">${escapeXml(step.substring(0, 12))}</text>
      ${!isLast ? `<line x1="${x + 35}" y1="${centerY}" x2="${x + stepWidth - 35}" y2="${centerY}" stroke="${colors.accentLight}" stroke-width="2" marker-end="url(#arrow)"/>` : ''}
    `;
  }).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
      <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill="${colors.accentLight}"/>
      </marker>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <text x="${width / 2}" y="45" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${colors.text}" text-anchor="middle">${escapeXml(title.substring(0, 45))}</text>
    ${stepsSvg}
    <text x="${width - 30}" y="${height - 15}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

async function generateQuoteImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.quote,
  width: number,
  height: number,
): Promise<Buffer> {
  const quote = data?.quote || title;
  const author = data?.author || '';
  const quoteLines = wrapText(quote, Math.floor(width / 18)).slice(0, 4);

  const quoteTspans = quoteLines.map((line, i) => 
    `<tspan x="${width / 2}" dy="${i === 0 ? 0 : 32}">${escapeXml(line)}</tspan>`
  ).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    
    <!-- Large quote mark -->
    <text x="50" y="90" font-family="Georgia, serif" font-size="120" fill="${colors.accent}" opacity="0.3">"</text>
    
    <!-- Quote text -->
    <text x="${width / 2}" y="${height / 2 - quoteLines.length * 16}" font-family="Georgia, serif" font-size="22" font-style="italic" fill="${colors.text}" text-anchor="middle">
      ${quoteTspans}
    </text>
    
    ${author ? `<text x="${width / 2}" y="${height - 50}" font-family="system-ui, sans-serif" font-size="14" fill="${colors.textMuted}" text-anchor="middle">— ${escapeXml(author)}</text>` : ''}
    
    <text x="${width - 30}" y="${height - 15}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

async function generateStatisticImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.statistic,
  width: number,
  height: number,
): Promise<Buffer> {
  const stats = data?.stats || [
    { value: '85%', label: 'Increase' },
    { value: '3x', label: 'Faster' },
    { value: '50+', label: 'Features' },
  ];

  const statWidth = (width - 80) / stats.length;
  const centerY = height / 2;

  const statsSvg = stats.slice(0, 4).map((stat: any, i: number) => {
    const x = 40 + i * statWidth + statWidth / 2;
    return `
      <text x="${x}" y="${centerY - 10}" font-family="system-ui, -apple-system, sans-serif" font-size="42" font-weight="800" fill="${colors.accent}" text-anchor="middle">${escapeXml(stat.value)}</text>
      <text x="${x}" y="${centerY + 25}" font-family="system-ui, sans-serif" font-size="14" fill="${colors.textMuted}" text-anchor="middle">${escapeXml(stat.label)}</text>
    `;
  }).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <text x="${width / 2}" y="50" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="600" fill="${colors.text}" text-anchor="middle">${escapeXml(title.substring(0, 50))}</text>
    <line x1="${width / 2 - 60}" y1="70" x2="${width / 2 + 60}" y2="70" stroke="${colors.accent}" stroke-width="2" opacity="0.5"/>
    ${statsSvg}
    <text x="${width - 30}" y="${height - 15}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

async function generateChecklistImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.checklist,
  width: number,
  height: number,
): Promise<Buffer> {
  const items = data?.items || ['Step one complete', 'Step two complete', 'Step three pending', 'Step four pending'];
  const checked = data?.checked || [true, true, false, false];

  const startY = 100;
  const itemGap = 40;

  const itemsSvg = items.slice(0, 5).map((item: string, i: number) => {
    const y = startY + i * itemGap;
    const isChecked = checked[i] ?? false;
    return `
      <rect x="50" y="${y - 12}" width="24" height="24" rx="4" fill="${isChecked ? colors.accent : 'transparent'}" stroke="${colors.accent}" stroke-width="2"/>
      ${isChecked ? `<path d="M55 ${y} l4 4 l8 -8" stroke="${colors.bgStart}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
      <text x="90" y="${y + 5}" font-family="system-ui, sans-serif" font-size="15" fill="${isChecked ? colors.text : colors.textMuted}" ${!isChecked ? 'opacity="0.7"' : ''}>${escapeXml(item.substring(0, 35))}</text>
    `;
  }).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <text x="50" y="55" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${colors.text}">${escapeXml(title.substring(0, 40))}</text>
    <line x1="50" y1="72" x2="180" y2="72" stroke="${colors.accent}" stroke-width="2" opacity="0.6"/>
    ${itemsSvg}
    <text x="${width - 30}" y="${height - 15}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

async function generateTimelineImage(
  title: string,
  data: any,
  colors: typeof INLINE_IMAGE_STYLES.timeline,
  width: number,
  height: number,
): Promise<Buffer> {
  const events = data?.events || [
    { label: 'Phase 1', desc: 'Research' },
    { label: 'Phase 2', desc: 'Development' },
    { label: 'Phase 3', desc: 'Launch' },
  ];

  const startX = 80;
  const endX = width - 80;
  const lineY = height / 2 + 20;
  const eventSpacing = (endX - startX) / (events.length - 1 || 1);

  const eventsSvg = events.slice(0, 5).map((event: any, i: number) => {
    const x = startX + i * eventSpacing;
    return `
      <circle cx="${x}" cy="${lineY}" r="10" fill="${colors.accent}"/>
      <circle cx="${x}" cy="${lineY}" r="5" fill="${colors.bgStart}"/>
      <text x="${x}" y="${lineY - 25}" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="${colors.text}" text-anchor="middle">${escapeXml(event.label)}</text>
      <text x="${x}" y="${lineY + 35}" font-family="system-ui, sans-serif" font-size="11" fill="${colors.textMuted}" text-anchor="middle">${escapeXml((event.desc || '').substring(0, 15))}</text>
    `;
  }).join('');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colors.bgStart}"/>
        <stop offset="100%" stop-color="${colors.bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <text x="${width / 2}" y="50" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="${colors.text}" text-anchor="middle">${escapeXml(title.substring(0, 45))}</text>
    
    <!-- Timeline line -->
    <line x1="${startX}" y1="${lineY}" x2="${endX}" y2="${lineY}" stroke="${colors.accent}" stroke-width="3" opacity="0.4"/>
    
    ${eventsSvg}
    
    <text x="${width - 30}" y="${height - 15}" font-family="system-ui, sans-serif" font-size="10" fill="${colors.textMuted}" text-anchor="end"></text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
}

/**
 * AI-driven image decision interface
 */
export interface AIImageDecision {
  shouldGenerateImage: boolean;
  reason: string;
  style?: InlineImageStyle;
  title?: string;
  data?: any;
}

/**
 * Sections that typically don't benefit from images
 */
const SKIP_IMAGE_PATTERNS = [
  /faq|frequently\s*asked/i,
  /conclusion|summary|wrap\s*up|final\s*thoughts/i,
  /introduction|overview|about\s*this/i,
  /table\s*of\s*contents/i,
  /disclaimer|legal|terms/i,
  /references|sources|citations/i,
];

/**
 * Check if a section should skip image generation based on title
 */
export function shouldSkipImageForSection(sectionTitle: string): boolean {
  return SKIP_IMAGE_PATTERNS.some(pattern => pattern.test(sectionTitle));
}

/**
 * Build the AI prompt for image decision
 */
export function buildImageDecisionPrompt(sectionTitle: string, sectionContent: string): string {
  return `Analyze this article section and decide if a visual image would add value.

SECTION TITLE: ${sectionTitle}

SECTION CONTENT (first 1500 chars):
${sectionContent.substring(0, 1500)}

AVAILABLE IMAGE STYLES:
1. "comparison" - Side-by-side comparison (e.g., Before/After, Tool A vs Tool B, Old way vs New way)
   - Requires: left.label, left.items[], right.label, right.items[]
2. "workflow" - Step-by-step process flow with numbered steps
   - Requires: steps[] (array of step names, max 5)
3. "statistic" - Key metrics/numbers display
   - Requires: stats[] (array of {value: "85%", label: "Increase"}, max 4)
4. "checklist" - Checklist with checked/unchecked items
   - Requires: items[] (array of strings), checked[] (array of booleans)
5. "timeline" - Timeline with phases/milestones
   - Requires: events[] (array of {label: "Phase 1", desc: "Description"}, max 5)
6. "infographic" - Bar chart showing metrics/percentages
   - Requires: items[] (array of {label: "Category", value: 85}, max 5)

DECISION RULES:
- Return shouldGenerateImage: false for FAQ sections, conclusions, introductions, or sections without visualizable data
- Only generate an image if the content has SPECIFIC data that can be visualized
- Extract ACTUAL data from the content - do NOT use generic placeholders
- The image title should be specific to the content, not generic

Respond with JSON only:
{
  "shouldGenerateImage": boolean,
  "reason": "Brief explanation of decision",
  "style": "comparison|workflow|statistic|checklist|timeline|infographic" (only if shouldGenerateImage is true),
  "title": "Specific title for the image based on content" (only if shouldGenerateImage is true),
  "data": { ... style-specific data extracted from content ... } (only if shouldGenerateImage is true)
}`;
}

/**
 * Parse AI response for image decision
 */
export function parseImageDecisionResponse(response: string): AIImageDecision {
  try {
    let cleaned = response.trim();
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      cleaned = jsonMatch[1].trim();
    }
    
    const parsed = JSON.parse(cleaned);
    
    if (typeof parsed.shouldGenerateImage !== 'boolean') {
      return { shouldGenerateImage: false, reason: 'Invalid AI response format' };
    }
    
    if (!parsed.shouldGenerateImage) {
      return { shouldGenerateImage: false, reason: parsed.reason || 'AI decided no image needed' };
    }
    
    const validStyles: InlineImageStyle[] = ['comparison', 'workflow', 'statistic', 'checklist', 'timeline', 'infographic'];
    if (!validStyles.includes(parsed.style)) {
      return { shouldGenerateImage: false, reason: `Invalid style: ${parsed.style}` };
    }
    
    return {
      shouldGenerateImage: true,
      reason: parsed.reason || 'AI decided image would add value',
      style: parsed.style,
      title: parsed.title || 'Visual Summary',
      data: parsed.data,
    };
  } catch (err) {
    return { shouldGenerateImage: false, reason: `Failed to parse AI response: ${(err as Error).message}` };
  }
}

/**
 * Validate and sanitize image data based on style
 */
export function validateImageData(style: InlineImageStyle, data: any): any {
  if (!data) return getDefaultDataForStyle(style);
  
  switch (style) {
    case 'comparison': {
      const left = data.left || {};
      const right = data.right || {};
      return {
        left: {
          label: String(left.label || 'Before').substring(0, 20),
          items: Array.isArray(left.items) ? left.items.slice(0, 4).map((s: any) => String(s).substring(0, 30)) : ['Item 1', 'Item 2'],
        },
        right: {
          label: String(right.label || 'After').substring(0, 20),
          items: Array.isArray(right.items) ? right.items.slice(0, 4).map((s: any) => String(s).substring(0, 30)) : ['Item 1', 'Item 2'],
        },
      };
    }
    case 'workflow': {
      const steps = Array.isArray(data.steps) ? data.steps.slice(0, 5).map((s: any) => String(s).substring(0, 20)) : ['Step 1', 'Step 2', 'Step 3'];
      return { steps };
    }
    case 'statistic': {
      const stats = Array.isArray(data.stats) ? data.stats.slice(0, 4).map((s: any) => ({
        value: String(s.value || '0').substring(0, 10),
        label: String(s.label || 'Metric').substring(0, 20),
      })) : [{ value: '85%', label: 'Improvement' }];
      return { stats };
    }
    case 'checklist': {
      const items = Array.isArray(data.items) ? data.items.slice(0, 5).map((s: any) => String(s).substring(0, 35)) : ['Item 1', 'Item 2'];
      const checked = Array.isArray(data.checked) ? data.checked.slice(0, 5) : items.map(() => true);
      return { items, checked };
    }
    case 'timeline': {
      const events = Array.isArray(data.events) ? data.events.slice(0, 5).map((e: any) => ({
        label: String(e.label || 'Phase').substring(0, 15),
        desc: String(e.desc || '').substring(0, 20),
      })) : [{ label: 'Phase 1', desc: 'Start' }];
      return { events };
    }
    case 'infographic': {
      const items = Array.isArray(data.items) ? data.items.slice(0, 5).map((i: any) => ({
        label: String(i.label || 'Category').substring(0, 20),
        value: Math.min(100, Math.max(0, Number(i.value) || 50)),
      })) : [{ label: 'Category', value: 75 }];
      return { items };
    }
    default:
      return data;
  }
}

/**
 * Get default data for a style (fallback)
 */
function getDefaultDataForStyle(style: InlineImageStyle): any {
  switch (style) {
    case 'comparison':
      return {
        left: { label: 'Before', items: ['Manual process', 'Time-consuming'] },
        right: { label: 'After', items: ['Automated', 'Efficient'] },
      };
    case 'workflow':
      return { steps: ['Plan', 'Execute', 'Review'] };
    case 'statistic':
      return { stats: [{ value: '85%', label: 'Improvement' }] };
    case 'checklist':
      return { items: ['Task 1', 'Task 2'], checked: [true, false] };
    case 'timeline':
      return { events: [{ label: 'Phase 1', desc: 'Start' }, { label: 'Phase 2', desc: 'Complete' }] };
    case 'infographic':
      return { items: [{ label: 'Metric', value: 75 }] };
    default:
      return {};
  }
}

/**
 * @deprecated Use AI-driven image decisions instead
 * Legacy function kept for backward compatibility
 */
export function detectInlineImageStyle(sectionTitle: string, sectionContent: string): InlineImageStyle {
  const text = `${sectionTitle} ${sectionContent}`.toLowerCase();

  if (/(?:vs\.?|versus|compar|alternative|difference|before.*after|old.*new)/i.test(text)) {
    return 'comparison';
  }
  if (/(?:step|process|workflow|how to|guide|tutorial|phase)/i.test(text)) {
    return 'workflow';
  }
  if (/(?:quote|said|according to|expert|opinion)/i.test(text)) {
    return 'quote';
  }
  if (/(?:\d+%|\d+x|increase|decrease|growth|metric|statistic|number|data)/i.test(text)) {
    return 'statistic';
  }
  if (/(?:checklist|todo|task|requirement|must|should|need)/i.test(text)) {
    return 'checklist';
  }
  if (/(?:timeline|roadmap|milestone|schedule|plan|phase)/i.test(text)) {
    return 'timeline';
  }

  return 'infographic';
}

/**
 * @deprecated Use AI-driven image decisions instead
 * Legacy function kept for backward compatibility
 */
export function extractInlineImageData(style: InlineImageStyle, content: string): any {
  switch (style) {
    case 'comparison': {
      const items = content.match(/[-•]\s*([^\n]+)/g)?.slice(0, 4).map(s => s.replace(/^[-•]\s*/, '')) || [];
      const midpoint = Math.ceil(items.length / 2);
      return {
        left: { label: 'Before', items: items.slice(0, midpoint) },
        right: { label: 'After', items: items.slice(midpoint) },
      };
    }
    case 'workflow': {
      const steps = content.match(/(?:step\s*\d+[:\s]*|^\d+\.\s*)([^\n]+)/gim)?.slice(0, 5).map(s => 
        s.replace(/^(?:step\s*\d+[:\s]*|\d+\.\s*)/i, '').trim()
      ) || ['Plan', 'Execute', 'Review'];
      return { steps };
    }
    case 'statistic': {
      const stats: { value: string; label: string }[] = [];
      const matches = content.matchAll(/(\d+[%x+]?|\$[\d,]+)\s*(?:[-–—]\s*)?([^\n,]+)/g);
      for (const match of matches) {
        if (stats.length >= 4) break;
        stats.push({ value: match[1], label: match[2].trim().substring(0, 20) });
      }
      return { stats: stats.length > 0 ? stats : undefined };
    }
    case 'checklist': {
      const items = content.match(/[-•✓✗☐☑]\s*([^\n]+)/g)?.slice(0, 5).map(s => s.replace(/^[-•✓✗☐☑]\s*/, '')) || [];
      const checked = items.map((_, i) => i < Math.ceil(items.length / 2));
      return { items, checked };
    }
    case 'timeline': {
      const events = content.match(/(?:phase|step|stage|milestone)\s*\d*[:\s]*([^\n]+)/gi)?.slice(0, 5).map((s, i) => ({
        label: `Phase ${i + 1}`,
        desc: s.replace(/^(?:phase|step|stage|milestone)\s*\d*[:\s]*/i, '').trim().substring(0, 20),
      })) || [];
      return { events: events.length > 0 ? events : undefined };
    }
    default:
      return undefined;
  }
}
