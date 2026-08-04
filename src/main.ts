import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import multipart from '@fastify/multipart';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';

// Decode GCP credentials from base64 env var (Coolify secret) → temp file
if (process.env.GOOGLE_CLOUD_STT_CREDENTIALS_BASE64 && !process.env.GOOGLE_CLOUD_STT_CREDENTIALS_PATH) {
  const decoded = Buffer.from(process.env.GOOGLE_CLOUD_STT_CREDENTIALS_BASE64, 'base64').toString('utf-8');
  const credPath = path.join('/tmp', 'gcp-stt-credentials.json');
  fs.writeFileSync(credPath, decoded, { mode: 0o600 });
  process.env.GOOGLE_CLOUD_STT_CREDENTIALS_PATH = credPath;
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      bodyLimit: 104857600, // 100MB limit for JSON/text bodies (multipart has its own limit)
    }),
    { rawBody: true },
  );

  // Register multipart parser so endpoints like POST /media/upload-pdf can
  // accept `multipart/form-data`. Without this, Fastify returns 415 on any
  // non-JSON content-type. Files are exposed on `req.body[fieldname]` as
  // multipart objects with a `toBuffer()` method (see @fastify/multipart docs).
  await app.register(multipart as any, {
    attachFieldsToBody: true,
    limits: {
      // 100MB allows large file uploads for admin media browser.
      fileSize: 100 * 1024 * 1024,
      files: 1,
      fields: 10,
    },
  });

  const frontendUrl = process.env.FRONTEND_URL || '';
  const isDev = process.env.NODE_ENV !== 'production';
  const corsOriginsFromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow same-origin/non-browser requests
      if (!origin) return callback(null, true);

      const exactAllowed = new Set([
        ...(frontendUrl ? [frontendUrl] : []),
        ...corsOriginsFromEnv,
      ]);

      const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
      const isNgrok = /^https:\/\/[a-z0-9-]+\.ngrok-free\.dev$/.test(origin);
      const isChromeExtension = /^chrome-extension:\/\//.test(origin);

      if (exactAllowed.has(origin) || (isDev && isLocalhost) || isNgrok || isChromeExtension) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked origin: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Cache-Control',
      'Connection',
      'X-User-Timezone',
      'x-user-timezone',
      'X-Idempotency-Key',
      'x-idempotency-key',
      'ngrok-skip-browser-warning',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-RateLimit-Window',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Trndinn API')
    .setDescription('AI-powered content intelligence and automation platform')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT || 3000;

  if (process.env.NODE_ENV === 'production') {
    const required = [
      'FRONTEND_URL',
      'BACKEND_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'MINIO_PUBLIC_URL',
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.error(
        `FATAL: Missing required env vars for production: ${missing.join(', ')}`,
      );
      process.exit(1);
    }
  }

  await app.listen(port, '0.0.0.0');

  console.log(`Trndinn Backend running on port ${port}`);
  console.log(`API Documentation: /api`);
}

bootstrap();
