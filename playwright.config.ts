import { defineConfig } from '@playwright/test';

const evidence = process.env.BROWSER_EVIDENCE === '1';

export default defineConfig({
  testDir: './browser',
  testMatch: '*.browser.ts',
  reporter: evidence ? [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'browser-evidence/playwright.json' }],
    ['junit', { outputFile: 'browser-evidence/junit.xml' }],
  ] : 'list',
  use: {
    channel: 'chromium',
    trace: evidence ? 'on' : 'off',
    screenshot: evidence ? 'on' : 'only-on-failure',
  },
});
