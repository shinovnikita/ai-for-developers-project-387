import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { CreateMeetingTypeInput, MeetingType, MeetingTypeNotFound } from '../api/generated/sdk/types.gen.ts';
import type { ApiRoute } from './api-route.ts';
import { handleInvalidRequest, validationError } from './validation-error.ts';

export const meetingTypeNotFound = {
  code: 'MEETING_TYPE_NOT_FOUND',
  message: 'Тип встречи не найден',
} satisfies MeetingTypeNotFound;

type MeetingTypeRequest = Partial<Record<keyof CreateMeetingTypeInput, unknown>>;

function validateMeetingType(body: MeetingTypeRequest | null | undefined) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const durationMinutes = body?.durationMinutes;
  const validName = name !== '' && [...name].length <= 80;
  const validDescription = description !== '' && [...description].length <= 500;
  const validDuration = typeof durationMinutes === 'number'
    && Number.isInteger(durationMinutes) && durationMinutes >= 5 && durationMinutes <= 120;

  if (validName && validDescription && validDuration) {
    return { input: { name, description, durationMinutes } };
  }

  const fieldErrors: Partial<Record<keyof CreateMeetingTypeInput, string>> = {};
  if (!validName) fieldErrors.name = 'Укажите название от 1 до 80 символов';
  if (!validDescription) fieldErrors.description = 'Укажите описание от 1 до 500 символов';
  if (!validDuration) fieldErrors.durationMinutes = 'Укажите целое число от 5 до 120 минут';
  return { fieldErrors };
}

export function createMeetingTypeCatalog(database: DatabaseSync, seed: readonly MeetingType[]) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meeting_types (
      id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL
    ) STRICT
  `);

  const insert = database.prepare(`
    INSERT INTO meeting_types (id, name, normalized_name, description, duration_minutes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const select = `SELECT id, name, description, duration_minutes AS durationMinutes FROM meeting_types`;
  const list = database.prepare(`${select} ORDER BY rowid DESC`);
  const find = database.prepare(`${select} WHERE id = ?`);

  function save({ id, name, description, durationMinutes }: MeetingType) {
    return insert.run(id, name, name.trim().toLowerCase(), description, durationMinutes).changes === 1;
  }

  for (const initialType of seed.toReversed()) {
    save(initialType);
  }

  return {
    list() {
      return list.all() as MeetingType[];
    },
    find(id: string) {
      return find.get(id) as MeetingType | undefined;
    },
    create(input: CreateMeetingTypeInput) {
      const meetingType = { id: randomUUID(), ...input };
      return save(meetingType) ? meetingType : undefined;
    },
  };
}

export function registerMeetingTypeRoutes(
  app: FastifyInstance,
  catalog: ReturnType<typeof createMeetingTypeCatalog>,
) {
  app.get<ApiRoute<'listMeetingTypes'>>('/api/meeting-types', async (_request, reply) => {
    return reply.code(200).send(catalog.list());
  });
  app.post<Omit<ApiRoute<'createMeetingType'>, 'Body'> & { Body: MeetingTypeRequest | null | undefined }>('/api/meeting-types', {
    errorHandler: handleInvalidRequest,
  }, async (request, reply) => {
    const { input, fieldErrors } = validateMeetingType(request.body);
    if (!input) {
      return reply.code(400).send({ ...validationError, fieldErrors });
    }

    const meetingType = catalog.create(input);
    if (!meetingType) {
      return reply.code(409).send({
        code: 'MEETING_TYPE_NAME_TAKEN',
        message: 'Тип с таким названием уже есть',
        fieldErrors: { name: 'Укажите другое название' },
      });
    }

    return reply.code(201).send(meetingType);
  });
}
