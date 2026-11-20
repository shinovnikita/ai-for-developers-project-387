export const calendarTimeZone = 'Europe/Moscow';

const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: calendarTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function calendarDate(time: Date | number) {
  return dateFormatter.format(time);
}

export function shiftCalendarDate(date: string, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: calendarTimeZone,
  timeZoneName: 'longOffset',
});

export function calendarMidnight(date: string) {
  const wallTime = `${date}T00:00:00`;
  const zone = offsetFormatter.formatToParts(new Date(`${wallTime}Z`))
    .find(({ type }) => type === 'timeZoneName');
  return Date.parse(`${wallTime}${zone?.value.slice(3) || 'Z'}`);
}
