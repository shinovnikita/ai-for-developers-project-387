import { Button, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { type SubmitEvent, useEffect, useRef, useState } from 'react';
import { calendarDate, calendarMidnight, shiftCalendarDate } from '../../shared/calendar-time';
import { createMeeting, getMeetingTypeAvailability, type Availability, type CreateMeetingInput, type MeetingConfirmation } from './api';
import { formatMeetingDate, formatTimeRange } from './meeting-time';

type AvailabilityState = { date: string; refresh: number } & (
  | { status: 'error' }
  | { status: 'loaded'; availability: Availability }
);

type Submission =
  | { status: 'idle' | 'submitting' }
  | { status: 'retry'; attempt: CreateMeetingInput }
  | { status: 'error'; message: string; nameError?: string; topicError?: string }
  | { status: 'confirmed'; confirmation: MeetingConfirmation };

const defaultError = 'Не удалось подтвердить запись. Попробуйте ещё раз.';

const dateFormat = new Intl.DateTimeFormat('ru', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function createAttemptId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
  ].join('-');
}

export function AvailabilityPicker({ meetingTypeId }: { meetingTypeId: string }) {
  const [state, setState] = useState<AvailabilityState>();
  const [refresh, setRefresh] = useState(0);
  const [today, setToday] = useState(() => calendarDate(Date.now()));
  const [selectedDate, setSelectedDate] = useState<string>();
  const [selectedStart, setSelectedStart] = useState<string>();
  const [guestName, setGuestName] = useState<string>();
  const [topic, setTopic] = useState('');
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  const submitRequest = useRef<AbortController | null>(null);

  const currentState = state?.date === today && state.refresh === refresh ? state : undefined;
  const availability = currentState?.status === 'loaded' ? currentState.availability : undefined;
  const selectedDay = availability?.days.find((day) => day.date === selectedDate);
  const selectedSlot = selectedDay?.slots.find((slot) => slot.startsAt === selectedStart);
  const confirmed = submission.status === 'confirmed';
  const submitting = submission.status === 'submitting';
  const retry = submission.status === 'retry' ? submission.attempt : undefined;
  const nameError = submission.status === 'error' ? submission.nameError : undefined;
  const topicError = submission.status === 'error' ? submission.topicError : undefined;

  useEffect(() => {
    let timer: number;
    function updateCalendarDate() {
      const now = Date.now();
      const date = calendarDate(now);
      setToday(date);
      window.clearTimeout(timer);
      timer = window.setTimeout(
        updateCalendarDate,
        calendarMidnight(shiftCalendarDate(date, 1)) - now,
      );
    }

    updateCalendarDate();
    document.addEventListener('visibilitychange', updateCalendarDate);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', updateCalendarDate);
    };
  }, []);

  useEffect(() => {
    if (confirmed) return;
    const controller = new AbortController();

    getMeetingTypeAvailability({
      path: { meetingTypeId },
      signal: controller.signal,
      throwOnError: true,
    })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setState({ status: 'loaded', date: today, refresh, availability: data });
        setSelectedDate((date) => data.days.some((day) => day.date === date && day.slots.length) ? date : undefined);
        setSelectedStart((start) => data.days.some((day) => day.slots.some((slot) => slot.startsAt === start)) ? start : undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error', date: today, refresh });
      });

    return () => controller.abort();
  }, [confirmed, meetingTypeId, refresh, today]);

  useEffect(() => () => submitRequest.current?.abort(), []);

  async function submitMeeting(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitRequest.current) return;

    const controller = new AbortController();
    submitRequest.current = controller;
    let attempt = retry;

    try {
      if (!attempt) {
        if (!selectedSlot || guestName === undefined) return;
        const normalizedTopic = topic.trim();
        const error = normalizedTopic === '' ? 'Укажите тему'
          : [...normalizedTopic].length > 200 ? 'Укажите тему до 200 символов' : undefined;
        if (error) {
          setSubmission({ status: 'error', message: 'Проверьте поля запроса', topicError: error });
          return;
        }
        attempt = { meetingTypeId, startsAt: selectedSlot.startsAt, guestName, topic: normalizedTopic, attemptId: createAttemptId() };
      }

      setSubmission({ status: 'submitting' });
      const { data, error, response } = await createMeeting({
        body: attempt,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (controller.signal.aborted) return;

      if (data) {
        setSubmission({ status: 'confirmed', confirmation: data });
        return;
      }

      if (!response || response.ok || response.status >= 500) {
        setSubmission({ status: 'retry', attempt });
        return;
      }

      if (error?.code === 'SLOT_TAKEN' || error?.code === 'SLOT_UNAVAILABLE') {
        setSelectedStart(undefined);
        setRefresh((version) => version + 1);
      }

      setSubmission({
        status: 'error',
        message: error?.message || defaultError,
        nameError: error?.code === 'VALIDATION_ERROR' ? error.fieldErrors?.guestName : undefined,
        topicError: error?.code === 'VALIDATION_ERROR' ? error.fieldErrors?.topic : undefined,
      });
    } catch {
      if (controller.signal.aborted) return;
      setSubmission(attempt ? { status: 'retry', attempt } : { status: 'error', message: defaultError });
    } finally {
      submitRequest.current = null;
    }
  }

  if (submission.status === 'confirmed') {
    const { meeting, timeZone } = submission.confirmation;
    return (
      <Stack component="section" aria-label="Подтверждение записи" w="100%" gap="xs">
        <Title order={2}>Встреча подтверждена</Title>
        <Text>{meeting.meetingTypeName}</Text>
        <Text style={{ overflowWrap: 'anywhere' }}>{meeting.topic ?? 'Тема не указана'}</Text>
        <Text>{formatMeetingDate(meeting.startsAt)}</Text>
        <Text>{formatTimeRange(meeting.startsAt, meeting.endsAt)}</Text>
        <Text c="dimmed">{timeZone}</Text>
      </Stack>
    );
  }

  return (
    <Stack component="section" aria-label="Свободное время" w="100%">
      {!currentState && <Text role="status">Загружаем свободное время</Text>}
      {currentState?.status === 'error' && <Text role="alert">Не удалось загрузить свободное время</Text>}
      {availability && (
        <>
          <Title order={2}>Выберите дату</Title>
          <Text c="dimmed">Время по часовому поясу {availability.timeZone}</Text>
          {availability.days.every((day) => day.slots.length === 0) && (
            <Text role="status">В ближайшие 14 дней нет свободного времени</Text>
          )}
          <SimpleGrid cols={{ base: 2, xs: 3, sm: 5, md: 7 }} role="group" aria-label="Даты">
            {availability.days.map((day) => (
              <Button
                key={day.date}
                variant={day.date === selectedDate ? 'filled' : 'default'}
                aria-pressed={day.date === selectedDate}
                disabled={submitting || day.slots.length === 0}
                onClick={() => {
                  if (day.date !== selectedDate) {
                    setSelectedDate(day.date);
                    setSelectedStart(undefined);
                    if (retry) setSubmission({ status: 'idle' });
                  }
                }}
              >
                {dateFormat.format(new Date(day.date))}
              </Button>
            ))}
          </SimpleGrid>
        </>
      )}
      {selectedDay && (
        <>
          <Title order={2}>Выберите время</Title>
          <Group role="group" aria-label="Время" gap="xs">
            {selectedDay.slots.map((slot) => (
              <Button
                key={slot.startsAt}
                variant={slot.startsAt === selectedStart ? 'filled' : 'default'}
                aria-pressed={slot.startsAt === selectedStart}
                disabled={submitting}
                onClick={() => {
                  if (retry && slot.startsAt === selectedStart) return;
                  setSelectedStart(slot.startsAt);
                  setGuestName((name) => name ?? '');
                  setSubmission({ status: 'idle' });
                }}
              >
                {formatTimeRange(slot.startsAt, slot.endsAt)}
              </Button>
            ))}
          </Group>
        </>
      )}
      {guestName !== undefined && (
        <form onSubmit={submitMeeting} noValidate>
          <Stack>
            <TextInput
              label="Имя"
              name="guestName"
              autoComplete="name"
              required
              disabled={submitting}
              value={guestName}
              error={nameError}
              onChange={(event) => {
                setGuestName(event.currentTarget.value);
                if (nameError || retry) setSubmission({ status: 'idle' });
              }}
            />
            <TextInput
              label="Тема"
              name="topic"
              required
              disabled={submitting}
              value={topic}
              error={topicError}
              onChange={(event) => {
                setTopic(event.currentTarget.value);
                if (topicError || retry) setSubmission({ status: 'idle' });
              }}
            />
            <Button type="submit" disabled={!selectedSlot && !retry} loading={submitting} w="fit-content">
              {retry ? 'Повторить отправку' : 'Подтвердить запись'}
            </Button>
            {retry && <Text role="alert" c="red">{defaultError}</Text>}
            {submission.status === 'error' && !nameError && !topicError && <Text role="alert" c="red">{submission.message}</Text>}
          </Stack>
        </form>
      )}
    </Stack>
  );
}
