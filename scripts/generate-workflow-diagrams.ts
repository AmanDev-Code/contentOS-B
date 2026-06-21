import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

/**
 * Generate Content Engine workflow diagrams
 * 1. Distribution Loop (blog post to 31 platforms)
 * 2. Content Engine Pipeline (research → newsletter)
 */

function generateDistributionLoopSVG(): string {
  const width = 1000;
  const height = 900;
  const stepHeight = 80;
  const stepWidth = 700;
  const startY = 80;
  const startX = (width - stepWidth) / 2;
  
  const steps = [
    { label: 'Keywords &amp; clusters', color: '#ff8a1f' },
    { label: 'SEO article draft', color: '#ff8a1f' },
    { label: 'Quality scoring (SEO/AEO/GEO/E-E-A-T)', color: '#ff6b3d' },
    { label: 'Internal links + schema (JSON-LD)', color: '#ff6b3d' },
    { label: 'Platform-adapted copies (agents)', color: '#ff3d39' },
    { label: '31 distribution targets (tiered)', color: '#ff3d39' },
    { label: 'Newsletter campaign', color: '#ff3d39' },
    { label: 'LinkedIn schedule + publish (live)', color: '#6366f1' },
  ];
  
  let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  
  <!-- Title -->
  <text x="${width/2}" y="40" font-family="sans-serif" font-size="24" font-weight="bold" 
        fill="#1e293b" text-anchor="middle">
    Agentic Distribution Loop
  </text>
  
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#64748b" />
    </marker>
  </defs>
`;
  
  steps.forEach((step, index) => {
    const y = startY + index * 100;
    const boxY = y;
    const boxHeight = stepHeight;
    
    // Step box
    svgContent += `
  <!-- Step ${index + 1} -->
  <rect x="${startX}" y="${boxY}" width="${stepWidth}" height="${boxHeight}" 
        rx="12" fill="${step.color}" opacity="0.15" stroke="${step.color}" stroke-width="2"/>
  <text x="${width/2}" y="${boxY + boxHeight/2 + 6}" 
        font-family="sans-serif" font-size="18" font-weight="600" 
        fill="#1e293b" text-anchor="middle">
    ${step.label}
  </text>
`;
    
    // Arrow to next step
    if (index < steps.length - 1) {
      const arrowStartY = boxY + boxHeight;
      const arrowEndY = boxY + boxHeight + 20;
      svgContent += `
  <line x1="${width/2}" y1="${arrowStartY}" x2="${width/2}" y2="${arrowEndY}" 
        stroke="#64748b" stroke-width="2" marker-end="url(#arrowhead)"/>
`;
    }
  });
  
  // Footer note
  svgContent += `
  <text x="${width/2}" y="${height - 30}" font-family="sans-serif" font-size="14" 
        fill="#64748b" text-anchor="middle">
    Agent-assisted with human approval gates
  </text>
</svg>`;
  
  return svgContent;
}

function generateContentEnginePipelineSVG(): string {
  const width = 1400;
  const height = 400;
  
  const phases = [
    { name: 'Research', detail: 'Keywords\nClusters', color: '#ff8a1f' },
    { name: 'Generate', detail: 'Generate\nwizard', color: '#ff8a1f' },
    { name: 'Publish', detail: 'Articles\n+ CMS', color: '#ff6b3d' },
    { name: 'Distribute', detail: 'Distribution\n(31 platforms)', color: '#ff6b3d' },
    { name: 'Link', detail: 'Internal\nLinks', color: '#ff3d39' },
    { name: 'Optimize', detail: 'Optimization\nAEO/GEO', color: '#ff3d39' },
    { name: 'Track', detail: 'Rank\nTracking', color: '#6366f1' },
    { name: 'Newsletter', detail: 'Newsletter', color: '#6366f1' },
  ];
  
  const boxWidth = 140;
  const boxHeight = 140;
  const spacing = 30;
  const startX = 50;
  const startY = 120;
  
  let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  
  <!-- Title -->
  <text x="${width/2}" y="40" font-family="sans-serif" font-size="24" font-weight="bold" 
        fill="#1e293b" text-anchor="middle">
    Content Engine Pipeline
  </text>
  
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#94a3b8" />
    </marker>
  </defs>
`;
  
  phases.forEach((phase, index) => {
    const x = startX + index * (boxWidth + spacing);
    
    // Phase box
    svgContent += `
  <!-- ${phase.name} -->
  <rect x="${x}" y="${startY}" width="${boxWidth}" height="${boxHeight}" 
        rx="12" fill="${phase.color}" opacity="0.15" stroke="${phase.color}" stroke-width="2"/>
  <text x="${x + boxWidth/2}" y="${startY + 45}" 
        font-family="sans-serif" font-size="16" font-weight="bold" 
        fill="#1e293b" text-anchor="middle">
    ${phase.name}
  </text>
`;
    
    // Detail text (multi-line)
    const detailLines = phase.detail.split('\n');
    detailLines.forEach((line, lineIndex) => {
      svgContent += `
  <text x="${x + boxWidth/2}" y="${startY + 75 + lineIndex * 20}" 
        font-family="sans-serif" font-size="13" 
        fill="#64748b" text-anchor="middle">
    ${line}
  </text>
`;
    });
    
    // Arrow to next phase
    if (index < phases.length - 1) {
      const arrowStartX = x + boxWidth;
      const arrowEndX = x + boxWidth + spacing;
      svgContent += `
  <line x1="${arrowStartX}" y1="${startY + boxHeight/2}" 
        x2="${arrowEndX}" y2="${startY + boxHeight/2}" 
        stroke="#94a3b8" stroke-width="2" marker-end="url(#arrow)"/>
`;
    }
  });
  
  svgContent += `
</svg>`;
  
  return svgContent;
}

async function main() {
  console.log('🎨 Generating Content Engine workflow diagrams...');
  
  const outputDir = path.join(__dirname, '../../frontend/public/images');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Generate Distribution Loop
  const distributionSVG = generateDistributionLoopSVG();
  const distributionPNG = await sharp(Buffer.from(distributionSVG))
    .png({ quality: 100, compressionLevel: 9 })
    .toBuffer();
  
  fs.writeFileSync(path.join(outputDir, 'distribution-loop.svg'), distributionSVG);
  fs.writeFileSync(path.join(outputDir, 'distribution-loop.png'), distributionPNG);
  console.log(`✓ Distribution Loop: ${distributionPNG.length} bytes`);
  
  // Generate Content Engine Pipeline
  const pipelineSVG = generateContentEnginePipelineSVG();
  const pipelinePNG = await sharp(Buffer.from(pipelineSVG))
    .png({ quality: 100, compressionLevel: 9 })
    .toBuffer();
  
  fs.writeFileSync(path.join(outputDir, 'content-engine-pipeline.svg'), pipelineSVG);
  fs.writeFileSync(path.join(outputDir, 'content-engine-pipeline.png'), pipelinePNG);
  console.log(`✓ Content Engine Pipeline: ${pipelinePNG.length} bytes`);
  
  console.log('\n📋 Generated diagrams:');
  console.log('- distribution-loop.png/.svg');
  console.log('- content-engine-pipeline.png/.svg');
}

if (require.main === module) {
  main()
    .then(() => {
      console.log('\n✅ Complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Error:', error);
      process.exit(1);
    });
}
