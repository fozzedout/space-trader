# Code Profiling Guide

This guide explains how to identify which lines of code are taking time or being executed many times.

## Method 1: Built-in Profiler Utility

A custom profiler utility is available at `src/profiler.ts` that you can use to wrap functions or code blocks.

### Basic Usage

```typescript
import { profiler, timeBlock, timeBlockSync } from "./profiler";

// Time an async function
await timeBlock("system-tick", async () => {
  await system.fetch(new Request("https://dummy/tick", { method: "POST" }));
});

// Time a synchronous function
const result = timeBlockSync("calculate-price", () => {
  return calculatePrice(goodId, market);
});

// Manual timing
profiler.start("operation-name");
// ... your code ...
profiler.end("operation-name");

// Print statistics
profiler.printStats(20); // Print top 20 slowest operations
```

### View Profiling Stats

```bash
# Get stats via API
curl http://localhost:3000/api/profiler/stats

# Print stats to console
curl -X POST http://localhost:3000/api/profiler/print?limit=20

# Reset profiler
curl -X POST http://localhost:3000/api/profiler/reset
```

## Method 2: Node.js Built-in Profiler

Node.js has a built-in profiler that can show you exactly which lines are taking time.

### Step 1: Run with Profiling

```bash
# Start the server with profiling enabled
node --prof src/local-server.js

# Or if using tsx
NODE_OPTIONS="--prof" npm run dev
```

### Step 2: Generate Profile Data

Let the server run for a while (at least 30 seconds), then stop it. This creates a `isolate-*.log` file.

### Step 3: Process the Profile

```bash
# Process the profile log
node --prof-process isolate-*.log > profile.txt

# View the results
cat profile.txt
```

The output shows:
- Functions sorted by total time
- Functions sorted by self time (time spent in the function itself, not including children)
- Which functions are called most frequently

### Step 4: Use with Source Maps (for TypeScript)

```bash
# Build first
npm run local:build

# Run with profiling and source maps
NODE_OPTIONS="--prof --enable-source-maps" node dist/local-server.js
```

## Method 3: Clinic.js (Third-party Tool)

Clinic.js provides visual profiling with flame graphs.

### Installation

```bash
npm install -g clinic
```

### Usage

```bash
# Profile CPU usage
clinic doctor -- node dist/local-server.js

# Profile with flame graphs
clinic flame -- node dist/local-server.js

# Profile I/O operations
clinic bubbleprof -- node dist/local-server.js
```

After running, it will open a browser with interactive visualizations.

## Method 4: Manual Instrumentation

Add timing around specific code sections:

```typescript
const start = performance.now();
// ... your code ...
const duration = performance.now() - start;
if (duration > 10) {
  console.log(`Slow operation: ${duration.toFixed(2)}ms`);
}
```

## Method 5: Chrome DevTools Profiler

If running in Node.js with inspector:

```bash
# Start with inspector
node --inspect src/local-server.js

# Or with tsx
NODE_OPTIONS="--inspect" npm run dev
```

Then:
1. Open Chrome and go to `chrome://inspect`
2. Click "Open dedicated DevTools for Node"
3. Go to the "Performance" tab
4. Click record, perform operations, then stop
5. Analyze the flame graph

## Recommended Approach

1. **Start with the built-in profiler utility** - Add `timeBlock` calls around suspected slow areas
2. **Use Node.js `--prof`** - For detailed line-by-line analysis
3. **Use Clinic.js** - For visual flame graphs and easier analysis

## Example: Profiling System Ticks

```typescript
// In local-server.ts, around system ticking:
for (let i = 0; i < GALAXY_SIZE; i++) {
  const systemId = i as SystemId;
  await timeBlock(`system-${systemId}-tick`, async () => {
    const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
    await system.fetch(new Request("https://dummy/tick", { method: "POST" }));
  });
}
```

Then check stats:
```bash
curl http://localhost:3000/api/profiler/stats | jq '.topConsumers'
```

## Finding Hot Loops

To find loops that execute many times:

1. Add counters:
```typescript
let loopCount = 0;
for (const item of items) {
  loopCount++;
  // ... code ...
}
if (loopCount > 1000) {
  console.log(`Large loop: ${loopCount} iterations`);
}
```

2. Use the profiler - functions called many times will show high `count` values

3. Use `--prof` - It shows call counts for each function

## Tips

- **Profile in production-like conditions** - Use realistic data sizes
- **Profile for sufficient time** - At least 30 seconds to get meaningful data
- **Focus on hot paths** - Functions called many times or taking long time
- **Compare before/after** - Profile before and after optimizations

