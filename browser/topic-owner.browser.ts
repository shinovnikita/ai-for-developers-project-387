import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from '@playwright/test';
import { buildApp } from '../server/app.ts';
import { test as calendarTest } from './fixtures.ts';

const topic = 'Обсудить <b>план</b> ' + 'Я'.repeat(179);
const test = calendarTest.extend({
  calendarDatabasePath: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-topic-'));
    const databasePath = join(directory, 'calendar.sqlite');
    try {
      const app = buildApp({}, [{ id: 'type', name: 'Консультация', description: 'Вопросы', durationMinutes: 30 }], { databasePath });
      await app.close();
      const database = new DatabaseSync(databasePath);
      try {
        const insert = database.prepare(`INSERT INTO meetings
          (id, meeting_type_id, meeting_type_name, guest_name, starts_at, ends_at, attempt_id, topic)
          VALUES (?, 'type', 'Консультация', ?, ?, ?, ?, ?)`);
        insert.run('legacy', 'Ян', Date.parse('2026-11-17T07:00:00Z'), Date.parse('2026-11-17T07:30:00Z'), 'legacy-attempt', null);
        insert.run('topic', 'Лена', Date.parse('2026-11-17T08:00:00Z'), Date.parse('2026-11-17T08:30:00Z'), 'topic-attempt', topic);
      } finally {
        database.close();
      }
      await use(databasePath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test.use({ viewport: { width: 320, height: 720 } });

test('owner reads full saved topic and legacy fallback on a narrow screen after refresh and reload', async ({ calendar, page }) => {
  await page.goto(new URL('/owner', calendar.webOrigin).href);
  const upcoming = page.getByRole('region', { name: 'Предстоящие встречи' });
  for (const action of ['initial', 'refresh', 'reload']) {
    if (action === 'refresh') await upcoming.getByRole('button', { name: 'Обновить список' }).click();
    if (action === 'reload') await page.reload();
    const legacy = upcoming.getByRole('row').filter({ hasText: 'Ян' });
    await expect(legacy.getByText('Тема не указана', { exact: true })).toBeVisible();
    const row = upcoming.getByRole('row').filter({ hasText: 'Лена' });
    const text = row.getByText(topic, { exact: true });
    await expect(text).toBeVisible();
    await expect(text).toHaveText(topic);
    await expect(row.locator('b')).toHaveCount(0);
    const title = row.getByText('Консультация', { exact: true });
    const titleBox = await title.boundingBox();
    const box = await text.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(await text.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.scrollWidth <= element.clientWidth
        && element.scrollHeight <= element.clientHeight
        && element.clientHeight > parseFloat(style.lineHeight) * 2
        && style.textOverflow !== 'ellipsis'
        && style.overflowY !== 'hidden';
    })).toBe(true);
  }
});
