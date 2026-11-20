import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  testMatch: '*.browser.ts',
  use: { channel: 'chromium' },
});
