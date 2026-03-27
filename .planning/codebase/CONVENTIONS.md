# Coding Conventions

**Analysis Date:** 2024-07-25

## Naming Patterns

**Files:**
- Files are named using `kebab-case` followed by the NestJS entity type.
- Examples: `auth.controller.ts`, `profile.repository.ts`, `auth.guard.ts`.

**Functions:**
- Functions and methods use `camelCase`.
- Example from `src/services/auth.service.ts`: `async registerUser(...)`, `handleUserSignup(...)`.

**Variables:**
- Variables and constants use `camelCase`.
- Example from `src/controllers/auth.controller.ts`: `const result = ...`, `const msg = ...`.

**Types:**
- Interfaces and DTOs (Data Transfer Objects) use `PascalCase`.
- They are often suffixed with `Dto`, `Payload`, or the entity name.
- Example from `src/controllers/auth.controller.ts`: `interface RegisterDto`, `interface AuthWebhookPayload`.
- Example from `src/common/types/index.ts`: `export type Profile = ...`.

## Code Style

**Formatting:**
- Formatting is enforced by Prettier.
- Key settings from `.prettierrc`:
  - `singleQuote: true`
  - `trailingComma: "all"`

**Linting:**
- Linting is performed by ESLint with `typescript-eslint`.
- It is configured in `eslint.config.mjs`.
- Key rules:
  - `@typescript-eslint/no-explicit-any`: `off`
  - `@typescript-eslint/no-floating-promises`: `warn`
  - `@typescript-eslint/no-unsafe-argument`: `warn`
  - `prettier/prettier`: `error` (ensuring Prettier rules are enforced)

## Import Organization

**Order:**
1. NestJS / Node modules (`@nestjs/common`)
2. Third-party packages (e.g., `@supabase/supabase-js`)
3. Internal services, repositories, guards, etc. using relative paths (`../services/auth.service.ts`).

**Path Aliases:**
- No path aliases (like `@/...`) were detected. Imports use relative paths.

## Error Handling

**Patterns:**
- **Controllers (`src/controllers/*`):** Use `try...catch` blocks within endpoint handlers. Errors are caught, logged, and a structured JSON response is returned to the client (e.g., `{ success: false, message: 'Error details' }`).
- **Services (`src/services/*`) & Repositories (`src/repositories/*`):** Methods typically throw exceptions directly or re-throw errors from external clients (like Supabase). The responsibility for catching errors lies with the calling service or controller.
- Example from `src/repositories/profile.repository.ts`:
  ```typescript
  async findById(userId: string): Promise<Profile | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error; // Error is thrown to the caller
    return data;
  }
  ```

## Logging

**Framework:**
- The built-in NestJS `Logger` (`@nestjs/common`).

**Patterns:**
- A `private readonly logger` instance is instantiated in most classes (`new Logger(ClassName.name)`).
- `logger.log()` is used for general information, like webhook processing.
- `logger.error()` is used within `catch` blocks to record failed operations, often including the error message.
- `logger.warn()` is used for non-critical issues, like a password reset request for a non-existent email.

## Comments

**When to Comment:**
- Comments are used to explain the purpose of methods, justify design decisions, or clarify complex logic.

**JSDoc/TSDoc:**
- JSDoc-style block comments (`/** ... */`) are used on most public methods in services and controllers to explain their function, parameters, and what they return.
- Example from `src/services/auth.service.ts`:
  ```typescript
  /**
   * Register a new user via Admin API (bypasses Supabase built-in emails entirely).
   * Creates the user, verification token, sends OTP, and creates notification.
   */
  async registerUser(data: { ... }): Promise<{ userId: string }> { ... }
  ```
- Inline comments (`//`) are used to explain specific lines or blocks of code.

## Function Design

**Size:**
- Functions are generally focused on a single responsibility. Some methods in `src/services/auth.service.ts` are longer as they orchestrate multiple steps (DB writes, emails, notifications).

**Parameters:**
- Controller methods use NestJS decorators (`@Body()`, `@Query()`, `@GetUser()`) to receive parameters.
- Service method parameters are typically objects for clarity when multiple arguments are needed.

**Return Values:**
- Controller methods return JSON objects, often with a `success` boolean.
- Service methods return Promises resolving to data models, booleans for success/failure, or `void`.

## Module Design

**Exports:**
- Each file typically defines and exports a single primary class (e.g., `export class AuthController`).

**Barrel Files:**
- Barrel files (`index.ts`) are present in some directories like `src/common/constants` and `src/common/types` to re-export modules from that directory, but they are not used everywhere.

---

*Convention analysis: 2024-07-25*
