import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      bodyLimit: 10485760, // 10MB limit for JSON/text bodies (multipart has its own limit)
    }),
    { rawBody: true },
  );

  // Register multipart parser so endpoints like POST /media/upload-pdf can
  // accept `multipart/form-data`. Without this, Fastify returns 415 on any
  // non-JSON content-type. Files are exposed on `req.body[fieldname]` as
  // multipart objects with a `toBuffer()` method (see @fastify/multipart docs).
  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: {
      // 26MB allows a 25MB PDF plus minor multipart envelope overhead.
      fileSize: 26 * 1024 * 1024,
      files: 1,
      fields: 10,
    },
  });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const corsOriginsFromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow same-origin/non-browser requests
      if (!origin) return callback(null, true);

      const exactAllowed = new Set([
        frontendUrl,
        ...corsOriginsFromEnv,
        'http://localhost:8080',
        'http://localhost:3000',
        'http://localhost:5173',
        'https://alfonso-pseudooriental-cyclonically.ngrok-free.dev',
      ]);

      const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
      const isNgrok = /^https:\/\/[a-z0-9-]+\.ngrok-free\.dev$/.test(origin);

      if (exactAllowed.has(origin) || isLocalhost || isNgrok) {
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
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Trndinn Backend running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api`);
}

bootstrap();
