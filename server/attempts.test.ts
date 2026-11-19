import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { CreateMeetingInput, MeetingConfirmation } from '../api/generated/sdk/types.gen.ts';
import { opening, startCalendar, type Calendar } from './calendar-test-fixture.ts';

async function startAttempt(calendar: Calendar) {
  const { id } = await calendar.createType('Консультация');
  const input: CreateMeetingInput = {
    meetingTypeId: id,
    startsAt: '2026-11-18T07:00:00Z',
    guestName: 'Ян',
    attemptId: randomUUID(),
  };
  return {
    input,
    book: (booking = input) => calendar.post('/api/meetings', booking),
  };
}

test('повтор сохранённой попытки возвращает ту же встречу после её начала', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { book, input } = await startAttempt(calendar);
  const first = await book();
  expect(first.status).toBe(201);
  const confirmation: MeetingConfirmation = await first.json();

  calendar.setNow('2026-11-18T07:01:00Z');
  const replay = await book({
    ...input,
    startsAt: '2026-11-18T07:00:00.0000Z',
    guestName: '  Ян  ',
    attemptId: input.attemptId.toUpperCase(),
  });
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toEqual(confirmation);

  calendar.setNow(opening);
  expect((await calendar.upcoming()).meetings).toEqual([confirmation.meeting]);
});

test('сохранённая попытка отклоняет изменение имени, типа или времени', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { book, input } = await startAttempt(calendar);
  const first = await book();
  expect(first.status).toBe(201);
  const confirmation: MeetingConfirmation = await first.json();

  for (const change of [
    { guestName: 'Лена' },
    { guestName: '' },
    { guestName: '  ' },
    { guestName: 'Я'.repeat(81) },
    { meetingTypeId: 'unknown' },
    { meetingTypeId: '  ' },
    { startsAt: '2026-11-18T04:00:00Z' },
    { startsAt: '2026-11-18T07:00:00.0001Z' },
  ]) {
    const replay = await book({ ...input, ...change });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      code: 'ATTEMPT_PAYLOAD_MISMATCH',
      message: 'Данные попытки записи изменились',
    });
  }

  const malformed = await calendar.post('/api/meetings', { ...input, guestName: 42 });
  expect(malformed.status).toBe(400);
  await expect(malformed.json()).resolves.toEqual({
    code: 'VALIDATION_ERROR',
    message: 'Проверьте поля запроса',
    fieldErrors: { guestName: 'Укажите имя' },
  });

  const replay = await book();
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toEqual(confirmation);
  expect((await calendar.upcoming()).meetings).toEqual([confirmation.meeting]);
});
