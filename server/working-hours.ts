import type { WeeklySchedule } from './availability.ts';

const weekdayHours = [{ startsAt: '09:00', endsAt: '18:00' }];
const defaultSchedule: WeeklySchedule = {
  1: weekdayHours,
  2: weekdayHours,
  3: weekdayHours,
  4: weekdayHours,
  5: weekdayHours,
};
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isWorkingInterval(value: unknown) {
  if (typeof value !== 'object' || value === null || !('startsAt' in value) || !('endsAt' in value)) {
    return false;
  }

  const { startsAt, endsAt } = value;
  return typeof startsAt === 'string' && clockTime.test(startsAt)
    && typeof endsAt === 'string' && (clockTime.test(endsAt) || endsAt === '24:00')
    && startsAt < endsAt;
}

function isWeeklySchedule(value: unknown): value is WeeklySchedule {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([day, intervals]) => (
      /^[0-6]$/.test(day) && Array.isArray(intervals) && intervals.every(isWorkingInterval)
    ));
}

export function readWeeklySchedule(json: string | undefined): WeeklySchedule | undefined {
  if (json === undefined) return defaultSchedule;
  if (!json.trim()) return undefined;

  const schedule: unknown = JSON.parse(json);
  if (schedule === null) return undefined;
  if (!isWeeklySchedule(schedule)) throw new Error('Некорректное расписание CALENDAR_SCHEDULE');
  return schedule;
}
