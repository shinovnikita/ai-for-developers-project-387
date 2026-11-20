import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { MeetingType } from '../api/generated/sdk/types.gen.ts';
import { test } from './fixtures.ts';

test('гость выбирает другое время после конфликта записи', async ({ calendar, page, request }) => {
  const typeName = 'Консультация';
  const guestName = 'Анна';
  const meetingTypeResponse = await request.post(`${calendar.apiOrigin}/api/meeting-types`, {
    data: { name: typeName, description: 'Обсудим ваш вопрос', durationMinutes: 30 },
  });
  expect(meetingTypeResponse.status()).toBe(201);
  const meetingType: MeetingType = await meetingTypeResponse.json();

  await page.goto(new URL('/booking', calendar.webOrigin).href);
  const typeButton = page.getByRole('button', { name: `Выбрать ${typeName}` });
  await typeButton.click();
  await page.getByRole('button', { name: 'вт, 17 нояб.' }).click();

  const slots = page.getByRole('group', { name: 'Время', exact: true });
  const originalSlot = slots.getByRole('button', { name: '09:00–09:30' });
  await originalSlot.click();
  await expect(originalSlot).toHaveAttribute('aria-pressed', 'true');
  const nameField = page.getByRole('textbox', { name: 'Имя' });
  await nameField.fill(guestName);

  const reservation = await request.post(`${calendar.apiOrigin}/api/meetings`, {
    data: {
      meetingTypeId: meetingType.id,
      startsAt: '2026-11-17T06:00:00Z',
      guestName: 'Другой гость',
      attemptId: randomUUID(),
    },
  });
  expect(reservation.status()).toBe(201);

  const submit = page.getByRole('button', { name: 'Подтвердить запись' });
  const conflictResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await submit.click();
  const conflict = await conflictResponse;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'SLOT_TAKEN' });
  await expect(page.getByRole('alert')).toHaveText(/Это время уже занято/);
  await expect(originalSlot).toHaveCount(0);
  await expect(slots.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(typeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(nameField).toHaveValue(guestName);
  await expect(submit).toBeDisabled();

  await slots.getByRole('button', { name: '09:30–10:00' }).click();
  await submit.click();

  const confirmation = page.getByRole('region', { name: 'Подтверждение записи' });
  await expect(confirmation.getByRole('heading', { name: 'Встреча подтверждена' })).toBeVisible();
  await expect(confirmation.getByText(typeName, { exact: true })).toBeVisible();
  await expect(confirmation.getByText('17 ноября 2026 г.')).toBeVisible();
  await expect(confirmation.getByText('09:30–10:00')).toBeVisible();
  await expect(confirmation.getByText('Europe/Moscow')).toBeVisible();
});
