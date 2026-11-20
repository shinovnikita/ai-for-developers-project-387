import Fastify, { type FastifyServerOptions } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { MeetingType } from '../api/generated/sdk/types.gen.ts';
import type { ApiRoute } from './api-route.ts';
import { getAvailability, type WeeklySchedule } from './availability.ts';
import { createMeetingTypeCatalog, meetingTypeNotFound, registerMeetingTypeRoutes } from './meeting-types.ts';
import { createMeetingStore, registerMeetingRoutes } from './meetings.ts';

export type CalendarOptions = {
  databasePath?: string;
  now?: () => Date;
  schedule?: WeeklySchedule;
};

export function buildApp(
  options: FastifyServerOptions = {},
  seed: readonly MeetingType[] = [],
  { databasePath = ':memory:', now = () => new Date(), schedule }: CalendarOptions = {},
) {
  const app = Fastify(options);
  const database = new DatabaseSync(databasePath, { timeout: 3_000 });
  app.addHook('onClose', async () => database.close());
  const catalog = createMeetingTypeCatalog(database, seed);
  const meetings = createMeetingStore(database, catalog, now, schedule);

  app.get('/health', async () => ({ status: 'ok' }));
  registerMeetingTypeRoutes(app, catalog);
  registerMeetingRoutes(app, meetings);
  app.get<ApiRoute<'getMeetingTypeAvailability'>>(
    '/api/meeting-types/:meetingTypeId/availability',
    async (request, reply) => {
      const meetingType = catalog.find(request.params.meetingTypeId);
      if (!meetingType) {
        return reply.code(404).send(meetingTypeNotFound);
      }

      const currentTime = now();
      const availability = getAvailability(meetingType.durationMinutes, currentTime, schedule, meetings.listActiveSlots(currentTime));
      return reply.code(200).send(availability);
    },
  );

  return app;
}
