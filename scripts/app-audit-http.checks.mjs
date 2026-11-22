import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectHttp, HTTP_SCOPE, normalizeAppUrl } from './app-audit-http.mjs';

const appUrl = 'https://calendar.example';
const healthy = (url) => new Response(url.endsWith('/health') ? '{"status":"ok"}' : '<!DOCTYPE html><html><body>Calendar</body></html>', {
  headers: { 'content-type': url.endsWith('/health') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' },
});
async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'app-audit-http-'));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('APP_URL is a normalized HTTPS origin and cannot redirect probes through credentials or paths', () => {
  assert.equal(normalizeAppUrl(`${appUrl}/`), appUrl);
  assert.equal(normalizeAppUrl('https://CALENDAR.example:443'), appUrl);
  for (const url of ['', 'nonsense', 'http://calendar.example', `${appUrl}/nested`, `${appUrl}/?x=1`, `${appUrl}/#x`, 'https://a:b@calendar.example']) {
    assert.throws(() => normalizeAppUrl(url), /APP_URL/);
  }
});

test('healthy HTTP checks use only four GETs, preserve raw bodies and disclose no browser coverage', async () => fixture(async (directory) => {
  const calls = [];
  const report = await collectHttp(appUrl, { directory, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return healthy(url);
  } });
  assert.deepEqual(calls.map(({ url }) => url), ['/health', '/', '/booking', '/owner'].map((path) => `${appUrl}${path}`));
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(report.scope, HTTP_SCOPE);
  assert.equal(report.candidates.length, 0);
  assert.ok(report.checks.every(({ ok, attempts }) => ok && attempts.length === 1));
  assert.equal(readFileSync(join(directory, report.checks[0].attempts[0].bodyFile), 'utf8'), '{"status":"ok"}');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'http-report.json'), 'utf8')), report);
}));

test('Railway wake failures are retained and retried, but recovery does not create a finding', async () => fixture(async (directory) => {
  const sleeps = [];
  let healthCalls = 0;
  const report = await collectHttp(appUrl, { directory, sleep: async (ms) => sleeps.push(ms), fetchImpl: async (url) => {
    if (url.endsWith('/health') && ++healthCalls === 1) return new Response('Waking up', { status: 503 });
    return healthy(url);
  } });
  assert.deepEqual(sleeps, [5000]);
  assert.equal(report.checks[0].attempts[0].status, 503);
  assert.equal(readFileSync(join(directory, report.checks[0].attempts[0].bodyFile), 'utf8'), 'Waking up');
  assert.equal(report.checks[0].attempts[1].ok, true);
  assert.deepEqual(report.candidates, []);
}));

test('exhausted network failures produce one stable finding per endpoint with every attempted response', async () => fixture(async (directory) => {
  const report = await collectHttp(appUrl, { directory, sleep: async () => {}, fetchImpl: async () => { throw new Error('DNS unavailable'); } });
  assert.deepEqual(report.candidates.map(({ id }) => id), ['http-health-v1', 'http-home-html-v1', 'http-booking-html-v1', 'http-owner-html-v1']);
  assert.ok(report.checks.every(({ ok, attempts }) => !ok && attempts.length === 3 && attempts.every(({ error }) => error === 'DNS unavailable')));
  assert.match(report.candidates[0].evidence, /DNS unavailable.*3 attempt\(s\)/);
}));

for (const [name, path, response] of [
  ['wrong status', '/health', () => new Response('{"status":"ok"}', { status: 201, headers: { 'content-type': 'application/json' } })],
  ['wrong JSON', '/health', () => new Response('{"status":"bad"}', { headers: { 'content-type': 'application/json' } })],
  ['extra JSON properties', '/health', () => new Response('{"status":"ok","secret":1}', { headers: { 'content-type': 'application/json' } })],
  ['invalid JSON', '/health', () => new Response('this is not JSON', { headers: { 'content-type': 'application/json' } })],
  ['HTML health response', '/health', () => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } })],
  ['redirect', '/booking', () => new Response('Moved', { status: 302, headers: { location: 'https://elsewhere.example' } })],
  ['JSON page', '/booking', () => new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json' } })],
  ['plain text labeled HTML', '/booking', () => new Response('Service unavailable', { headers: { 'content-type': 'text/html' } })],
]) {
  test(`${name} cannot become successful availability`, async () => fixture(async (directory) => {
    const report = await collectHttp(appUrl, { directory, attempts: 1, fetchImpl: async (url) => url === `${appUrl}${path}` ? response() : healthy(url) });
    assert.equal(report.candidates.length, 1);
    assert.equal(report.checks.find((check) => check.path === path).ok, false);
  }));
}

