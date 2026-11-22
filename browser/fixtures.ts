import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { createServer } from 'vite';
import { buildApp } from '../server/app.ts';
import { readWeeklySchedule } from '../server/working-hours.ts';

const fixedTime = '2026-11-17T05:00:00Z';

type Calendar = {
  apiOrigin: string;
  webOrigin: string;
  setNow: (instant: string) => void;
};

export const test = base.extend<{ calendar: Calendar; calendarDatabasePath: string }>({
  calendarDatabasePath: [':memory:', { option: true }],
  calendar: async ({ calendarDatabasePath }, use) => {
    const host = '127.0.0.1';
    let now = new Date(fixedTime);
    const app = buildApp({}, [], {
      databasePath: calendarDatabasePath,
      now: () => now,
      schedule: readWeeklySchedule(undefined),
    });

    try {
      const apiOrigin = await app.listen({ host, port: 0 });
      const vite = await createServer({
        root: fileURLToPath(new URL('../frontend', import.meta.url)),
        server: { host, port: 0, proxy: { '/api': apiOrigin } },
      });

      try {
        await vite.listen();
        const webOrigin = vite.resolvedUrls?.local[0];
        if (!webOrigin) throw new Error('Vite did not report its HTTP address');
        await use({ apiOrigin, webOrigin, setNow: (instant) => { now = new Date(instant); } });
      } finally {
        await vite.close();
      }
    } finally {
      await app.close();
    }
  },
  page: async ({ page }, use) => {
    await page.clock.setFixedTime(new Date(fixedTime));
    await use(page);
  },
});
