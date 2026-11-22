import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { startCalendar } from './calendar-test-fixture.ts';

test.for(['Я', '🚀', 'Я'.repeat(200), '🚀'.repeat(200), 'e\u0301'.repeat(100)])('topic boundary is counted in Unicode code points after trim: %s', async (topic, { onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');
  const response = await calendar.post('/api/meetings', {
    meetingTypeId: id, startsAt: '2026-11-18T07:00:00Z', guestName: 'Ян',
    attemptId: randomUUID(), topic: ` \t\n\u00a0${topic}\u00a0\t `,
  });
  expect(response.status).toBe(201);
  expect((await response.json()).meeting.topic).toBe(topic);
  expect((await calendar.upcoming()).meetings).toMatchObject([{ topic }]);
});

test('new booking normalizes and atomically returns the topic in confirmation and upcoming meetings', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');
  const response = await calendar.post('/api/meetings', {
    meetingTypeId: id, startsAt: '2026-11-18T07:00:00Z', guestName: 'Ян',
    attemptId: randomUUID(), topic: '  План перехода 🚀  ',
  });
  expect(response.status).toBe(201);
  const confirmation = await response.json();
  expect(confirmation.meeting.topic).toBe('План перехода 🚀');
  expect((await calendar.upcoming()).meetings).toEqual([confirmation.meeting]);
});

test('saved attempt compares normalized topic before validation, preserves payload and restores after booking window moves', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');
  const input = {
    meetingTypeId: id, startsAt: '2026-11-18T07:00:00Z', guestName: 'Ян',
    attemptId: randomUUID(), topic: 'План перехода',
  };
  const created = await calendar.post('/api/meetings', input);
  expect(created.status).toBe(201);
  const confirmation = await created.json();
  for (const topic of ['Другая тема', 'план перехода', 'План  перехода', '', ' \t ', 'Я'.repeat(201)]) {
    const response = await calendar.post('/api/meetings', { ...input, topic });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'ATTEMPT_PAYLOAD_MISMATCH', message: 'Данные попытки записи изменились' });
  }
  for (const topic of [undefined, null, 42, true, [], {}]) {
    const response = await calendar.post('/api/meetings', { ...input, topic });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR', fieldErrors: { topic: 'Укажите тему' } });
  }
  expect((await calendar.upcoming()).meetings).toEqual([confirmation.meeting]);
  for (const now of ['2026-11-18T07:01:00Z', '2026-12-10T05:00:00Z']) {
    calendar.setNow(now);
    const replay = await calendar.post('/api/meetings', { ...input, topic: ' \tПлан перехода\u00a0 ' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(confirmation);

    const mismatch = await calendar.post('/api/meetings', { ...input, topic: 'Другая тема' });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ code: 'ATTEMPT_PAYLOAD_MISMATCH', message: 'Данные попытки записи изменились' });

    const restored = await calendar.post('/api/meetings', input);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual(confirmation);
  }
  calendar.setNow('2026-11-18T05:00:00Z');
  expect((await calendar.upcoming()).meetings).toEqual([confirmation.meeting]);
});

test('new attempts reject missing, wrong-structure and invalid topics without adding a meeting', async ({ onTestFinished }) => {
  const calendar = await startCalendar(onTestFinished);
  const { id } = await calendar.createType('Консультация');
  for (const topic of [undefined, null, 42, true, [], {}, '', ' \t\n\u00a0 ', 'Я'.repeat(201), '🚀'.repeat(201), 'e\u0301'.repeat(100) + 'e']) {
    const response = await calendar.post('/api/meetings', {
      meetingTypeId: id, startsAt: '2026-11-18T07:00:00Z', guestName: 'Ян',
      attemptId: randomUUID(), topic,
    });
    expect(response.status, `topic: ${JSON.stringify(topic)}`).toBe(400);
    expect(await response.json()).toEqual({
      code: 'VALIDATION_ERROR', message: 'Проверьте поля запроса',
      fieldErrors: { topic: typeof topic === 'string' && topic.trim() !== '' ? 'Укажите тему до 200 символов' : 'Укажите тему' },
    });
  }
  for (const body of [null, [], {}, 42, 'topic']) {
    const response = await calendar.post('/api/meetings', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR', fieldErrors: { topic: 'Укажите тему' } });
  }
  expect((await calendar.upcoming()).meetings).toEqual([]);
});
