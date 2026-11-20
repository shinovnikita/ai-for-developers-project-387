import { calendarTimeZone } from '../../shared/calendar-time';

const dateFormat = new Intl.DateTimeFormat('ru', {
  timeZone: calendarTimeZone,
  dateStyle: 'long',
});
const timeFormat = new Intl.DateTimeFormat('ru', {
  timeZone: calendarTimeZone,
  hour: '2-digit',
  minute: '2-digit',
});

export function formatMeetingDate(startsAt: string) {
  return dateFormat.format(new Date(startsAt));
}

export function formatTimeRange(startsAt: string, endsAt: string) {
  return `${timeFormat.format(new Date(startsAt))}–${timeFormat.format(new Date(endsAt))}`;
}
