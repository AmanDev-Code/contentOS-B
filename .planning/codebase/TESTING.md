# Testing Patterns

**Analysis Date:** 2024-07-25

## Test Framework

**Runner:**
- **Jest** (version `^30.0.0`)
- Config: The primary configuration is located within the `jest` key in `package.json`. A separate config for E2E tests exists at `test/jest-e2e.json`.

**Assertion Library:**
- Jest's built-in `expect` is used.

**Run Commands:**
```bash
npm run test              # Run all unit tests
npm run test:watch        # Watch for changes and re-run tests
npm run test:cov          # Run tests and generate a coverage report
npm run test:e2e            # Run end-to-end tests
```

## Test File Organization

**Location:**
- **Unit Tests:** Co-located with the source files they are testing in the `src/` directory.
- **End-to-End (E2E) Tests:** Located in a separate `test/` directory at the project root.

**Naming:**
- Unit test files use the `.spec.ts` suffix (e.g., `app.controller.spec.ts`).
- E2E test files use the `.e2e-spec.ts` suffix (e.g., `app.e2e-spec.ts`).

**Structure:**
```
src/
├── app.controller.ts
├── app.controller.spec.ts  # Unit test for AppController
└── ...
test/
└── app.e2e-spec.ts         # E2E test for the application
```

## Test Structure

**Suite Organization:**
- Tests are organized into suites using `describe` blocks, which typically correspond to a class (e.g., a controller or service).
- Individual test cases are defined within `it` blocks.
- Setup logic is handled in `beforeEach` hooks.

**Unit Test Pattern (`src/app.controller.spec.ts`):**
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});
```

## Mocking

**Framework:**
- Mocking is done using Jest's built-in capabilities in combination with `@nestjs/testing` utilities.

**Patterns:**
- While the examined `app.controller.spec.ts` uses a real `AppService` instance, dependencies are typically mocked by providing a custom `useValue` or `useFactory` in the `.createTestingModule()` configuration.

**What to Mock:**
- Dependencies of the class under test (e.g., services, repositories) should be mocked to isolate the unit of work.

**What NOT to Mock:**
- The class being tested should not be mocked.

## Fixtures and Factories

**Test Data:**
- No dedicated fixture or factory files were observed. Test data is defined directly within the relevant `it` or `describe` block.

**Location:**
- Not applicable.

## Coverage

**Requirements:**
- A coverage script (`test:cov`) exists, but there are no enforced coverage thresholds in the Jest configuration.

**View Coverage:**
- After running `npm run test:cov`, a coverage report is generated in the `coverage/` directory.
```bash
npm run test:cov
```

## Test Types

**Unit Tests:**
- **Scope:** Test individual classes (controllers, services) in isolation.
- **Approach:** Use `@nestjs/testing` to create a lightweight testing module, providing mocks for all dependencies.

**Integration Tests:**
- No distinct integration test pattern was observed. The E2E tests serve as a form of integration testing by loading the full application module.

**E2E Tests:**
- **Framework:** Jest in combination with **Supertest** for making HTTP requests.
- **Scope:** Test the application's behavior through its public API endpoints.
- **Approach:** Load the entire `AppModule`, create a full NestJS application instance, and send HTTP requests to it. Assertions are made on the HTTP response (status code, body).

## Common Patterns

**Async Testing:**
- `async/await` is used, particularly in `beforeEach` hooks for asynchronous setup (e.g., `await Test.createTestingModule(...).compile()`) and in E2E tests.

**Error Testing:**
- The provided examples do not show error testing, but this would typically be done using `expect(...).toThrow()` for synchronous code or `expect(...).rejects.toThrow()` for async methods.

---

*Testing analysis: 2024-07-25*
