import type { Availability, Slot } from '../api/generated/sdk/types.gen.ts';
import {
  calendarDate, calendarMidnight, calendarTimeZone, shiftCalendarDate,
} from '../shared/calendar-time.ts';

type WorkingInterval = { startsAt: string; endsAt: string };
export type WeeklySchedule = Partial<Record<number, readonly WorkingInterval[]>>;

const windowDays = 14;
const minuteMilliseconds = 60_000;
const slotStep = 5 * minuteMilliseconds;

function wallTimeMilliseconds(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours * 60 + minutes) * minuteMilliseconds;
}

function candidateStarts(
  date: string,
  duration: number,
  now: number,
  windowEnd: number,
  schedule: WeeklySchedule | undefined,
  meetings: readonly Slot[],
) {
  const weekday = new Date(date).getUTCDay();
  const midnight = calendarMidnight(date);
  const candidates = new Set<number>();
  const meetingEnds = meetings.map(({ endsAt }) => Date.parse(endsAt));

  for (const interval of schedule?.[weekday] ?? []) {
    const start = midnight + wallTimeMilliseconds(interval.startsAt);
    const end = midnight + wallTimeMilliseconds(interval.endsAt);
    const latestStart = Math.min(end, windowEnd) - duration;
    const firstStep = Math.max(0, Math.floor((now - start) / slotStep) + 1);

    for (let candidate = start + firstStep * slotStep; candidate <= latestStart; candidate += slotStep) {
      candidates.add(candidate);
    }
    for (const candidate of meetingEnds) {
      if (candidate >= start && candidate > now && candidate <= latestStart) {
        candidates.add(candidate);
      }
    }
  }

  return [...candidates].sort((left, right) => left - right);
}

export function utcTimestamp(time: number) {
  return new Date(time).toISOString().replace('.000Z', 'Z');
}

function makeSlot(startsAtMs: number, duration: number): Slot {
  return {
    startsAt: utcTimestamp(startsAtMs),
    endsAt: utcTimestamp(startsAtMs + duration),
  };
}

export function overlaps(slot: Slot, meeting: Slot) {
  return Date.parse(slot.startsAt) < Date.parse(meeting.endsAt)
    && Date.parse(meeting.startsAt) < Date.parse(slot.endsAt);
}

export function getSlot(
  durationMinutes: number,
  startsAtMs: number,
  now: Date,
  schedule?: WeeklySchedule,
  meetings: readonly Slot[] = [],
) {
  const today = calendarDate(now);
  const windowEnd = shiftCalendarDate(today, windowDays);
  const date = calendarDate(startsAtMs);
  if (date < today || date >= windowEnd) return undefined;

  const duration = durationMinutes * minuteMilliseconds;
  const candidates = candidateStarts(
    date, duration, now.getTime(), calendarMidnight(windowEnd), schedule, meetings,
  );
  return candidates.includes(startsAtMs) ? makeSlot(startsAtMs, duration) : undefined;
}

export function getAvailability(
  durationMinutes: number,
  now: Date,
  schedule?: WeeklySchedule,
  meetings: readonly Slot[] = [],
): Availability {
  const today = calendarDate(now);
  const windowEnd = calendarMidnight(shiftCalendarDate(today, windowDays));
  const duration = durationMinutes * minuteMilliseconds;

  return {
    timeZone: calendarTimeZone,
    days: Array.from({ length: windowDays }, (_, index) => {
      const date = shiftCalendarDate(today, index);
      const slots = candidateStarts(date, duration, now.getTime(), windowEnd, schedule, meetings)
        .map((candidate) => makeSlot(candidate, duration))
        .filter((slot) => !meetings.some((meeting) => overlaps(slot, meeting)));
      return { date, slots };
    }),
  };
}
