import { expect, test } from 'vitest';
import { buildApp } from './app.ts';

const meetingType = {
  id: 'type-1',
  name: 'Консультация',
  description: 'Обсудим ваш вопрос',
  durationMinutes: 30,
};

async function withAvailability(
  options: Parameters<typeof buildApp>[2],
  run: (getAvailability: (meetingTypeId?: string) => Promise<Response>) => Promise<void>,
) {
  const app = buildApp({}, [meetingType], options);
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await run((meetingTypeId = meetingType.id) => fetch(
      new URL(`/api/meeting-types/${meetingTypeId}/availability`, address),
      { signal: AbortSignal.timeout(3_000) },
    ));
  } finally {
    await app.close();
  }
}

test('окно записи сдвигается в полночь в Москве и включает все 14 дат даже без расписания', async () => {
  let now = new Date('2026-11-17T20:59:00Z');

  await withAvailability({ now: () => now }, async (getAvailability) => {
    const dates = [
      '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22',
      '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28',
      '2026-11-29', '2026-11-30',
    ];
    const beforeMidnight = await getAvailability();
    expect(beforeMidnight.status).toBe(200);
    await expect(beforeMidnight.json()).resolves.toEqual({
      timeZone: 'Europe/Moscow',
      days: dates.map((date) => ({ date, slots: [] })),
    });

    now = new Date('2026-11-17T21:00:00Z');

    const afterMidnight = await getAvailability();
    expect(afterMidnight.status).toBe(200);
    await expect(afterMidnight.json()).resolves.toEqual({
      timeZone: 'Europe/Moscow',
      days: [...dates.slice(1), '2026-12-01'].map((date) => ({ date, slots: [] })),
    });
  });
});

test('слоты идут от начала интервала, начинаются в будущем и могут закончиться на его границе', async () => {
  await withAvailability({
    now: () => new Date('2026-11-17T06:02:00Z'),
    schedule: {
      2: [
        { startsAt: '09:02', endsAt: '09:37' },
        { startsAt: '09:38', endsAt: '10:00' },
      ],
    },
  }, async (getAvailability) => {
    const response = await getAvailability();
    expect(response.status).toBe(200);
    const availability = await response.json();

    expect(availability.days[0]).toEqual({
      date: '2026-11-17',
      slots: [{ startsAt: '2026-11-17T06:07:00Z', endsAt: '2026-11-17T06:37:00Z' }],
    });
    expect(availability.days[1]).toEqual({ date: '2026-11-18', slots: [] });
  });
});

test('последний слот может закончиться в полночь на границе окна записи', async () => {
  await withAvailability({
    now: () => new Date('2026-11-17T05:00:00Z'),
    schedule: { 1: [{ startsAt: '23:30', endsAt: '24:00' }] },
  }, async (getAvailability) => {
    const response = await getAvailability();
    expect(response.status).toBe(200);
    const availability = await response.json();

    expect(availability.days.at(-1)).toEqual({
      date: '2026-11-30',
      slots: [{ startsAt: '2026-11-30T20:30:00Z', endsAt: '2026-11-30T21:00:00Z' }],
    });
  });
});

test('доступность неизвестного типа возвращает ошибку каталога', async () => {
  await withAvailability({}, async (getAvailability) => {
    const response = await getAvailability('unknown');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: 'MEETING_TYPE_NOT_FOUND',
      message: 'Тип встречи не найден',
    });
  });
});
