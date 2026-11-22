import { expect, type Page } from '@playwright/test';
import type { CreateMeetingInput } from '../api/generated/sdk/types.gen.ts';
import { test } from './fixtures.ts';

async function selectSlot(page: Page, webOrigin: string) {
  await page.goto(new URL('/booking', webOrigin).href);
  await page.getByRole('button', { name: 'Выбрать Консультация' }).click();
  await page.getByRole('button', { name: 'вт, 17 нояб.' }).click();
  await page.getByRole('button', { name: '09:00–09:30' }).click();
  await page.getByRole('textbox', { name: 'Имя' }).fill('Ян');
}

test.beforeEach(async ({ calendar, request }) => {
  const response = await request.post(`${calendar.apiOrigin}/api/meeting-types`, {
    data: { name: 'Консультация', description: 'Вопросы', durationMinutes: 30 },
  });
  expect(response.status()).toBe(201);
});

for (const [label, topic] of [
  ['one code point', '🚀'],
  ['200 Cyrillic code points', 'Я'.repeat(200)],
  ['200 astral code points', '🚀'.repeat(200)],
  ['200 combining code points', 'e\u0301'.repeat(100)],
]) {
  test(`form accepts ${label} after trimming without raw length restriction`, async ({ calendar, page }) => {
    await selectSlot(page, calendar.webOrigin);
    await page.getByRole('textbox', { name: 'Тема', exact: true }).fill(` \u00a0${topic}\u00a0 `);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Подтвердить запись' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON().topic).toBe(topic);
    expect((await response.json()).meeting.topic).toBe(topic);
    await expect(page.getByRole('region', { name: 'Подтверждение записи' }).getByText(topic, { exact: true })).toBeVisible();
  });
}

test('form shows topic field error from real server and confirmation uses server topic rather than draft', async ({ calendar, page, request }) => {
  await selectSlot(page, calendar.webOrigin);
  const field = page.getByRole('textbox', { name: 'Тема', exact: true });
  await field.fill('Черновик гостя');
  // Send malformed input to the real server, preserving its actual validation response.
  await page.route('**/api/meetings', (route) => route.continue({
    postData: JSON.stringify({ ...route.request().postDataJSON(), topic: null }),
  }), { times: 1 });
  const errorPromise = page.waitForResponse((response) => response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  const error = await errorPromise;
  expect(error.status()).toBe(400);
  expect(await error.json()).toMatchObject({ fieldErrors: { topic: 'Укажите тему' } });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Укажите тему', { exact: true })).toBeVisible();
  const list = await request.get(`${calendar.apiOrigin}/api/meetings/upcoming`);
  expect((await list.json()).meetings).toEqual([]);

  await field.fill('Исправленный черновик');
  // Change only the outgoing request. Success still comes from Fastify + SQLite.
  await page.route('**/api/meetings', (route) => route.continue({
    postData: JSON.stringify({ ...route.request().postDataJSON(), topic: '  Сохранено сервером 🚀  ' }),
  }), { times: 1 });
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  const confirmation = page.getByRole('region', { name: 'Подтверждение записи' });
  await expect(confirmation.getByText('Сохранено сервером 🚀', { exact: true })).toBeVisible();
  await expect(confirmation.getByText('Исправленный черновик', { exact: true })).toHaveCount(0);
  const saved = await request.get(`${calendar.apiOrigin}/api/meetings/upcoming`);
  expect((await saved.json()).meetings).toMatchObject([{ topic: 'Сохранено сервером 🚀' }]);
});

test('editing topic after lost actual response invalidates the attempt and does not update saved meeting', async ({ calendar, page, request }) => {
  await selectSlot(page, calendar.webOrigin);
  const field = page.getByRole('textbox', { name: 'Тема', exact: true });
  await field.fill('Исходная тема');
  let original: CreateMeetingInput | undefined;
  await page.route('**/api/meetings', async (route) => {
    original = route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(201);
    await route.abort();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  await expect(page.getByRole('button', { name: 'Повторить отправку' })).toBeVisible();
  await field.fill('Изменённая тема');
  await expect(page.getByRole('button', { name: 'Повторить отправку' })).toHaveCount(0);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  const response = await responsePromise;
  expect(response.request().postDataJSON()).toMatchObject({ topic: 'Изменённая тема' });
  expect(response.request().postDataJSON().attemptId).not.toBe(original?.attemptId);
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'SLOT_TAKEN' });
  await expect(page.getByRole('alert')).toHaveText('Это время уже занято');
  const list = await request.get(`${calendar.apiOrigin}/api/meetings/upcoming`);
  expect((await list.json()).meetings).toMatchObject([{ topic: 'Исходная тема' }]);
  await page.getByRole('button', { name: '09:30–10:00' }).click();
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  await expect(page.getByRole('region', { name: 'Подтверждение записи' }).getByText('Изменённая тема', { exact: true })).toBeVisible();
});

test('form rejects empty, whitespace and 201 code points locally, then accepts correction', async ({ calendar, page }) => {
  await selectSlot(page, calendar.webOrigin);
  const topic = page.getByRole('textbox', { name: 'Тема', exact: true });
  await expect(topic).toBeVisible({ timeout: 3000 });
  await expect(topic).toHaveAttribute('required', '');
  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/meetings') && request.method() === 'POST') requests.push(request.postDataJSON());
  });
  for (const value of ['', ' \t\u00a0 ', 'Я'.repeat(201), '🚀'.repeat(201)]) {
    await topic.fill(value);
    await page.getByRole('button', { name: 'Подтвердить запись' }).click();
    await expect(topic).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(value.trim() ? 'Укажите тему до 200 символов' : 'Укажите тему', { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
  }
  await topic.fill('  Обсудить план  ');
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/meetings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().topic).toBe('Обсудить план');
  await expect(page.getByRole('region', { name: 'Подтверждение записи' }).getByText('Обсудить план', { exact: true })).toBeVisible();
});
