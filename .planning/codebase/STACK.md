# Technology Stack

**Analysis Date:** 2024-07-24

## Languages

**Primary:**
- TypeScript v5.7.3 - Used for all backend code (`src/**/*.ts`).

**Secondary:**
- JavaScript - Compiled output for production, as seen in `start:prod` script (`node dist/main`).

## Runtime

**Environment:**
- Node.js v22.10.7 (inferred from `@types/node`)

**Package Manager:**
- npm (inferred from `package-lock.json`)
- Lockfile: present

## Frameworks

**Core:**
- NestJS v11.0.1 - Primary backend framework.
- Express - Used as the underlying HTTP platform for NestJS (`@nestjs/platform-express`).
- Fastify - Also included (`@nestjs/platform-fastify`), suggesting it might be used or intended for use.

**Testing:**
- Jest v30.0.0 - For unit and end-to-end testing. Configured in `package.json` and `test/jest-e2e.json`.

**Build/Dev:**
- NestJS CLI v11.0.0 - For scaffolding and building the application.
- `ts-node` v10.9.2 - For running TypeScript files directly, used in scripts like `clear:db`.

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` v2.98.0 - For database, auth, and other Supabase services.
- `@nestjs/bullmq` v11.0.4 - Integrates BullMQ for handling background jobs.
- `bullmq` v5.70.2 - The underlying message queue system.
- `ioredis` v5.10.0 - Redis client, used by BullMQ.
- `minio` v8.0.7 - S3-compatible object storage client.

**Infrastructure:**
- `@nestjs/config` v4.0.3 - For managing environment variables and configuration.
- `axios` v1.6.7 - For making HTTP requests to external services.
- `class-validator` & `class-transformer` - Used by NestJS for input validation and transformation.
- `sharp` v0.33.2 - For image processing.

## Configuration

**Environment:**
- Environment variables are managed via `.env` files and loaded with `@nestjs/config`.
- An `.env.example` file provides a template for required variables.

**Build:**
- `tsconfig.json` and `tsconfig.build.json` control the TypeScript compilation.
- `nest-cli.json` provides configuration for the NestJS CLI builder.

## Platform Requirements

**Development:**
- Node.js and npm are required.

**Production:**
- Deployed as a Node.js application, likely within a Docker container (as `Dockerfile` and `docker-compose.yml` are present).

---

*Stack analysis: 2024-07-24*
