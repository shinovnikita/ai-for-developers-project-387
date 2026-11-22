import { expect } from '@playwright/test';
import type { CreateMeetingInput } from '../api/generated/sdk/types.gen.ts';
import { test } from './fixtures.ts';

test('гость восстанавливает подтверждение после потери ответа и сдвига окна записи', async ({ calendar, page, request }) => {
  const typeName = 'Консультация';
  const type = await request.post(`${calendar.apiOrigin}/api/meeting-types`, {
    data: { name: typeName, description: 'Обсудим ваш вопрос', durationMinutes: 30 },
  });
  expect(type.status()).toBe(201);

  let firstAttempt: CreateMeetingInput | undefined;
  await page.route('**/api/meetings', async (route) => {
    firstAttempt = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort();
  }, { times: 1 });

  await page.goto(new URL('/booking', calendar.webOrigin).href);
  await page.getByRole('button', { name: `Выбрать ${typeName}` }).click();
  const originalDate = page.getByRole('button', { name: 'вт, 17 нояб.' });
  await originalDate.click();
  await page.getByRole('button', { name: '09:00–09:30' }).click();
  await page.getByRole('textbox', { name: 'Имя' }).fill('Ян');
  await page.getByRole('textbox', { name: 'Тема', exact: true }).fill('  План перехода 🚀  ');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить запись');
  expect(firstAttempt?.topic).toBe('План перехода 🚀');
  const before = await request.get(`${calendar.apiOrigin}/api/meetings/upcoming`);
  const saved = (await before.json()).meetings;
  expect(saved).toHaveLength(1);
  expect(saved[0].topic).toBe('План перехода 🚀');

  const nextDate = '2026-11-17T21:00:01Z';
  calendar.setNow(nextDate);
  await page.clock.setFixedTime(new Date(nextDate));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('button', { name: 'чт, 19 нояб.' })).toBeVisible();
  await expect(originalDate).toHaveCount(0);

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Повторить отправку' }).click({ timeout: 3_000 });
  const response = await responsePromise;
  expect(response.request().postDataJSON()).toEqual(firstAttempt);
  expect(response.status()).toBe(200);
  expect((await response.json()).meeting).toEqual(saved[0]);

  const confirmation = page.getByRole('region', { name: 'Подтверждение записи' });
  await expect(confirmation.getByRole('heading', { name: 'Встреча подтверждена' })).toBeVisible();
  await expect(confirmation.getByText('17 ноября 2026 г.')).toBeVisible();
  await expect(confirmation.getByText('09:00–09:30')).toBeVisible();
  await expect(confirmation.getByText('План перехода 🚀', { exact: true })).toBeVisible();
  calendar.setNow('2026-11-17T05:00:00Z');
  const after = await request.get(`${calendar.apiOrigin}/api/meetings/upcoming`);
  expect((await after.json()).meetings).toEqual(saved);
});
