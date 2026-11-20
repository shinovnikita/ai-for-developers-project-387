import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { readWeeklySchedule } from './working-hours.ts';

const demoCatalog = [
  { id: 'type-1', name: 'Консультация', description: 'Обсудим ваш вопрос', durationMinutes: 30 },
];
const demo = process.argv.includes('--demo-catalog');
const app = buildApp({ logger: true }, demo ? demoCatalog : [], {
  databasePath: demo ? ':memory:' : (process.env.CALENDAR_DB_PATH ?? 'calendar.sqlite'),
  schedule: readWeeklySchedule(process.env.CALENDAR_SCHEDULE),
});

if (process.env.NODE_ENV === 'production') {
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../frontend/dist/', import.meta.url)),
    index: false,
  });
  for (const path of ['/', '/booking', '/owner']) {
    app.get(path, async (_request, reply) => reply.sendFile('index.html'));
  }
}

try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
