/**
 * Generate positioning matrix SVG for compare pages
 * Can be converted to PNG or used directly as SVG
 */

export function generatePositioningMatrixSVG(): string {
  const width = 1200;
  const height = 1200;
  const padding = 120;

  const gridLeft = padding;
  const gridRight = width - padding;
  const gridTop = padding;
  const gridBottom = height - padding;
  const gridWidth = gridRight - gridLeft;
  const gridHeight = gridBottom - gridTop;
  const centerX = gridLeft + gridWidth / 2;
  const centerY = gridTop + gridHeight / 2;

  // Trndinn position (high SEO depth, low channel breadth)
  const trndinnX = gridLeft + gridWidth * 0.3;
  const trndinnY = gridTop + gridHeight * 0.25;

  // Postiz position (low SEO depth, high channel breadth)
  const postizX = gridLeft + gridWidth * 0.75;
  const postizY = gridTop + gridHeight * 0.7;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  
  <!-- Grid lines (light) -->
  <line x1="${centerX}" y1="${gridTop}" x2="${centerX}" y2="${gridBottom}" 
        stroke="#e2e8f0" stroke-width="1"/>
  <line x1="${gridLeft}" y1="${centerY}" x2="${gridRight}" y2="${centerY}" 
        stroke="#e2e8f0" stroke-width="1"/>
  
  <!-- Main axes -->
  <line x1="${gridLeft}" y1="${gridTop}" x2="${gridLeft}" y2="${gridBottom}" 
        stroke="#94a3b8" stroke-width="2"/>
  <line x1="${gridLeft}" y1="${gridBottom}" x2="${gridRight}" y2="${gridBottom}" 
        stroke="#94a3b8" stroke-width="2"/>
  
  <!-- Y-axis label (rotated) -->
  <text x="30" y="${centerY}" transform="rotate(-90 30 ${centerY})" 
        font-family="sans-serif" font-size="18" font-weight="bold" 
        fill="#64748b" text-anchor="middle">
    SEO / Content Depth
  </text>
  
  <!-- Y-axis markers -->
  <text x="${gridLeft - 20}" y="${gridTop + 20}" 
        font-family="sans-serif" font-size="16" fill="#64748b" text-anchor="end">
    High
  </text>
  <text x="${gridLeft - 20}" y="${gridBottom - 10}" 
        font-family="sans-serif" font-size="16" fill="#64748b" text-anchor="end">
    Low
  </text>
  
  <!-- X-axis label -->
  <text x="${centerX}" y="${height - 40}" 
        font-family="sans-serif" font-size="18" font-weight="bold" 
        fill="#64748b" text-anchor="middle">
    Channel Breadth
  </text>
  
  <!-- X-axis markers -->
  <text x="${gridLeft + 40}" y="${gridBottom + 30}" 
        font-family="sans-serif" font-size="16" fill="#64748b" text-anchor="middle">
    Low
  </text>
  <text x="${gridRight - 40}" y="${gridBottom + 30}" 
        font-family="sans-serif" font-size="16" fill="#64748b" text-anchor="middle">
    High
  </text>
  
  <!-- Trndinn point with gradient -->
  <defs>
    <radialGradient id="trndinnGradient" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#ff8a1f;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ff3d39;stop-opacity:1" />
    </radialGradient>
  </defs>
  
  <circle cx="${trndinnX}" cy="${trndinnY}" r="18" fill="url(#trndinnGradient)"/>
  
  <!-- Trndinn label -->
  <text x="${trndinnX}" y="${trndinnY - 35}" 
        font-family="sans-serif" font-size="24" font-weight="bold" 
        fill="#1e293b" text-anchor="middle">
    Trndinn
  </text>
  <text x="${trndinnX}" y="${trndinnY - 12}" 
        font-family="sans-serif" font-size="16" 
        fill="#64748b" text-anchor="middle">
    Agentic Growth OS
  </text>
  
  <!-- Postiz point -->
  <circle cx="${postizX}" cy="${postizY}" r="18" fill="#64748b"/>
  
  <!-- Postiz label -->
  <text x="${postizX}" y="${postizY - 35}" 
        font-family="sans-serif" font-size="24" font-weight="bold" 
        fill="#1e293b" text-anchor="middle">
    Postiz
  </text>
  <text x="${postizX}" y="${postizY - 12}" 
        font-family="sans-serif" font-size="16" 
        fill="#64748b" text-anchor="middle">
    Agentic Scheduler
  </text>
  
  <!-- Border -->
  <rect width="${width}" height="${height}" fill="none" stroke="#e2e8f0" stroke-width="2"/>
</svg>`;
}

// Export as module
export default generatePositioningMatrixSVG;
