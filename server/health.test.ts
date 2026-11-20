import { expect, test } from 'vitest';
import { buildApp } from './app.ts';

test('GET /health returns 200 and the health status', async () => {
  const app = buildApp();

  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(new URL('/health', address), {
      signal: AbortSignal.timeout(3_000),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }
});
