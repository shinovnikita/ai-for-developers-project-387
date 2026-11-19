import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { MeetingType } from '../api/generated/sdk/types.gen.ts';
import { test } from './fixtures.ts';

test.use({ timezoneId: 'America/Los_Angeles' });

test('после записи через главную владелец видит встречу и может обновить список', async ({ calendar, page, request }) => {
  const typeName = 'Консультация';
  const guestName = 'Анна';
  const ownerUrl = new URL('/owner', calendar.webOrigin).href;

  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined });
  });
  await page.goto(ownerUrl);
  const upcoming = page.getByRole('region', { name: 'Предстоящие встречи' });
  await expect(upcoming.getByText('Предстоящих встреч пока нет')).toBeVisible();
  await page.getByRole('textbox', { name: 'Название' }).fill(typeName);
  await page.getByRole('textbox', { name: 'Описание' }).fill('Обсудим ваш вопрос');
  await page.getByRole('spinbutton', { name: 'Длительность в минутах' }).fill('30');
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page.getByText('Тип встречи создан')).toBeVisible();

  await page.goto(calendar.webOrigin);
  await page.getByRole('link', { name: 'Перейти к записи' }).click();
  await page.getByRole('button', { name: `Выбрать ${typeName}` }).click();
  await page.getByRole('button', { name: 'вт, 17 нояб.' }).click();
  await page.getByRole('button', { name: '10:00–10:30' }).click();
  await page.getByRole('textbox', { name: 'Имя' }).fill(guestName);
  const bookingResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  expect((await bookingResponse).status()).toBe(201);

  const confirmation = page.getByRole('region', { name: 'Подтверждение записи' });
  await expect(confirmation.getByRole('heading', { name: 'Встреча подтверждена' })).toBeVisible();
  await expect(confirmation.getByText(typeName, { exact: true })).toBeVisible();
  await expect(confirmation.getByText('17 ноября 2026 г.')).toBeVisible();
  await expect(confirmation.getByText('10:00–10:30')).toBeVisible();
  await expect(confirmation.getByText('Europe/Moscow')).toBeVisible();

  await page.goto(ownerUrl);
  const booking = upcoming.getByRole('row').filter({ hasText: guestName });
  await expect(booking.getByRole('cell', { name: typeName })).toBeVisible();
  await expect(booking.getByRole('cell', { name: '17 ноября 2026 г.' })).toBeVisible();
  await expect(booking.getByRole('cell', { name: '10:00–10:30' })).toBeVisible();
  await expect(upcoming.getByText('Europe/Moscow')).toBeVisible();

  const catalog = await request.get(`${calendar.apiOrigin}/api/meeting-types`);
  const [meetingType]: MeetingType[] = await catalog.json();
  const secondBooking = await request.post(`${calendar.apiOrigin}/api/meetings`, {
    data: {
      meetingTypeId: meetingType.id,
      startsAt: '2026-11-17T06:00:00Z',
      guestName: 'Ян',
      attemptId: randomUUID(),
    },
  });
  expect(secondBooking.status()).toBe(201);

  await upcoming.getByRole('button', { name: 'Обновить список' }).click();
  const rows = upcoming.getByRole('row').filter({ hasText: typeName });
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByRole('cell', { name: 'Ян' })).toBeVisible();
});
