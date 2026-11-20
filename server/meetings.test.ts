import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Availability } from '../api/generated/sdk/types.gen.ts';
import { startCalendar, type Calendar } from './calendar-test-fixture.ts';

function book(calendar: Calendar, meetingTypeId: string, startsAt: string, guestName = 'Ян') {
  return calendar.post('/api/meetings', { meetingTypeId, startsAt, guestName, attemptId: randomUUID() });
}

const singleBooking = {
  statuses: [201, 409],
  storedCount: 1,
  conflict: { code: 'SLOT_TAKEN', message: 'Это время уже занято' },
};

async function bookingOutcome(calendar: Calendar, requests: Promise<Response>[]) {
  const responses = await Promise.all(requests);
  return {
    statuses: responses.map(({ status }) => status).sort(),
    storedCount: (await calendar.upcoming()).meetings.length,
    conflict: await responses.find(({ status }) => status === 409)?.json(),
  };
}

test('список предстоящих встреч сортируется по времени и исключает встречу с момента начала', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  calendar.setNow('2026-11-18T06:59:59Z');
  const consultation = await calendar.createType('Консультация');
  const introduction = await calendar.createType('Знакомство', 17);
  const later = await book(calendar, consultation.id, '2026-11-18T08:00:00Z', 'Лена');
  expect(later.status).toBe(201);
  const earlier = await book(calendar, introduction.id, '2026-11-18T07:00:00Z', 'Ян');
  expect(earlier.status).toBe(201);

  expect(await calendar.upcoming()).toEqual({
    timeZone: 'Europe/Moscow',
    meetings: [
      {
        id: expect.any(String),
        meetingTypeId: introduction.id,
        meetingTypeName: 'Знакомство',
        guestName: 'Ян',
        startsAt: '2026-11-18T07:00:00Z',
        endsAt: '2026-11-18T07:17:00Z',
      },
      {
        id: expect.any(String),
        meetingTypeId: consultation.id,
        meetingTypeName: 'Консультация',
        guestName: 'Лена',
        startsAt: '2026-11-18T08:00:00Z',
        endsAt: '2026-11-18T08:30:00Z',
      },
    ],
  });

  calendar.setNow('2026-11-18T07:00:00Z');
  const { meeting } = await later.json();
  expect(await calendar.upcoming()).toEqual({ timeZone: 'Europe/Moscow', meetings: [meeting] });

  calendar.setNow('2026-11-18T08:01:00Z');
  expect(await calendar.upcoming()).toEqual({ timeZone: 'Europe/Moscow', meetings: [] });
});

test('две параллельные записи на одинаковый слот сохраняют только одну встречу', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');

  expect(await bookingOutcome(calendar, [
    book(calendar, id, '2026-11-18T07:00:00Z', 'Ян'),
    book(calendar, id, '2026-11-18T07:00:00Z', 'Лена'),
  ])).toEqual(singleBooking);
});

test('две параллельные записи на пересекающиеся слоты разных типов сохраняют только одну встречу', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const consultation = await calendar.createType('Консультация');
  const interview = await calendar.createType('Собеседование');

  expect(await bookingOutcome(calendar, [
    book(calendar, consultation.id, '2026-11-18T07:00:00Z', 'Ян'),
    book(calendar, interview.id, '2026-11-18T07:15:00Z', 'Лена'),
  ])).toEqual(singleBooking);
});

test('две параллельные записи на частично пересекающиеся слоты типов разной длительности сохраняют только одну встречу', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const consultation = await calendar.createType('Консультация', 60);
  const interview = await calendar.createType('Собеседование', 30);

  expect(await bookingOutcome(calendar, [
    book(calendar, consultation.id, '2026-11-18T07:00:00Z', 'Ян'),
    book(calendar, interview.id, '2026-11-18T07:45:00Z', 'Лена'),
  ])).toEqual(singleBooking);
});

