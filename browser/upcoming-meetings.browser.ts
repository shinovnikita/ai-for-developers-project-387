import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { MeetingType } from '../api/generated/sdk/types.gen.ts';
import { test } from './fixtures.ts';

test.use({ timezoneId: 'America/Los_Angeles' });

test('после записи через главную владелец видит встречу и может обновить список', async ({ calendar, page, request }) => {
  const typeName = 'Консультация';
  const guestName = 'Анна';
  const topic = 'Обсудить <b>план</b> ' + '🚀'.repeat(179);
  await page.setViewportSize({ width: 320, height: 720 });
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
  await page.getByRole('textbox', { name: 'Тема', exact: true }).fill(`  ${topic}  `);
  const bookingResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  const created = await bookingResponse;
  expect(created.status()).toBe(201);
  expect((await created.json()).meeting.topic).toBe(topic);

  const confirmation = page.getByRole('region', { name: 'Подтверждение записи' });
  await expect(confirmation.getByRole('heading', { name: 'Встреча подтверждена' })).toBeVisible();
  await expect(confirmation.getByText(typeName, { exact: true })).toBeVisible();
  await expect(confirmation.getByText(topic, { exact: true })).toBeVisible();
  await expect(confirmation.locator('b')).toHaveCount(0);
  const titleBox = await confirmation.getByText(typeName, { exact: true }).boundingBox();
  const topicBox = await confirmation.getByText(topic, { exact: true }).boundingBox();
  expect(topicBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
  expect(topicBox!.x).toBeGreaterThanOrEqual(0);
  expect(topicBox!.x + topicBox!.width).toBeLessThanOrEqual(320);
  expect(await confirmation.getByText(topic, { exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    return element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
      && element.clientHeight > parseFloat(style.lineHeight) * 2
      && style.textOverflow !== 'ellipsis' && style.overflowY !== 'hidden';
  })).toBe(true);
  await expect(confirmation.getByText('17 ноября 2026 г.')).toBeVisible();
  await expect(confirmation.getByText('10:00–10:30')).toBeVisible();
  await expect(confirmation.getByText('Europe/Moscow')).toBeVisible();

  await page.goto(ownerUrl);
  const booking = upcoming.getByRole('row').filter({ hasText: guestName });
  await expect(booking.getByRole('cell', { name: typeName })).toBeVisible();
  await expect(booking.getByText(topic, { exact: true })).toHaveText(topic);
  expect(await booking.getByText(topic, { exact: true }).evaluate((element) =>
    element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
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
      topic: 'Другая тема',
      attemptId: randomUUID(),
    },
  });
  expect(secondBooking.status()).toBe(201);

  await upcoming.getByRole('button', { name: 'Обновить список' }).click();
  const rows = upcoming.getByRole('row').filter({ hasText: typeName });
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByRole('cell', { name: 'Ян' })).toBeVisible();
  await expect(rows.first().getByText('Другая тема', { exact: true })).toBeVisible();
  await page.reload();
  await expect(upcoming.getByText(topic, { exact: true })).toBeVisible();
});
