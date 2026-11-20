import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { CreateMeetingInput, Meeting, MeetingConfirmation, Slot, UpcomingMeetings } from '../api/generated/sdk/types.gen.ts';
import { calendarTimeZone } from '../shared/calendar-time.ts';
import type { ApiRoute } from './api-route.ts';
import { getSlot, overlaps, utcTimestamp, type WeeklySchedule } from './availability.ts';
import { meetingTypeNotFound, type createMeetingTypeCatalog } from './meeting-types.ts';
import { handleInvalidRequest, validationError } from './validation-error.ts';

type MeetingRequest = Partial<Record<keyof CreateMeetingInput, unknown>> | null | undefined;

function meetingFromRow(row: Record<string, SQLOutputValue>): Meeting {
  return {
    id: String(row.id),
    meetingTypeId: String(row.meeting_type_id),
    meetingTypeName: String(row.meeting_type_name),
    guestName: String(row.guest_name),
    startsAt: utcTimestamp(Number(row.starts_at)),
    endsAt: utcTimestamp(Number(row.ends_at)),
  };
}

const utcDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?Z$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function parseStart(value: unknown) {
  if (typeof value !== 'string') return;
  const match = utcDateTime.exec(value);
  if (!match) return;

  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return;

  // Date.parse truncates fractions beyond milliseconds.
  return { time, hasSubMillisecondRemainder: /[1-9]/.test(match[1]?.slice(3) ?? '') };
}

function hasBookingShape(body: MeetingRequest): body is CreateMeetingInput {
  return typeof body?.meetingTypeId === 'string'
    && typeof body.startsAt === 'string'
    && typeof body.guestName === 'string'
    && typeof body.attemptId === 'string';
}

function bookingFieldErrors(body: MeetingRequest, start = parseStart(body?.startsAt)) {
  const fieldErrors: Partial<Record<keyof CreateMeetingInput, string>> = {};
  const guestName = typeof body?.guestName === 'string' ? body.guestName.trim() : '';

  if (typeof body?.meetingTypeId !== 'string' || body.meetingTypeId.trim() === '') {
    fieldErrors.meetingTypeId = 'Выберите тип встречи';
  }
  if (!start) fieldErrors.startsAt = 'Укажите время начала в UTC';
  if (guestName === '') fieldErrors.guestName = 'Укажите имя';
  else if ([...guestName].length > 80) fieldErrors.guestName = 'Укажите имя до 80 символов';
  if (typeof body?.attemptId !== 'string' || !uuid.test(body.attemptId)) {
    fieldErrors.attemptId = 'Укажите UUID попытки записи';
  }

  return fieldErrors;
}

export function createMeetingStore(
  database: DatabaseSync,
  catalog: ReturnType<typeof createMeetingTypeCatalog>,
  now: () => Date,
  schedule?: WeeklySchedule,
) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      meeting_type_id TEXT NOT NULL REFERENCES meeting_types(id),
      meeting_type_name TEXT NOT NULL,
      guest_name TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE
    ) STRICT
  `);

  const selectUpcoming = database.prepare(`
    SELECT id, meeting_type_id, meeting_type_name, guest_name, starts_at, ends_at
    FROM meetings WHERE starts_at > ? ORDER BY starts_at ASC
  `);

  const selectActive = database.prepare('SELECT starts_at, ends_at FROM meetings WHERE ends_at > ?');
  const selectAttempt = database.prepare(`
    SELECT id, meeting_type_id, meeting_type_name, guest_name, starts_at, ends_at
    FROM meetings WHERE attempt_id = ?
  `);
  const insert = database.prepare(`
    INSERT INTO meetings (id, meeting_type_id, meeting_type_name, guest_name, starts_at, ends_at, attempt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function listActiveSlots(currentTime: Date): Slot[] {
    return selectActive.all(currentTime.getTime()).map(({ starts_at, ends_at }) => ({
      startsAt: utcTimestamp(Number(starts_at)),
      endsAt: utcTimestamp(Number(ends_at)),
    }));
  }

  function save(input: CreateMeetingInput) {
    const { meetingTypeId } = input;
    const guestName = input.guestName.trim();
    const attemptId = input.attemptId.toLowerCase();
    const start = parseStart(input.startsAt);
    const saved = selectAttempt.get(attemptId);
    if (saved) {
      if (saved.meeting_type_id !== meetingTypeId
        || saved.guest_name !== guestName
        || !start || start.hasSubMillisecondRemainder || saved.starts_at !== start.time) {
        return { status: 409, body: { code: 'ATTEMPT_PAYLOAD_MISMATCH', message: 'Данные попытки записи изменились' } } as const;
      }

      const meeting = meetingFromRow(saved);
      return { status: 200, body: { timeZone: calendarTimeZone, meeting } satisfies MeetingConfirmation } as const;
    }

    const fieldErrors = bookingFieldErrors(input, start);
    if (!start || Object.keys(fieldErrors).length > 0) {
      return { status: 400, body: { ...validationError, fieldErrors } } as const;
    }

    const meetingType = catalog.find(meetingTypeId);
    if (!meetingType) return { status: 404, body: meetingTypeNotFound } as const;

    const currentTime = now();
    const activeSlots = listActiveSlots(currentTime);
    const slot = start.hasSubMillisecondRemainder
      ? undefined
      : getSlot(meetingType.durationMinutes, start.time, currentTime, schedule, activeSlots);
    if (!slot) {
      return { status: 422, body: { code: 'SLOT_UNAVAILABLE', message: 'Это время больше недоступно' } } as const;
    }
    if (activeSlots.some((meeting) => overlaps(slot, meeting))) {
      return { status: 409, body: { code: 'SLOT_TAKEN', message: 'Это время уже занято' } } as const;
    }

    const meeting: Meeting = {
      id: randomUUID(),
      meetingTypeId,
      meetingTypeName: meetingType.name,
      guestName,
      ...slot,
    };
    insert.run(meeting.id, meetingTypeId, meetingType.name, guestName, start.time, Date.parse(slot.endsAt), attemptId);

    return { status: 201, body: { timeZone: calendarTimeZone, meeting } satisfies MeetingConfirmation } as const;
  }

  return {
    listActiveSlots,
    book(input: CreateMeetingInput) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = save(input);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    listUpcoming(): UpcomingMeetings {
      return {
        timeZone: calendarTimeZone,
        meetings: selectUpcoming.all(now().getTime()).map(meetingFromRow),
      };
    },
  };
}

export function registerMeetingRoutes(app: FastifyInstance, meetings: ReturnType<typeof createMeetingStore>) {
  app.post<Omit<ApiRoute<'createMeeting'>, 'Body'> & { Body: MeetingRequest }>('/api/meetings', {
    errorHandler: handleInvalidRequest,
  }, async (request, reply) => {
    if (!hasBookingShape(request.body)) {
      return reply.code(400).send({ ...validationError, fieldErrors: bookingFieldErrors(request.body) });
    }

    const { status, body } = meetings.book(request.body);
    return reply.code(status).send(body);
  });

  app.get<ApiRoute<'listUpcomingMeetings'>>('/api/meetings/upcoming', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').code(200).send(meetings.listUpcoming());
  });
}
