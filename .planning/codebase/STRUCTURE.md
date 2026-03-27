# Codebase Structure

**Analysis Date:** 2024-07-30

## Directory Layout

```
backend/
├── database/       # Database migrations
├── docker-compose.yml # Local development services (Postgres, Redis)
├── Dockerfile      # Production container definition
├── nest-cli.json   # NestJS CLI configuration
├── package.json    # Project dependencies and scripts
├── src/            # Application source code
└── test/           # End-to-end tests
```

## Directory Purposes

**`src/`**: The heart of the application, containing all NestJS-related source code.
- **Purpose**: Houses all the logic, controllers, services, and modules.
- **Contains**: TypeScript files (`.ts`).

**`src/controllers/`**
- **Purpose**: Defines API endpoints, handles incoming requests, and delegates to services.
- **Contains**: NestJS controllers (e.g., `posts.controller.ts`, `auth.controller.ts`).
- **Key files**: One file per resource or functional area.

**`src/services/`**
- **Purpose**: Contains the core business logic of the application.
- **Contains**: Injectable services that can be used by controllers and other services.
- **Key files**: `auth.service.ts`, `post-scheduling.service.ts`, `supabase.service.ts`.

**`src/repositories/`**
- **Purpose**: Provides a data access layer for interacting with the database.
- **Contains**: Classes that encapsulate database queries using the `SupabaseService`.
- **Key files**: `profile.repository.ts`, `generation-job.repository.ts`.

**`src/guards/`**
- **Purpose**: Implements authorization and authentication strategies.
- **Contains**: NestJS Guards to protect routes.
- **Key files**: `auth.guard.ts`, `admin.guard.ts`, `paywall.guard.ts`.

**`src/workers/` & `src/processors/`**
- **Purpose**: Handles background jobs using BullMQ.
- **Contains**: Queue processors and worker managers.
- **Key files**: `generation.worker.ts`, `post-publishing.processor.ts`.

**`src/common/`**
- **Purpose**: Holds shared code, such as types, constants, and decorators, used across the application.
- **Contains**: `types/`, `constants/`, `decorators/`.

**`src/config/`**
- **Purpose**: Manages application configuration.
- **Contains**: Configuration loading logic for NestJS `ConfigModule`.
- **Key files**: `configuration.ts`.

**`database/migrations/`**
- **Purpose**: Stores database schema migration files.
- **Contains**: SQL or TypeScript migration scripts.

**`test/`**
- **Purpose**: Contains end-to-end tests for the application.
- **Contains**: Jest test files (`.e2e-spec.ts`).

## Key File Locations

**Entry Points:**
- `src/main.ts`: The main application bootstrap file. It initializes NestJS, sets up global middleware, and starts the server.
- `src/app.module.ts`: The root module that imports and assembles all controllers, services, and other components.

**Configuration:**
- `package.json`: Defines dependencies, scripts, and project metadata.
- `.prettierrc`, `eslint.config.mjs`: Code style and linting rules.
- `tsconfig.json`: TypeScript compiler options.
- `nest-cli.json`: NestJS specific project configuration.

**Core Logic:**
- `src/services/`: Core business logic resides here.
- `src/repositories/`: Data access logic.

**Testing:**
- `test/app.e2e-spec.ts`: An example of an end-to-end test.
- `jest-e2e.json`: Jest configuration for end-to-end tests.

## Naming Conventions

**Files:**
- **[name].[type].ts**: Standard NestJS naming convention (e.g., `posts.controller.ts`, `auth.service.ts`, `app.module.ts`).
- **kebab-case**: Used for most non-class files.

**Directories:**
- **kebab-case**: Most directories follow this convention (e.g., `email-templates`).
- **flat structure**: Directories like `controllers` and `services` hold all files directly, rather than being nested by feature.

## Where to Add New Code

**New Feature (e.g., "Analytics")**
- **Controller**: Create `src/controllers/analytics.controller.ts`.
- **Service**: Create `src/services/analytics.service.ts`.
- **Repository**: If direct data access is needed, create `src/repositories/analytics.repository.ts`.
- **Module Registration**: Add the new controller, service, and repository to the `providers` and `controllers` arrays in `src/app.module.ts`.

**New Component/Module:**
- The current pattern does not use feature modules. New components are added directly to the root `AppModule`.
- To introduce a modular structure, one would create a new directory like `src/analytics/` containing `analytics.module.ts`, `analytics.controller.ts`, and `analytics.service.ts`, and then import `AnalyticsModule` into `src/app.module.ts`.

**Utilities:**
- **Shared helpers**: Add to a relevant subdirectory in `src/common/utils/`.
- **New shared types**: Add to `src/common/types/index.ts` or a new file within that directory.

## Special Directories

**`dist/`**
- **Purpose**: Contains the compiled JavaScript output from the TypeScript compiler.
- **Generated**: Yes, by `tsc` (the TypeScript compiler).
- **Committed**: No, it is listed in `.gitignore`.
