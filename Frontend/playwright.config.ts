import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4207',
    browserName: 'chromium',
    channel:
      process.env['PLAYWRIGHT_CHANNEL'] || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start -- --host 127.0.0.1 --port 4207',
    url: 'http://127.0.0.1:4207',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
