import { Button, Paper, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { listMeetingTypes, type MeetingType } from './api';
import { AvailabilityPicker } from './AvailabilityPicker';

type Catalog =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; meetingTypes: MeetingType[] };

const durationFormat = new Intl.NumberFormat('ru', { style: 'unit', unit: 'minute', unitDisplay: 'long' });

export function BookingPage() {
  const [catalog, setCatalog] = useState<Catalog>({ status: 'loading' });
  const [selectedTypeId, setSelectedTypeId] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();

    listMeetingTypes({ signal: controller.signal, throwOnError: true })
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setCatalog({ status: 'loaded', meetingTypes: data });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCatalog({ status: 'error' });
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <>
      <Title order={1}>Страница записи</Title>
      {catalog.status === 'loading' && <Text role="status">Загружаем типы встреч</Text>}
      {catalog.status === 'error' && <Text role="alert">Не удалось загрузить типы встреч</Text>}
      {catalog.status === 'loaded' && (
        catalog.meetingTypes.length === 0 ? (
          <Text>Пока нет типов встреч для записи</Text>
        ) : (
          <Stack w="100%">
            {catalog.meetingTypes.map((type) => (
              <Paper component="article" withBorder p="md" radius="md" key={type.id}>
                <Stack gap="xs">
                  <Title order={2}>{type.name}</Title>
                  <Text>{type.description}</Text>
                  <Text c="dimmed">{durationFormat.format(type.durationMinutes)}</Text>
                  <Button
                    w="fit-content"
                    variant={type.id === selectedTypeId ? 'filled' : 'default'}
                    aria-label={`Выбрать ${type.name}`}
                    aria-pressed={type.id === selectedTypeId}
                    onClick={() => setSelectedTypeId(type.id)}
                  >
                    Выбрать
                  </Button>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )
      )}
      {selectedTypeId && <AvailabilityPicker key={selectedTypeId} meetingTypeId={selectedTypeId} />}
    </>
  );
}
