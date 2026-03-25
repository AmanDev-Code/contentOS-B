import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      bodyLimit: 10485760, // 10MB limit for file uploads
    }),
    { rawBody: true },
  );

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
      'ngrok-skip-browser-warning',
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

