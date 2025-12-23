# Testing Guide

This project includes a comprehensive test suite using [Vitest](https://vitest.dev/) to ensure code quality and catch bugs before deployment.

## Running Tests

### Run all tests once
```bash
npm test
```

### Run tests in watch mode (for development)
```bash
npm run test:watch
```

### Run tests with coverage report
```bash
npm run test:coverage
```

This generates a coverage report showing which parts of your code are tested. Coverage reports are saved to `coverage/` directory.

## Test Structure

Tests are located alongside source files with the `.test.ts` extension:

- `src/deterministic-rng.test.ts` - Tests for deterministic random number generation
- `src/goods.test.ts` - Tests for goods catalog and definitions
- `src/star-system.test.ts` - Tests for StarSystem Durable Object
- `src/ship.test.ts` - Tests for Ship Durable Object
- `src/integration.test.ts` - Integration tests for system interactions

## Test Categories

### Unit Tests

**DeterministicRNG Tests:**
- ✅ Deterministic behavior with same seed
- ✅ Different sequences with different seeds
- ✅ Random number ranges
- ✅ Integer and float generation
- ✅ Array operations (choice, shuffle)
- ✅ Weighted random choice

**Goods Tests:**
- ✅ Goods catalog validation
- ✅ Unique good IDs
- ✅ Valid properties (prices, weights, tech levels)
- ✅ Good lookup functions
- ✅ Tech level requirements

### Component Tests

**StarSystem Tests:**
- ✅ System initialization
- ✅ Market creation
- ✅ State management
- ✅ Tick processing
- ✅ Market price updates
- ✅ Trading (buy/sell)
- ✅ Ship arrival/departure
- ✅ Error handling

**Ship Tests:**
- ✅ Ship initialization
- ✅ State management
- ✅ Tick processing
- ✅ Error handling

### Integration Tests

- ✅ Cross-system trading
- ✅ Deterministic behavior across systems
- ✅ Multiple tick processing
- ✅ Price history tracking
- ✅ Ship arrival with price information

## Writing New Tests

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { YourClass } from "./your-class";

describe("YourClass", () => {
  let instance: YourClass;

  beforeEach(() => {
    instance = new YourClass();
  });

  it("should do something", () => {
    expect(instance.method()).toBe(expected);
  });
});
```

### Testing Durable Objects

Use the mock utilities from `src/test-utils/mocks.ts`:

```typescript
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";

const mockState = new MockDurableObjectState({ toString: () => "id" } as any);
const mockEnv = createMockEnv();
const system = new StarSystem(mockState, mockEnv);
```

## Test Coverage Goals

Aim for:
- **80%+ line coverage** for core logic
- **100% coverage** for critical paths (trading, pricing)
- **All edge cases** covered (error conditions, boundary values)

## Common Test Patterns

### Testing Deterministic Behavior

```typescript
it("should be deterministic", () => {
  const rng1 = new DeterministicRNG("seed");
  const rng2 = new DeterministicRNG("seed");
  expect(rng1.random()).toBe(rng2.random());
});
```

### Testing Async Operations

```typescript
it("should handle async operations", async () => {
  const response = await system.fetch(request);
  const data = await response.json();
  expect(data.success).toBe(true);
});
```

### Testing Error Conditions

```typescript
it("should handle errors", async () => {
  const response = await system.fetch(invalidRequest);
  expect(response.status).toBe(400);
});
```

## Continuous Integration

Tests should be run:
- Before committing code
- In CI/CD pipeline
- Before deploying to production

Add to your CI configuration:

```yaml
# Example GitHub Actions
- name: Run tests
  run: npm test

- name: Check coverage
  run: npm run test:coverage
```

## Debugging Tests

### Run specific test file
```bash
npm test src/deterministic-rng.test.ts
```

### Run tests matching a pattern
```bash
npm test -- -t "deterministic"
```

### Debug mode
```bash
npm test -- --inspect-brk
```

## Known Issues and Limitations

1. **Durable Object Mocks**: The mock implementation is simplified. Some advanced features may not be fully mocked.

2. **Time-dependent Tests**: Tests that depend on `Date.now()` may need time mocking for deterministic results.

3. **Network Calls**: Tests don't make actual network calls. All Durable Object interactions are mocked.

## Best Practices

1. **Test one thing at a time** - Each test should verify a single behavior
2. **Use descriptive names** - Test names should clearly describe what they test
3. **Arrange-Act-Assert** - Structure tests clearly
4. **Test edge cases** - Don't just test happy paths
5. **Keep tests fast** - Tests should run quickly
6. **Mock external dependencies** - Don't rely on external services in tests

## Troubleshooting

### Tests fail with "Cannot find module"
Run `npm install` to ensure all dependencies are installed.

### Type errors in tests
Run `npm run type-check` to see TypeScript errors.

### Tests pass locally but fail in CI
Check for:
- Environment differences
- Time zone issues
- Random seed differences
- Missing environment variables

