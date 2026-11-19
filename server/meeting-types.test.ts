import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildApp } from './app.ts';

const validInput = {
  name: 'Консультация',
  description: 'Обсудим ваш вопрос',
  durationMinutes: 30,
};

async function startCatalog(app: ReturnType<typeof buildApp>) {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return new URL('/api/meeting-types', address);
}

function postMeetingType(url: URL, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
}

async function getCatalog(app: ReturnType<typeof buildApp>) {
  try {
    const response = await fetch(await startCatalog(app), { signal: AbortSignal.timeout(3_000) });

    return { status: response.status, body: await response.json() };
  } finally {
    await app.close();
  }
}

test('GET /api/meeting-types возвращает каталог типов встреч', async () => {
  const app = buildApp({}, [
    { id: 'type-1', name: 'Консультация', description: 'Обсудим ваш вопрос', durationMinutes: 30 },
  ]);

  await expect(getCatalog(app)).resolves.toEqual({
    status: 200,
    body: [
      { id: 'type-1', name: 'Консультация', description: 'Обсудим ваш вопрос', durationMinutes: 30 },
    ],
  });
});

test('GET /api/meeting-types возвращает пустой массив, пока нет типов встреч', async () => {
  await expect(getCatalog(buildApp())).resolves.toEqual({ status: 200, body: [] });
});

test('POST /api/meeting-types создаёт тип встречи первым в каталоге', async () => {
  const initialType = {
    id: 'type-1',
    name: 'Знакомство',
    description: 'Первая встреча',
    durationMinutes: 15,
  };
  const app = buildApp({}, [initialType]);

  try {
    const url = await startCatalog(app);
    const created = await postMeetingType(url, {
      name: '  Консультация ',
      description: ' Обсудим ваш вопрос  ',
      durationMinutes: 30,
    });

    expect(created.status).toBe(201);
    const createdType = await created.json();
    expect(createdType).toEqual({
      id: expect.any(String),
      ...validInput,
    });
    expect(createdType.id).not.toBe('');

    const catalog = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual([createdType, initialType]);
  } finally {
    await app.close();
  }
});

test('POST /api/meeting-types сообщает обо всех отсутствующих обязательных полях', async ({ onTestFinished }) => {
  const app = buildApp();
  onTestFinished(() => app.close());
  const url = await startCatalog(app);
  const response = await postMeetingType(url, {});

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    code: 'VALIDATION_ERROR',
    message: expect.any(String),
    fieldErrors: {
      name: expect.any(String),
      description: expect.any(String),
      durationMinutes: expect.any(String),
    },
  });
});

test.for([
  { field: 'name', value: '   ', reason: 'пустое название' },
  { field: 'name', value: ` ${'Н'.repeat(81)} `, reason: 'название длиннее 80 символов' },
  { field: 'description', value: '   ', reason: 'пустое описание' },
  { field: 'description', value: ` ${'О'.repeat(501)} `, reason: 'описание длиннее 500 символов' },
  { field: 'durationMinutes', value: 4, reason: 'длительность меньше 5 минут' },
  { field: 'durationMinutes', value: 121, reason: 'длительность больше 120 минут' },
  { field: 'durationMinutes', value: 5.5, reason: 'дробная длительность' },
  { field: 'durationMinutes', value: '30', reason: 'строка вместо числа' },
])('POST /api/meeting-types отклоняет значение: $reason', async ({ field, value }, { onTestFinished }) => {
  const app = buildApp();
  onTestFinished(() => app.close());
  const url = await startCatalog(app);
  const response = await postMeetingType(url, { ...validInput, [field]: value });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    code: 'VALIDATION_ERROR',
    message: expect.any(String),
    fieldErrors: { [field]: expect.any(String) },
  });
});

test.for([
  { name: 'Н', description: 'О', durationMinutes: 5 },
  { name: 'Н'.repeat(80), description: 'О'.repeat(500), durationMinutes: 120 },
])('POST /api/meeting-types принимает границы длины и длительность $durationMinutes минут', async (input, { onTestFinished }) => {
  const app = buildApp();
  onTestFinished(() => app.close());
  const url = await startCatalog(app);
  const response = await postMeetingType(url, {
    ...input,
    name: ` ${input.name} `,
    description: ` ${input.description} `,
  });

  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual({ id: expect.any(String), ...input });
});

test('POST /api/meeting-types отклоняет повтор названия с другим регистром или пробелами по краям', async ({ onTestFinished }) => {
  const app = buildApp();
  onTestFinished(() => app.close());
  const url = await startCatalog(app);
  const first = await postMeetingType(url, validInput);
  expect(first.status).toBe(201);

  for (const name of ['консультация', ' Консультация ']) {
    const duplicate = await postMeetingType(url, { ...validInput, name });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      code: 'MEETING_TYPE_NAME_TAKEN',
      message: expect.any(String),
      fieldErrors: { name: expect.any(String) },
    });
  }
});

test('GET /api/meeting-types возвращает сохранённый идентификатор после перезапуска сервера', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'call-calendar-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'calendar.sqlite');
  const app = buildApp({}, [], { databasePath });
  let created;

  try {
    const response = await postMeetingType(await startCatalog(app), validInput);
    expect(response.status).toBe(201);
    created = await response.json();
  } finally {
    await app.close();
  }

  const restarted = buildApp({}, [], { databasePath });
  await expect(getCatalog(restarted)).resolves.toEqual({ status: 200, body: [created] });
});