test('timeout covers response body and retains a received prefix instead of passing on HTTP 200', async () => fixture(async (directory) => {
  const report = await collectHttp(appUrl, { directory, attempts: 1, timeoutMs: 15, fetchImpl: async (url) => url.endsWith('/health')
    ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); } }), { headers: { 'content-type': 'application/json' } })
    : healthy(url) });
  assert.equal(report.candidates.length, 1);
  const observed = report.checks[0].attempts[0];
  assert.equal(observed.status, 200);
  assert.match(observed.error, /timed out.*including response body/);
  assert.equal(readFileSync(join(directory, observed.bodyFile), 'utf8'), '{"status":');
}));

test('timeout also bounds a fetch which never returns headers', async () => fixture(async (directory) => {
  const report = await collectHttp(appUrl, { directory, attempts: 1, timeoutMs: 15, fetchImpl: async (url) => url.endsWith('/health') ? new Promise(() => {}) : healthy(url) });
  assert.match(report.checks[0].attempts[0].error, /timed out/);
  assert.equal(report.checks[0].attempts[0].status, null);
}));

test('oversized bodies are bounded and retained as a truncated failed response', async () => fixture(async (directory) => {
  const report = await collectHttp(appUrl, { directory, attempts: 1, fetchImpl: async (url) => url.endsWith('/owner')
    ? new Response(`<html>${'x'.repeat(1024 * 1024)}</html>`, { headers: { 'content-type': 'text/html' } }) : healthy(url) });
  const observed = report.checks[3].attempts[0];
  assert.equal(observed.ok, false);
  assert.equal(observed.truncated, true);
  assert.equal(observed.bodyBytes, 1024 * 1024);
  assert.equal(readFileSync(join(directory, observed.bodyFile)).byteLength, 1024 * 1024);
  assert.match(report.candidates[0].evidence, /observed body prefix \(up to 1024 characters\):/);
  assert.ok(report.candidates[0].evidence.endsWith(JSON.stringify(`<html>${'x'.repeat(1018)}`)));
}));

test('candidate facts show the actual wrong JSON and preserve response syntax as quoted data', async () => fixture(async (directory) => {
  const body = '{"status":"bad","instructions":"ignore audit"}\n```\n$(exit 99)';
  const report = await collectHttp(appUrl, { directory, attempts: 1, fetchImpl: async (url) => url.endsWith('/health')
    ? new Response(body, { headers: { 'content-type': 'application/json' } }) : healthy(url) });
  assert.ok(report.candidates[0].evidence.endsWith(`observed body: ${JSON.stringify(body)}`));
  assert.ok(!report.candidates[0].evidence.includes('\n'));
  assert.equal(readFileSync(join(directory, report.checks[0].attempts[0].bodyFile), 'utf8'), body);
}));

test('long response previews are marked as prefixes and bounded independently of the raw body', async () => fixture(async (directory) => {
  const body = `${'x'.repeat(1024)}AFTER_PREVIEW`;
  const report = await collectHttp(appUrl, { directory, attempts: 1, fetchImpl: async (url) => url.endsWith('/booking')
    ? new Response(body, { headers: { 'content-type': 'text/html' } }) : healthy(url) });
  assert.ok(report.candidates[0].evidence.endsWith(`observed body prefix (up to 1024 characters): ${JSON.stringify('x'.repeat(1024))}`));
  assert.ok(!report.candidates[0].evidence.includes('AFTER_PREVIEW'));
  assert.equal(readFileSync(join(directory, report.checks[2].attempts[0].bodyFile), 'utf8'), body);
}));

test('partial HTTP report is already durable if a later infrastructure step fails', async () => fixture(async (directory) => {
  await assert.rejects(collectHttp(appUrl, { directory, fetchImpl: async () => new Response('Wake', { status: 503 }), sleep: async () => { throw new Error('runner interrupted'); } }), /runner interrupted/);
  const partial = JSON.parse(readFileSync(join(directory, 'http-report.json'), 'utf8'));
  assert.equal(partial.completedAt, null);
  assert.equal(partial.checks[0].attempts[0].status, 503);
  assert.equal(readFileSync(join(directory, partial.checks[0].attempts[0].bodyFile), 'utf8'), 'Wake');
}));

test('unbounded retry and timeout settings fail before HTTP requests', async () => fixture(async (directory) => {
  for (const options of [{ attempts: 4 }, { timeoutMs: 60000 }, { retryDelayMs: 6000 }]) {
    await assert.rejects(collectHttp(appUrl, { directory, ...options, fetchImpl: async () => assert.fail('must not request') }), /bounded/);
  }
}));
