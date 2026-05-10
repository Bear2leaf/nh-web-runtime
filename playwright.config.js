import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  timeout: 120_000,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'make serve',
    port: 8100,
    reuseExistingServer: true,
  },
});