test('запись исключает пересечения из доступности всех типов и разрешает начало сразу после встречи', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const introduction = await calendar.createType('Знакомство', 17);
  const consultation = await calendar.createType('Консультация');

  const first = await book(calendar, introduction.id, '2026-11-18T06:00:00Z', '  Ян  ');
  expect(first.status).toBe(201);
  await expect(first.json()).resolves.toEqual({
    timeZone: 'Europe/Moscow',
    meeting: {
      id: expect.any(String),
      meetingTypeId: introduction.id,
      meetingTypeName: 'Знакомство',
      guestName: 'Ян',
      startsAt: '2026-11-18T06:00:00Z',
      endsAt: '2026-11-18T06:17:00Z',
    },
  });

  const response = await calendar.request(`/api/meeting-types/${consultation.id}/availability`);
  expect(response.status).toBe(200);
  const availability: Availability = await response.json();
  expect(availability.days[0]).toMatchObject({ date: '2026-11-18' });
  expect(availability.days[0].slots[0]).toEqual({
    startsAt: '2026-11-18T06:17:00Z',
    endsAt: '2026-11-18T06:47:00Z',
  });
  expect(availability.days[0].slots).not.toContainEqual(expect.objectContaining({ startsAt: '2026-11-18T06:15:00Z' }));

  const adjacent = await book(calendar, consultation.id, '2026-11-18T06:17:00Z');
  expect(adjacent.status).toBe(201);
});

test('запись отклоняет пустое и слишком длинное имя с подсказкой для поля', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');

  const emptyName = await book(calendar, id, '2026-11-18T07:00:00Z', '  ');
  expect(emptyName.status).toBe(400);
  await expect(emptyName.json()).resolves.toEqual({
    code: 'VALIDATION_ERROR',
    message: 'Проверьте поля запроса',
    fieldErrors: { guestName: 'Укажите имя' },
  });

  const longName = await book(calendar, id, '2026-11-18T07:00:00Z', 'Я'.repeat(81));
  expect(longName.status).toBe(400);
  await expect(longName.json()).resolves.toMatchObject({
    code: 'VALIDATION_ERROR',
    fieldErrors: { guestName: 'Укажите имя до 80 символов' },
  });
  expect((await calendar.upcoming()).meetings).toHaveLength(0);
});

test('запись возвращает согласованную ошибку при неверном формате запроса', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');

  const invalid = await calendar.post('/api/meetings', {
    meetingTypeId: id,
    startsAt: '2026-11-31T07:00:00Z',
    guestName: 'Ян',
    attemptId: 'no-uuid',
  });
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toMatchObject({
    code: 'VALIDATION_ERROR',
    fieldErrors: { startsAt: expect.any(String), attemptId: expect.any(String) },
  });

  const invalidJson = await calendar.request('/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  expect(invalidJson.status).toBe(400);
  await expect(invalidJson.json()).resolves.toEqual({ code: 'VALIDATION_ERROR', message: 'Проверьте поля запроса' });
  expect((await calendar.upcoming()).meetings).toHaveLength(0);
});

test('запись возвращает ошибку для неизвестного типа встречи', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);

  const response = await book(calendar, 'unknown', '2026-11-18T07:00:00Z');
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    code: 'MEETING_TYPE_NOT_FOUND',
    message: 'Тип встречи не найден',
  });
});

test('запись повторно проверяет время и ограничения слота при подтверждении', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');

  const availabilityResponse = await calendar.request(`/api/meeting-types/${id}/availability`);
  const availability: Availability = await availabilityResponse.json();
  expect(availability.days[0].slots[0]?.startsAt).toBe('2026-11-18T06:00:00Z');
  calendar.setNow('2026-11-18T06:00:00Z');

  for (const start of [
    '2026-11-18T06:00:00Z',
    '2026-11-18T06:01:00Z',
    '2026-11-18T06:05:00.0001Z',
    '2026-11-18T08:35:00Z',
    '2026-12-02T06:00:00Z',
  ]) {
    const response = await book(calendar, id, start);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: 'SLOT_UNAVAILABLE',
      message: 'Это время больше недоступно',
    });
  }
  expect((await calendar.upcoming()).meetings).toHaveLength(0);
});
