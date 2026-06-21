import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MinioService } from '../src/services/minio.service';

/**
 * Upload positioning matrix to MinIO blog/ folder
 * Usage: ts-node scripts/upload-positioning-matrix.ts
 */

async function main() {
  console.log('📤 Uploading positioning matrix to MinIO...');
  
  // Bootstrap NestJS app to access MinioService
  const app = await NestFactory.createApplicationContext(AppModule);
  const minioService = app.get(MinioService);
  
  const imageDir = path.join(__dirname, '../../frontend/public/images');
  const pngPath = path.join(imageDir, 'positioning-matrix.png');
  const svgPath = path.join(imageDir, 'positioning-matrix.svg');
  
  // Upload PNG
  if (fs.existsSync(pngPath)) {
    const pngBuffer = fs.readFileSync(pngPath);
    const pngUrl = await minioService.uploadFile(
      'contentos-media',
      'blog/positioning-matrix.png',
      pngBuffer,
      'image/png'
    );
    console.log(`✓ Uploaded PNG: ${pngUrl}`);
  } else {
    console.error(`❌ PNG not found: ${pngPath}`);
  }
  
  // Upload SVG
  if (fs.existsSync(svgPath)) {
    const svgBuffer = fs.readFileSync(svgPath);
    const svgUrl = await minioService.uploadFile(
      'contentos-media',
      'blog/positioning-matrix.svg',
      svgBuffer,
      'image/svg+xml'
    );
    console.log(`✓ Uploaded SVG: ${svgUrl}`);
  } else {
    console.error(`❌ SVG not found: ${svgPath}`);
  }
  
  await app.close();
  
  console.log('\n📋 MinIO URLs:');
  console.log('PNG: /api/minio-proxy/contentos-media/blog/positioning-matrix.png');
  console.log('SVG: /api/minio-proxy/contentos-media/blog/positioning-matrix.svg');
  console.log('\nNext: Update PositioningMatrix.tsx to use these URLs');
}

if (require.main === module) {
  main()
    .then(() => {
      console.log('\n✅ Upload complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Upload failed:', error);
      process.exit(1);
    });
}
