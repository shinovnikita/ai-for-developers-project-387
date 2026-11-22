import { Button, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { listUpcomingMeetings, type UpcomingMeetings as MeetingList } from './api';
import { formatMeetingDate, formatTimeRange } from './meeting-time';

type ListState =
  | { status: 'loading' | 'error' }
  | { status: 'loaded'; upcoming: MeetingList };

export function UpcomingMeetings() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    listUpcomingMeetings({ signal: controller.signal, throwOnError: true })
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setState({ status: 'loaded', upcoming: data });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: 'error' });
        }
      });

    return () => controller.abort();
  }, [refresh]);

  function reload() {
    setState({ status: 'loading' });
    setRefresh((version) => version + 1);
  }

  const upcoming = state.status === 'loaded' ? state.upcoming : undefined;

  return (
    <Stack component="section" aria-labelledby="upcoming-meetings-title" w="100%" gap="sm">
      <Group justify="space-between">
        <Title order={2} id="upcoming-meetings-title">Предстоящие встречи</Title>
        <Button variant="default" onClick={reload} disabled={state.status === 'loading'}>
          Обновить список
        </Button>
      </Group>
      {state.status === 'loading' && <Text role="status">Загружаем предстоящие встречи</Text>}
      {state.status === 'error' && <Text role="alert" c="red">Не удалось загрузить предстоящие встречи</Text>}
      {upcoming && (upcoming.meetings.length === 0 ? (
        <Text role="status">Предстоящих встреч пока нет</Text>
      ) : (
        <>
          <Text c="dimmed">Время по часовому поясу {upcoming.timeZone}</Text>
          <Table.ScrollContainer minWidth={0}>
            <Table style={{ tableLayout: 'fixed', overflowWrap: 'anywhere' }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col" w="40%">Тип встречи</Table.Th>
                  <Table.Th scope="col">Гость</Table.Th>
                  <Table.Th scope="col">Дата</Table.Th>
                  <Table.Th scope="col">Время</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {upcoming.meetings.map((meeting) => (
                  <Table.Tr key={meeting.id}>
                    <Table.Td>
                      <Text>{meeting.meetingTypeName}</Text>
                      <Text style={{ overflowWrap: 'anywhere' }}>{meeting.topic ?? 'Тема не указана'}</Text>
                    </Table.Td>
                    <Table.Td>{meeting.guestName}</Table.Td>
                    <Table.Td>{formatMeetingDate(meeting.startsAt)}</Table.Td>
                    <Table.Td>{formatTimeRange(meeting.startsAt, meeting.endsAt)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </>
      ))}
    </Stack>
  );
}
