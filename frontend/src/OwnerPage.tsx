import { Button, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { type SubmitEvent, useState } from 'react';
import { createMeetingType, type CreateMeetingTypeInput } from './api';
import { UpcomingMeetings } from './UpcomingMeetings';

type FieldErrors = Partial<Record<keyof CreateMeetingTypeInput, string>>;

type Submission =
  | { status: 'idle' | 'submitting' | 'saved' }
  | { status: 'error'; message: string; fieldErrors?: FieldErrors };

const defaultError = 'Не удалось создать тип встречи. Попробуйте ещё раз.';

export function OwnerPage() {
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  const fieldErrors = submission.status === 'error' ? submission.fieldErrors : undefined;
  const submitting = submission.status === 'submitting';

  async function submitMeetingType(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const fields = new FormData(form);
    setSubmission({ status: 'submitting' });

    try {
      const { data, error } = await createMeetingType({
        body: {
          name: String(fields.get('name') ?? ''),
          description: String(fields.get('description') ?? ''),
          durationMinutes: Number(fields.get('durationMinutes')),
        },
      });

      if (data) {
        form.reset();
        setSubmission({ status: 'saved' });
      } else {
        setSubmission({
          status: 'error',
          message: error?.message || defaultError,
          fieldErrors: error?.fieldErrors,
        });
      }
    } catch {
      setSubmission({ status: 'error', message: defaultError });
    }
  }

  return (
    <>
      <Title order={1}>Календарь владельца</Title>
      <form style={{ alignSelf: 'stretch' }} onSubmit={submitMeetingType} noValidate>
        <Stack>
          <TextInput name="name" label="Название" required disabled={submitting} error={fieldErrors?.name} />
          <Textarea name="description" label="Описание" required disabled={submitting} error={fieldErrors?.description} />
          <TextInput
            name="durationMinutes"
            type="number"
            label="Длительность в минутах"
            description="Целое число от 5 до 120"
            min={5}
            max={120}
            required
            disabled={submitting}
            error={fieldErrors?.durationMinutes}
          />
          <Button type="submit" loading={submitting} style={{ alignSelf: 'flex-start' }}>
            Создать тип встречи
          </Button>
          {submission.status === 'error' && <Text role="alert" c="red">{submission.message}</Text>}
          {submission.status === 'saved' && <Text role="status">Тип встречи создан</Text>}
        </Stack>
      </form>
      <UpcomingMeetings />
    </>
  );
}
