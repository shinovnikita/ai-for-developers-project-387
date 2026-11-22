import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HTTP_SCOPE = 'HTTP availability only; no browser/UI coverage';
const MAX_BODY_BYTES = 1024 * 1024;
const endpoints = [
  { id: 'http-health-v1', path: '/health', kind: 'json', expected: 'HTTP 200; JSON exactly {"status":"ok"}' },
  { id: 'http-home-html-v1', path: '/', kind: 'html', expected: 'HTTP 200; HTML document and HTML Content-Type' },
  { id: 'http-booking-html-v1', path: '/booking', kind: 'html', expected: 'HTTP 200; HTML document and HTML Content-Type' },
  { id: 'http-owner-html-v1', path: '/owner', kind: 'html', expected: 'HTTP 200; HTML document and HTML Content-Type' },
];

export function normalizeAppUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('APP_URL must be an absolute HTTPS root URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_URL must be an HTTPS root URL without credentials, query or fragment');
  }
  return url.origin;
}

function matches(check, attempt, body) {
  if (attempt.status !== 200 || attempt.error || attempt.truncated) return false;
  const mime = attempt.contentType.split(';')[0].trim().toLowerCase();
  const text = body.toString('utf8');
  if (check.kind === 'html') {
    return ['text/html', 'application/xhtml+xml'].includes(mime) && /<!doctype\s+html\b|<html(?:\s|>)/i.test(text);
  }
  if (!/^application\/(?:[\w.-]+\+)?json$/.test(mime)) return false;
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data).length === 1 && data.status === 'ok';
  } catch { return false; }
}

async function request(check, number, options) {
  const { directory, fetchImpl, timeoutMs } = options;
  const controller = new AbortController();
  const start = Date.now();
  const attempt = { number, startedAt: new Date(start).toISOString(), durationMs: 0,
    status: null, contentType: '', location: null,
    bodyFile: `responses/${check.id}-attempt-${number}.body`, bodyBytes: 0, truncated: false, ok: false };
  const chunks = [];
  let timeout;
  try {
    await Promise.race([
      (async () => {
        const response = await fetchImpl(check.url, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: check.kind === 'json' ? 'application/json' : 'text/html' },
        });
        attempt.status = response.status;
        attempt.contentType = response.headers.get('content-type') ?? '';
        attempt.location = response.headers.get('location');
        const reader = response.body?.getReader();
        if (!reader) return;
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          const remaining = MAX_BODY_BYTES - attempt.bodyBytes;
          const chunk = Buffer.from(value);
          const kept = chunk.subarray(0, remaining);
          chunks.push(kept);
          attempt.bodyBytes += kept.byteLength;
          if (chunk.byteLength > remaining) {
            attempt.truncated = true;
            attempt.error = `Response body exceeds ${MAX_BODY_BYTES} bytes; retained prefix only`;
            controller.abort();
            void reader.cancel().catch(() => {});
            return;
          }
        }
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timed out after ${timeoutMs} ms, including response body`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    attempt.error = error?.message ?? 'HTTP request failed';
  } finally { clearTimeout(timeout); }
  attempt.durationMs = Date.now() - start;
  const body = Buffer.concat(chunks);
  // Even incomplete bodies and HTTP errors are evidence, not a successful probe.
  writeFileSync(join(directory, attempt.bodyFile), body);
  attempt.ok = matches(check, attempt, body);
  return attempt;
}

export async function collectHttp(appUrl, {
  directory, fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  attempts = 3, timeoutMs = 20000, retryDelayMs = 5000,
} = {}) {
  const normalizedUrl = normalizeAppUrl(appUrl);
  if (!directory || !Number.isInteger(attempts) || attempts < 1 || attempts > 3
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000
    || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5000) {
    throw new Error('HTTP audit requires an output directory and bounded retry/timeout options');
  }
  mkdirSync(join(directory, 'responses'), { recursive: true });
  const report = { scope: HTTP_SCOPE, appUrl: normalizedUrl, startedAt: new Date().toISOString(),
    completedAt: null, checks: [], candidates: [] };
  const save = () => writeFileSync(join(directory, 'http-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  save();
  for (const endpoint of endpoints) {
    const check = { id: endpoint.id, path: endpoint.path, url: new URL(endpoint.path, normalizedUrl).href,
      expected: endpoint.expected, ok: false, attempts: [] };
    report.checks.push(check);
    save();
    for (let number = 1; number <= attempts; number++) {
      const observed = await request({ ...check, kind: endpoint.kind }, number, { directory, fetchImpl, timeoutMs });
      check.attempts.push(observed);
      check.ok = observed.ok;
      save();
      if (check.ok) break;
      if (number < attempts) await sleep(retryDelayMs);
    }
    if (!check.ok) {
      const observed = check.attempts.at(-1);
      const body = readFileSync(join(directory, observed.bodyFile), 'utf8');
      const prefix = observed.truncated || Boolean(observed.error) || body.length > 1024;
      report.candidates.push({ id: check.id, title: `HTTP availability check failed: GET ${check.path}`,
        evidence: `GET ${check.url}; expected ${check.expected}; final HTTP ${observed.status ?? 'unavailable'}; `
          + `Content-Type ${JSON.stringify(observed.contentType)}; ${observed.error ?? 'response does not match expected document'}; `
          + `${check.attempts.length} attempt(s); raw body ${observed.bodyFile}; `
          + `observed body${prefix ? ' prefix (up to 1024 characters)' : ''}: ${JSON.stringify(body.slice(0, 1024))}` });
      save();
    }
  }
  report.completedAt = new Date().toISOString();
  save();
  return report;
}
