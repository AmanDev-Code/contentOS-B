import * as fs from 'fs';
import * as path from 'path';
import { Client as MinioClient } from 'minio';
import * as dotenv from 'dotenv';

/**
 * Upload positioning matrix to MinIO blog/ folder
 * Usage: ts-node scripts/upload-positioning-matrix-simple.ts
 */

// Load environment variables
dotenv.config();

async function main() {
  console.log('📤 Uploading positioning matrix to MinIO...');
  
  // Initialize MinIO client
  const minioClient = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || '',
  });
  
  const bucketName = 'contentos-media';
  
  // Ensure bucket exists
  const bucketExists = await minioClient.bucketExists(bucketName);
  if (!bucketExists) {
    console.log(`Creating bucket: ${bucketName}`);
    await minioClient.makeBucket(bucketName, 'us-east-1');
  }
  
  const imageDir = path.join(__dirname, '../../frontend/public/images');
  const pngPath = path.join(imageDir, 'positioning-matrix.png');
  const svgPath = path.join(imageDir, 'positioning-matrix.svg');
  
  const filesToUpload = [
    { local: 'positioning-matrix.png', remote: 'blog/positioning-matrix.png', type: 'image/png' },
    { local: 'positioning-matrix.svg', remote: 'blog/positioning-matrix.svg', type: 'image/svg+xml' },
    { local: 'distribution-loop.png', remote: 'blog/distribution-loop.png', type: 'image/png' },
    { local: 'distribution-loop.svg', remote: 'blog/distribution-loop.svg', type: 'image/svg+xml' },
    { local: 'content-engine-pipeline.png', remote: 'blog/content-engine-pipeline.png', type: 'image/png' },
    { local: 'content-engine-pipeline.svg', remote: 'blog/content-engine-pipeline.svg', type: 'image/svg+xml' },
  ];
  
  // Upload all files
  for (const file of filesToUpload) {
    const localPath = path.join(imageDir, file.local);
    if (fs.existsSync(localPath)) {
      await minioClient.fPutObject(
        bucketName,
        file.remote,
        localPath,
        {
          'Content-Type': file.type,
          'Cache-Control': 'max-age=31536000',
        }
      );
      console.log(`✓ Uploaded: ${file.remote}`);
    } else {
      console.error(`❌ Not found: ${localPath}`);
    }
  }
  
  console.log('\n📋 MinIO URLs (via proxy):');
  console.log('Positioning Matrix:');
  console.log('  PNG: /api/minio-proxy/contentos-media/blog/positioning-matrix.png');
  console.log('  SVG: /api/minio-proxy/contentos-media/blog/positioning-matrix.svg');
  console.log('Distribution Loop:');
  console.log('  PNG: /api/minio-proxy/contentos-media/blog/distribution-loop.png');
  console.log('  SVG: /api/minio-proxy/contentos-media/blog/distribution-loop.svg');
  console.log('Content Engine Pipeline:');
  console.log('  PNG: /api/minio-proxy/contentos-media/blog/content-engine-pipeline.png');
  console.log('  SVG: /api/minio-proxy/contentos-media/blog/content-engine-pipeline.svg');
  console.log('\nNext: Update markdown docs and blog posts to use these URLs');
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
