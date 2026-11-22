import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './fixtures.ts';

test('long guest and meeting type stay inside their own cells beside the topic at 320px', async ({ calendar, page, request }) => {
  const typeName = 'Консультация'.repeat(6) + 'ВопросыЯ';
  const guestName = 'Я'.repeat(80);
  const topic = 'Т'.repeat(200);
  const createdType = await request.post(`${calendar.apiOrigin}/api/meeting-types`, {
    data: { name: typeName, description: 'Обсудим вопросы', durationMinutes: 30 },
  });
  expect(createdType.status()).toBe(201);
  const meetingType = await createdType.json();
  const booked = await request.post(`${calendar.apiOrigin}/api/meetings`, {
    data: {
      meetingTypeId: meetingType.id,
      guestName,
      topic,
      startsAt: '2026-11-17T07:00:00Z',
      attemptId: randomUUID(),
    },
  });
  expect(booked.status()).toBe(201);

  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(new URL('/owner', calendar.webOrigin).href);
  const row = page.getByRole('region', { name: 'Предстоящие встречи' })
    .getByRole('row').filter({ hasText: guestName });
  await expect(row.getByText(typeName, { exact: true })).toHaveText(typeName);
  await expect(row.getByText(guestName, { exact: true })).toHaveText(guestName);
  await expect(row.getByText(topic, { exact: true })).toHaveText(topic);

  // Measure actual rendered text fragments, not just the fixed-width cell boxes:
  // overflowing or clipped text can still have a perfectly sized element box.
  const cells = await row.getByRole('cell').evaluateAll((elements) => elements.map((cell) => {
    const bounds = cell.getBoundingClientRect();
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const fragments = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      fragments.push(...Array.from(range.getClientRects(), (rect) => ({
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      })));
    }
    return {
      text: cell.textContent,
      fits: cell.scrollWidth <= cell.clientWidth && cell.scrollHeight <= cell.clientHeight
        && fragments.length > 0 && fragments.every((rect) =>
          rect.left >= bounds.left && rect.right <= bounds.right
          && rect.top >= bounds.top && rect.bottom <= bounds.bottom
          && rect.left >= 0 && rect.right <= 320),
    };
  }));
  expect(cells).toHaveLength(4);
  for (const cell of cells) {
    expect.soft(cell.fits, `Full text must fit its own cell without overlap: ${cell.text}`).toBe(true);
  }
});
