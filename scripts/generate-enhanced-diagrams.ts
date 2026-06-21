/**
 * Enhanced Blog Image Generation
 * Generates actual visual content (diagrams, charts, workflows) instead of gradients
 * 
 * Supports:
 * - Comparison charts (side-by-side bars)
 * - Workflow diagrams (boxes with arrows)
 * - Process flows (numbered steps)
 * - Data visualizations (bar charts, pie charts)
 * 
 * Run with: npx tsx scripts/generate-enhanced-diagrams.ts
 */

import { createCanvas, registerFont } from 'canvas';
import { Client as MinioClient } from 'minio';
import path from 'path';

// MinIO config
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000');
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET_NAME || 'contentos-media';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000';

// Trndinn brand colors
const COLORS = {
  primary: '#6366f1',      // Indigo
  secondary: '#8b5cf6',    // Purple
  accent: '#ff8a1f',       // Orange
  success: '#10b981',      // Green
  background: '#ffffff',
  text: '#1e293b',
  textMuted: '#64748b',
  border: '#e2e8f0',
};

const minioClient = new MinioClient({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

interface ComparisonData {
  title: string;
  items: Array<{
    label: string;
    value: number;
    color?: string;
  }>;
}

interface WorkflowStep {
  title: string;
  description: string;
}

interface ProcessStep {
  number: number;
  title: string;
  subtitle?: string;
}

/**
 * Generate a comparison chart (horizontal bars)
 */
function generateComparisonChart(data: ComparisonData, width = 1000, height = 600): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 32px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(data.title, width / 2, 60);

  // Chart area
  const chartX = 150;
  const chartY = 120;
  const chartWidth = width - 300;
  const chartHeight = height - 180;
  const barHeight = (chartHeight / data.items.length) - 20;
  const maxValue = Math.max(...data.items.map(i => i.value));

  data.items.forEach((item, index) => {
    const y = chartY + (index * (barHeight + 20));
    const barWidth = (item.value / maxValue) * chartWidth;
    const color = item.color || [COLORS.primary, COLORS.accent, COLORS.secondary, COLORS.success][index % 4];

    // Label
    ctx.fillStyle = COLORS.text;
    ctx.font = '18px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(item.label, chartX - 10, y + barHeight / 2 + 6);

    // Bar background
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(chartX, y, chartWidth, barHeight);

    // Bar
    ctx.fillStyle = color;
    ctx.fillRect(chartX, y, barWidth, barHeight);

    // Value
    ctx.fillStyle = COLORS.background;
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(`${item.value}%`, chartX + barWidth - 60, y + barHeight / 2 + 6);
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

/**
 * Generate a workflow diagram (boxes with arrows)
 */
function generateWorkflowDiagram(steps: WorkflowStep[], width = 1200, height = 800): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Calculate layout
  const cols = Math.min(steps.length, 3);
  const rows = Math.ceil(steps.length / cols);
  const boxWidth = 300;
  const boxHeight = 120;
  const padding = 80;
  const startX = (width - (cols * boxWidth + (cols - 1) * padding)) / 2;
  const startY = (height - (rows * boxHeight + (rows - 1) * 80)) / 2;

  steps.forEach((step, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = startX + col * (boxWidth + padding);
    const y = startY + row * (boxHeight + 80);

    // Box shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(x + 4, y + 4, boxWidth, boxHeight);

    // Box
    const gradient = ctx.createLinearGradient(x, y, x, y + boxHeight);
    gradient.addColorStop(0, COLORS.primary);
    gradient.addColorStop(1, COLORS.secondary);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, boxWidth, boxHeight);

    // Border
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, boxWidth, boxHeight);

    // Step number
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(`${index + 1}`, x + boxWidth - 15, y + 50);

    // Title
    ctx.fillStyle = COLORS.background;
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'left';
    wrapText(ctx, step.title, x + 20, y + 40, boxWidth - 80, 24);

    // Description
    ctx.font = '14px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    wrapText(ctx, step.description, x + 20, y + 70, boxWidth - 40, 18);

    // Arrow to next step
    if (col < cols - 1 && index < steps.length - 1) {
      drawArrow(
        ctx,
        x + boxWidth,
        y + boxHeight / 2,
        x + boxWidth + padding,
        y + boxHeight / 2,
        COLORS.textMuted
      );
    } else if (col === cols - 1 && index < steps.length - 1) {
      // Down arrow for end of row
      drawArrow(
        ctx,
        x + boxWidth / 2,
        y + boxHeight,
        x + boxWidth / 2,
        y + boxHeight + 40,
        COLORS.textMuted
      );
    }
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

/**
 * Generate a process flow (vertical numbered steps)
 */
function generateProcessFlow(steps: ProcessStep[], width = 1000, height = 900): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background with subtle gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#ffffff');
  bgGradient.addColorStop(1, '#f8fafc');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  const stepHeight = 120;
  const startY = 80;
  const centerX = width / 2;

  steps.forEach((step, index) => {
    const y = startY + index * 150;

    // Connecting line
    if (index > 0) {
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 5]);
      ctx.beginPath();
      ctx.moveTo(centerX, y - 30);
      ctx.lineTo(centerX, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Step circle
    ctx.fillStyle = COLORS.primary;
    ctx.beginPath();
    ctx.arc(centerX, y, 40, 0, Math.PI * 2);
    ctx.fill();

    // Step number
    ctx.fillStyle = COLORS.background;
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(step.number.toString(), centerX, y);

    // Step title
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(step.title, centerX, y + 60);

    // Subtitle
    if (step.subtitle) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '16px Arial';
      ctx.fillText(step.subtitle, centerX, y + 92);
    }
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

/**
 * Generate a data visualization (bar chart)
 */
function generateDataVisualization(
  data: { label: string; value: number }[],
  title: string,
  width = 1000,
  height = 600
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

  // Chart area
  const chartX = 100;
  const chartY = 100;
  const chartWidth = width - 200;
  const chartHeight = height - 200;
  const barWidth = (chartWidth / data.length) - 20;
  const maxValue = Math.max(...data.map(d => d.value));

  data.forEach((item, index) => {
    const x = chartX + index * (barWidth + 20);
    const barHeightPx = (item.value / maxValue) * chartHeight;
    const y = chartY + chartHeight - barHeightPx;

    // Bar gradient
    const gradient = ctx.createLinearGradient(x, y, x, chartY + chartHeight);
    gradient.addColorStop(0, COLORS.primary);
    gradient.addColorStop(1, COLORS.accent);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, barHeightPx);

    // Value on top
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(item.value.toString(), x + barWidth / 2, y - 10);

    // Label at bottom
    ctx.save();
    ctx.translate(x + barWidth / 2, chartY + chartHeight + 15);
    ctx.rotate(-Math.PI / 6);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '14px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(item.label, 0, 0);
    ctx.restore();
  });

  // Baseline
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(chartX, chartY + chartHeight);
  ctx.lineTo(chartX + chartWidth, chartY + chartHeight);
  ctx.stroke();

  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

/**
 * Helper: Draw arrow
 */
function drawArrow(
  ctx: any,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string
) {
  const headLength = 12;
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;

  // Line
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLength * Math.cos(angle - Math.PI / 6),
    toY - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    toX - headLength * Math.cos(angle + Math.PI / 6),
    toY - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * Helper: Wrap text
 */
function wrapText(
  ctx: any,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(' ');
  let line = '';
  let currentY = y;

  for (const word of words) {
    const testLine = line + word + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && line !== '') {
      ctx.fillText(line, x, currentY);
      line = word + ' ';
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, currentY);
}

/**
 * Upload image to MinIO
 */
async function uploadToMinio(buffer: Buffer, filename: string): Promise<string> {
  const objectKey = `blog/${filename}`;

  await minioClient.putObject(MINIO_BUCKET, objectKey, buffer, buffer.length, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000',
  });

  const publicUrl = `${MINIO_PUBLIC_URL}/${MINIO_BUCKET}/${objectKey}`;
  return publicUrl;
}

/**
 * Main: Generate sample diagrams
 */
async function main() {
  console.log('🎨 Generating enhanced blog diagrams...\n');

  try {
    // Check MinIO connection
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      console.error(`❌ MinIO bucket "${MINIO_BUCKET}" does not exist`);
      process.exit(1);
    }
    console.log(`✅ Connected to MinIO bucket: ${MINIO_BUCKET}\n`);

    // 1. Comparison Chart: Trndinn vs Competitors
    console.log('📊 Generating comparison chart...');
    const comparisonData: ComparisonData = {
      title: 'Feature Comparison: Trndinn vs Competition',
      items: [
        { label: 'AI Content Generation', value: 95, color: COLORS.primary },
        { label: 'Multi-platform Support', value: 85, color: COLORS.accent },
        { label: 'Analytics Dashboard', value: 90, color: COLORS.secondary },
        { label: 'Ease of Use', value: 92, color: COLORS.success },
      ],
    };
    const comparisonBuffer = generateComparisonChart(comparisonData);
    const comparisonUrl = await uploadToMinio(comparisonBuffer, 'comparison-chart-trndinn.jpg');
    console.log(`  ✅ ${comparisonUrl}\n`);

    // 2. Workflow Diagram: Content Distribution
    console.log('🔄 Generating workflow diagram...');
    const workflowSteps: WorkflowStep[] = [
      {
        title: 'Content Research',
        description: 'Keyword analysis & topic planning',
      },
      {
        title: 'AI Generation',
        description: 'Create posts with brand voice',
      },
      {
        title: 'Review & Edit',
        description: 'Human approval & refinement',
      },
      {
        title: 'Schedule',
        description: 'Optimal timing across platforms',
      },
      {
        title: 'Publish',
        description: 'Auto-publish to social channels',
      },
      {
        title: 'Analytics',
        description: 'Track engagement & performance',
      },
    ];
    const workflowBuffer = generateWorkflowDiagram(workflowSteps);
    const workflowUrl = await uploadToMinio(workflowBuffer, 'content-workflow-diagram.jpg');
    console.log(`  ✅ ${workflowUrl}\n`);

    // 3. Process Flow: Getting Started
    console.log('📝 Generating process flow...');
    const processSteps: ProcessStep[] = [
      { number: 1, title: 'Connect LinkedIn', subtitle: 'OAuth in 30 seconds' },
      { number: 2, title: 'Set Brand Voice', subtitle: 'Paste 2-3 example posts' },
      { number: 3, title: 'Generate Content', subtitle: 'AI creates multiple variants' },
      { number: 4, title: 'Schedule & Publish', subtitle: 'Auto-post at optimal times' },
      { number: 5, title: 'Track Performance', subtitle: 'Monitor engagement metrics' },
    ];
    const processBuffer = generateProcessFlow(processSteps);
    const processUrl = await uploadToMinio(processBuffer, 'getting-started-process.jpg');
    console.log(`  ✅ ${processUrl}\n`);

    // 4. Data Visualization: Platform Growth
    console.log('📈 Generating data visualization...');
    const chartData = [
      { label: 'LinkedIn', value: 87 },
      { label: 'Twitter', value: 73 },
      { label: 'Instagram', value: 65 },
      { label: 'Facebook', value: 58 },
    ];
    const chartBuffer = generateDataVisualization(
      chartData,
      'Engagement Rates by Platform (%)',
    );
    const chartUrl = await uploadToMinio(chartBuffer, 'platform-engagement-chart.jpg');
    console.log(`  ✅ ${chartUrl}\n`);

    console.log('🎉 Enhanced diagram generation complete!\n');
    console.log('📋 Generated Images:');
    console.log(`   - ${comparisonUrl}`);
    console.log(`   - ${workflowUrl}`);
    console.log(`   - ${processUrl}`);
    console.log(`   - ${chartUrl}`);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Export for use in other scripts
export {
  generateComparisonChart,
  generateWorkflowDiagram,
  generateProcessFlow,
  generateDataVisualization,
  uploadToMinio,
  type ComparisonData,
  type WorkflowStep,
  type ProcessStep,
};

if (require.main === module) {
  main().then(() => process.exit(0));
}
