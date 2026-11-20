import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'vitest';
import type { MeetingType, UpcomingMeetings } from '../api/generated/sdk/types.gen.ts';
import { buildApp } from './app.ts';

export const opening = '2026-11-18T05:00:00Z';

export async function startCalendar(onTestFinished: TestContext['onTestFinished']) {
  let now = new Date(opening);
  const directory = await mkdtemp(join(tmpdir(), 'calendar-meetings-'));
  let app: ReturnType<typeof buildApp> | undefined;
  onTestFinished(async () => {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  app = buildApp({}, [], {
    databasePath: join(directory, 'calendar.sqlite'),
    now: () => now,
    schedule: { 3: [{ startsAt: '09:00', endsAt: '12:00' }] },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function request(path: string, options: RequestInit = {}) {
    return fetch(new URL(path, address), { signal: AbortSignal.timeout(3_000), ...options });
  }

  function post(path: string, input: unknown) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  return {
    request,
    post,
    async createType(name: string, durationMinutes = 30): Promise<MeetingType> {
      const response = await post('/api/meeting-types', {
        name,
        description: 'Обсудим ваш вопрос',
        durationMinutes,
      });
      if (response.status !== 201) throw new Error(`Creating a meeting type returned HTTP ${response.status}`);
      return response.json();
    },
    async upcoming(): Promise<UpcomingMeetings> {
      const response = await request('/api/meetings/upcoming');
      if (response.status !== 200) throw new Error(`Listing upcoming meetings returned HTTP ${response.status}`);
      return response.json();
    },
    setNow(instant: string) {
      now = new Date(instant);
    },
  };
}

export type Calendar = Awaited<ReturnType<typeof startCalendar>>;
