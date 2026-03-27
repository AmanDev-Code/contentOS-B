# Architecture

**Analysis Date:** 2024-07-30

## Pattern Overview

**Overall:** Layered Monolith within a single NestJS Module

The application uses the NestJS framework, suggesting a layered architecture (Controllers, Services, Repositories). However, in practice, the layers are not strictly separated, and the entire application is registered within a single root `AppModule`, making it a monolithic structure from a modularity standpoint.

**Key Characteristics:**
- **NestJS Framework:** Utilizes NestJS with the Fastify adapter for its core structure, including dependency injection, decorators, and a module system.
- **Service-Oriented... ish:** The code is divided into services, but a strict "Service Layer" pattern is not enforced, with business logic frequently leaking into controllers.
- **Direct Database Coupling:** The entire application is tightly coupled to the Supabase client. Services, controllers, and repositories all interact directly with the `SupabaseService`, bypassing proper abstraction.

## Layers

**Controllers:**
- **Purpose:** To handle incoming HTTP requests, validate payloads (via pipes), and return responses.
- **Location:** `src/controllers/`
- **Contains:** NestJS controller classes (`@Controller`).
- **Depends on:** Services.
- **Used by:** The NestJS routing mechanism.
- **Architectural issue:** Controllers often contain significant business logic (e.g., calculating costs, orchestrating refunds) and make direct database calls, a pattern known as "Fat Controller". This breaks the separation of concerns. Example: `src/controllers/posts.controller.ts`.

**Services:**
- **Purpose:** To encapsulate business logic.
- **Location:** `src/services/`
- **Contains:** NestJS injectable classes (`@Injectable`).
- **Depends on:** Other services, Repositories, and the `SupabaseService`.
- **Used by:** Controllers, other services, and workers.
- **Architectural issue:** Services frequently bypass the repository layer and interact directly with `SupabaseService`, further blurring the lines between the business logic and data access layers. Example: `src/services/post-scheduling.service.ts`.

**Repositories:**
- **Purpose:** Intended to be the data access layer (DAL).
- **Location:** `src/repositories/`
- **Contains:** NestJS injectable classes that wrap a `SupabaseService`.
- **Depends on:** `SupabaseService`.
- **Used by:** Services (and sometimes controllers implicitly).
- **Architectural issue:** The repository layer is a very thin wrapper around the Supabase client. It doesn't use an ORM and fails to abstract the data source, resulting in Supabase-specific query logic spread throughout the services that use them, and even in the repositories themselves. Example: `src/repositories/profile.repository.ts`.

**Workers / Processors:**
- **Purpose:** To handle asynchronous, long-running, or background tasks.
- **Location:** `src/workers/`, `src/processors/`
- **Contains:** BullMQ queue processors and workers.
- **Depends on:** Services.
- **Used by:** The BullMQ job queue system.

## Data Flow

**Standard API Request:**

1.  An HTTP request hits a route defined in a Controller (e.g., `POST /posts/publish` in `src/controllers/posts.controller.ts`).
2.  NestJS Guards (e.g., `AuthGuard`, `PaywallGuard`) are executed for authentication and authorization.
3.  The request body is validated by the global `ValidationPipe`.
4.  The controller method executes, often containing a mix of business logic and calls to various services (`QuotaService`, `PostSchedulingService`).
5.  The controller or a service it calls interacts directly with the `SupabaseService` to fetch or update data.
6.  The controller formats and returns a response.

**Background Job (Post Scheduling):**

1.  A controller method (e.g., `schedulePost`) calls a service (`PostSchedulingService`).
2.  The `PostSchedulingService` adds a job to a BullMQ queue (`post-publishing`).
3.  The service immediately returns a response to the client.
4.  At the scheduled time, a BullMQ worker (`src/processors/post-publishing.processor.ts`) picks up the job.
5.  The worker executes the job, calling services (`LinkedinService`, `SupabaseService`) to perform the actual work (e.g., publishing the post to an external platform).
6.  The worker updates the database with the result of the job.

**State Management:**
- Application state is stateless from a server perspective.
- All persistent state is stored in the Supabase (PostgreSQL) database.
- Redis is used by BullMQ for queue management and also by `CacheService` for application-level caching.

## Key Abstractions

**`SupabaseService`:**
- **Purpose:** To provide a singleton instance of the Supabase client to the rest of the application.
- **Location:** `src/services/supabase.service.ts`
- **Pattern:** This service is injected everywhere data is needed, effectively making the Supabase client a global dependency and tightly coupling the application to it.

## Entry Points

**Web Server:**
- **Location:** `src/main.ts`
- **Triggers:** `npm start` or similar script that executes the compiled JavaScript.
- **Responsibilities:** Bootstraps the NestJS application, sets up middleware (CORS, validation), enables Swagger, and starts the Fastify server.

**Background Workers:**
- **Location:** `src/workers/` and `src/processors/`
- **Triggers:** Jobs being added to BullMQ queues.
- **Responsibilities:** Executing tasks like content generation and post publishing asynchronously.

## Error Handling

**Strategy:** A mix of `try/catch` blocks and NestJS exception filters.

**Patterns:**
- **Controller-level:** Most controller methods are wrapped in a `try/catch` block. On error, a NestJS `HttpException` is thrown with an appropriate status code.
- **Service-level:** Services may throw standard `Error` objects, which are then caught by the controller and re-thrown as `HttpException`.

## Cross-Cutting Concerns

**Logging:** Standard NestJS `Logger`.
**Validation:** Global `ValidationPipe` applied in `src/main.ts`.
**Authentication:** Implemented with NestJS Guards in `src/guards/`. The `AuthGuard` is the primary mechanism.
