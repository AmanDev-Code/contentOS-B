# External Integrations

**Analysis Date:** 2024-07-24

## APIs & External Services

**Workflow Automation:**
- **n8n** - Used for running automated workflows, likely for content generation or processing.
  - SDK/Client: Custom implementation in `src/services/n8n.service.ts` using `axios`.
  - Auth: Likely a webhook URL or API key stored in an env var.

**Social Media:**
- **LinkedIn** - Used for social media interactions, as indicated by `src/controllers/linkedin.controller.ts` and `src/services/linkedin.service.ts`.
  - SDK/Client: Likely using `axios` for direct API calls.
  - Auth: Not specified, but probably OAuth tokens stored per user.

**Payments:**
- **Paddle** - Used for handling subscriptions and payments.
  - SDK/Client: No official SDK used. Integration is likely done via webhooks and direct API calls using `axios` in `src/services/paddle.service.ts`.
  - Auth: API key stored in an env var.

## Data Storage

**Database:**
- **Supabase (PostgreSQL)** - Acts as the primary database.
  - Connection: `SUPABASE_URL` and `SUPABASE_KEY` env vars.
  - Client: `@supabase/supabase-js` v2.98.0, managed in `src/services/supabase.service.ts`.

**File Storage:**
- **Minio** - S3-compatible object storage for media and generated assets.
  - Connection: Env vars for endpoint, port, access key, and secret key.
  - Client: `minio` v8.0.7, managed in `src/services/minio.service.ts`.

**Caching:**
- **Redis** - Used for caching and as a message broker for BullMQ.
  - Connection: Env vars for host and port.
  - Client: `ioredis` v5.10.0, configured in `src/services/cache.service.ts` and for BullMQ.

## Authentication & Identity

**Auth Provider:**
- **Supabase Auth** - Manages user authentication (JWT-based).
  - Implementation: The `AuthGuard` in `src/guards/auth.guard.ts` uses the `SupabaseService` to validate tokens from the `Authorization` header.

## Monitoring & Observability

**Error Tracking:**
- **None detected** - No specific error tracking service (like Sentry or Datadog) was found in dependencies.

**Logs:**
- **`@nestjs/common` Logger** - Standard NestJS logger is likely used for application logging to `stdout/stderr`.

## CI/CD & Deployment

**Hosting:**
- Not explicitly defined, but the presence of `Dockerfile` and `docker-compose.yml` suggests a containerized deployment environment.

**CI Pipeline:**
- **GitHub Actions** - A workflow is defined in `.github/workflows/deploy.yml` that seems to handle deployment.

## Environment Configuration

**Required env vars:**
- `SUPABASE_URL`, `SUPABASE_KEY`
- `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`
- `REDIS_HOST`, `REDIS_PORT`
- Paddle-related keys
- n8n-related keys

**Secrets location:**
- `.env` file for local development.
- Likely managed via environment variables in the production deployment environment.

## Webhooks & Callbacks

**Incoming:**
- `src/controllers/paddle.controller.ts`: Handles incoming webhooks from Paddle for subscription events.
- `src/controllers/email-webhook.controller.ts`: Appears to handle webhooks related to email events.
- `src/controllers/webhook.controller.ts`: A generic webhook controller, likely for n8n callbacks.

**Outgoing:**
- `src/services/n8n.service.ts`: Makes calls to n8n webhooks to trigger workflows.

---

*Integration audit: 2024-07-24*
