import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { buildApp } from './app.ts';

test('old SQLite and newly booked topic survive migration and reopening; replay cannot update a legacy attempt', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-topic-'));
  const databasePath = join(directory, 'calendar.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE meeting_types (
      id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL, duration_minutes INTEGER NOT NULL
    ) STRICT;
    INSERT INTO meeting_types VALUES ('type', 'Консультация', 'консультация', 'Вопросы', 30);
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, meeting_type_id TEXT NOT NULL REFERENCES meeting_types(id),
      meeting_type_name TEXT NOT NULL, guest_name TEXT NOT NULL,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE
    ) STRICT;
  `);
  const attemptId = randomUUID();
  database.prepare('INSERT INTO meetings VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'legacy', 'type', 'Консультация', 'Ян', Date.parse('2026-11-18T07:00:00Z'),
    Date.parse('2026-11-18T07:30:00Z'), attemptId,
  );
  database.close();
  let app: ReturnType<typeof buildApp> | undefined;
  onTestFinished(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = { meetingTypeId: 'type', guestName: 'Ян', startsAt: '2026-11-18T07:00:00Z', attemptId };
  const topic = '<b>Обсудить</b> ' + 'Я'.repeat(180);
  async function open() {
    app = buildApp({}, [], {
      databasePath, now: () => new Date('2026-11-18T05:00:00Z'),
      schedule: { 3: [{ startsAt: '09:00', endsAt: '18:00' }] },
    });
    return app.listen({ host: '127.0.0.1', port: 0 });
  }
  const address = await open();
  const legacy = {
    id: 'legacy', meetingTypeId: 'type', meetingTypeName: 'Консультация', guestName: 'Ян',
    startsAt: '2026-11-18T07:00:00Z', endsAt: '2026-11-18T07:30:00Z',
  };
  const initialList = await fetch(`${address}/api/meetings/upcoming`);
  expect((await initialList.json()).meetings).toEqual([legacy]);
  const newInput = { ...input, topic: `  ${topic}  `, startsAt: '2026-11-18T09:00:00Z', attemptId: randomUUID() };
  const created = await fetch(`${address}/api/meetings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(newInput),
  });
  expect(created.status).toBe(201);
  const newMeeting = (await created.json()).meeting;
  expect(newMeeting.topic).toBe(topic);
  await app!.close();
  app = undefined;
  for (let opening = 0; opening < 2; opening += 1) {
    const address = await open();
    const list = await fetch(`${address}/api/meetings/upcoming`);
    expect(list.status).toBe(200);
    const upcoming = await list.json();
    expect(upcoming.timeZone).toBe('Europe/Moscow');
    expect(upcoming.meetings[0]).toEqual(legacy);
    const replay = await fetch(`${address}/api/meetings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: 'VALIDATION_ERROR', fieldErrors: { topic: 'Укажите тему' } });
    for (const topic of ['Новая тема', '', 'Я'.repeat(201)]) {
      const legacyUpdate = await fetch(`${address}/api/meetings`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, topic }),
      });
      expect(legacyUpdate.status).toBe(409);
      expect(await legacyUpdate.json()).toMatchObject({ code: 'ATTEMPT_PAYLOAD_MISMATCH' });
    }
    const topicReplay = await fetch(`${address}/api/meetings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newInput),
    });
    expect(topicReplay.status).toBe(200);
    expect((await topicReplay.json()).meeting).toEqual(upcoming.meetings[1]);
    expect(upcoming.meetings).toEqual([legacy, newMeeting]);
    const afterReplay = await fetch(`${address}/api/meetings/upcoming`);
    expect((await afterReplay.json()).meetings).toEqual([legacy, newMeeting]);
    await app!.close();
    app = undefined;
  }
});
