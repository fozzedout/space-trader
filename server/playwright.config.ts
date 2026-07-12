import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Ambient NPCs and prior test captains persist in local D1/Durable Object
    // storage across runs; wipe it so encounters/travel state can't bleed
    // between test runs (or leftover manual playtesting) and cause flakes.
    command: 'rm -rf .wrangler/state && npm run db:migrate:local && npm run dev -- --port 8787',
    url: 'http://127.0.0.1:8787/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
