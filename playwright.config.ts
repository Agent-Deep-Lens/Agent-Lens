import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e', timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4317', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'npm start', url: 'http://127.0.0.1:4317', reuseExistingServer: !process.env.CI },
});
