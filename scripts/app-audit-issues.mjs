import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY } from './opencode-pr-policy.mjs';

const RULES = new Set(['http-health-v1', 'http-home-html-v1', 'http-booking-html-v1', 'http-owner-html-v1']);
const TRAINING_RULE = 'training-deduplication-v1';
const MARKER = /^<!-- app-audit:v1:([a-f0-9]{64}) -->(?:\r?\n|$)/;
const MAX_PAGES = 1000;

function normalizedTarget(appUrl) {
  const url = new URL(appUrl);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === '/', 'APP_URL must be an HTTPS origin without credentials, query or fragment');
  return url.origin;
}

// Only the target and a versioned check identifier establish identity. Dates,
// model prose, observed status, checked SHA and run ID do not enter this key.
export function findingKey(appUrl, id) {
  assert(typeof id === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(id), 'Invalid stable audit identifier');
  return createHash('sha256').update(JSON.stringify([normalizedTarget(appUrl), id])).digest('hex');
}

function assertRepository(repository) {
  assert.equal(repository, REPOSITORY, 'Audit issues must target the configured repository');
}

export function assertPublicationMeta(meta) {
  assert(meta && typeof meta === 'object', 'Missing audit metadata');
  assertRepository(meta.repository);
  assert(/^[a-f0-9]{40}$/.test(meta.sha ?? ''), 'Expected full checked SHA');
  assert(['schedule', 'workflow_dispatch'].includes(meta.eventName), 'Unsupported audit event');
  assert.equal(meta.ref, 'refs/heads/main', 'Audit publication is permitted only from main');
  assert(['real', 'training'].includes(meta.mode), 'Unknown audit mode');
  assert(meta.mode !== 'training' || meta.eventName === 'workflow_dispatch', 'Training requires manual workflow_dispatch');
  const runPattern = new RegExp(`^https://github\\.com/${REPOSITORY}/actions/runs/[1-9][0-9]*(?:/attempts/[1-9][0-9]*)?$`);
  assert(typeof meta.runUrl === 'string' && runPattern.test(meta.runUrl), 'Invalid audit run URL');
  return { ...meta, appUrl: normalizedTarget(meta.appUrl) };
}

async function api(repository, token, path, { fetchImpl = fetch, method = 'GET', body } = {}) {
  assert(typeof token === 'string' && token.trim(), 'GitHub token is required for audit issue operations');
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // Never echo the request headers, token or an arbitrary API response body.
    throw new Error(`GitHub ${method} ${path.split('?')[0]} failed or timed out`);
  }
  assert(response?.ok, `GitHub ${method} ${path.split('?')[0]}: HTTP ${response?.status ?? 'unknown'}`);
  try { return await response.json(); }
  catch { throw new Error(`GitHub ${method} ${path.split('?')[0]} returned invalid JSON`); }
}

function issueSnapshot(issue, repository) {
  assert(issue && Number.isSafeInteger(issue.number) && issue.number > 0
    && typeof issue.title === 'string' && (issue.body === null || typeof issue.body === 'string')
    && ['open', 'closed'].includes(issue.state)
    && issue.html_url === `https://github.com/${repository}/issues/${issue.number}`,
  'Malformed GitHub issue response');
  return { number: issue.number, title: issue.title, body: issue.body ?? '', state: issue.state, url: issue.html_url };
}

export async function listAuditIssues({ repository, token, fetchImpl = fetch }) {
  assertRepository(repository);
  const issues = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    // REST listing sees closed issues immediately and avoids the search index.
    // Ascending creation order avoids shifting older pages when new issues arrive.
    const batch = await api(repository, token,
      `issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`, { fetchImpl });
    assert(Array.isArray(batch) && batch.length <= 100, 'Malformed GitHub issues page');
    for (const issue of batch) {
      assert(issue && typeof issue === 'object', 'Malformed GitHub issue response');
      if (issue.pull_request) continue;
      const snapshot = issueSnapshot(issue, repository);
      // The trusted marker is always the first line. Quoted response/issue text
      // elsewhere in a body cannot impersonate another audit finding.
      if (MARKER.test(snapshot.body)) issues.push(snapshot);
    }
    if (batch.length < 100) return issues;
  }
  throw new Error(`GitHub issue pagination exceeded ${MAX_PAGES} pages; refusing incomplete deduplication`);
}

function validateFindings(findings, meta) {
  assert(Array.isArray(findings) && findings.length <= 4, 'Expected a bounded audit findings array');
  const seen = new Set();
  for (const finding of findings) {
    assert(finding && typeof finding === 'object', 'Malformed audit finding');
    assert(meta.mode === 'training' ? finding.id === TRAINING_RULE : RULES.has(finding.id), 'Finding is outside the audit mode');
    assert(!seen.has(finding.id), 'Duplicate stable audit identifier');
    seen.add(finding.id);
    assert(typeof finding.title === 'string' && finding.title.trim() && finding.title.length <= 200
      && !/[\r\n]/.test(finding.title), 'Malformed audit finding title');
    assert(typeof finding.analysis === 'string' && finding.analysis.trim() && finding.analysis.length <= 12_000,
      'Malformed audit analysis');
    const evidence = JSON.stringify(finding.evidence);
    assert(evidence && evidence.length <= 32_000, 'Missing or oversized audit facts');
  }
  if (meta.mode === 'training') assert.equal(findings.length, 1, 'Training must contain its one stable example');
}

function issueBody(meta, finding, key) {
  const training = meta.mode === 'training';
  return `<!-- app-audit:v1:${key} -->
${training
    ? '**УЧЕБНЫЙ ПРИМЕР. Это проверка дедупликации, а не подтверждённый сбой приложения.**'
    : '**Автоматический HTTP-аудит.** Факты собраны детерминированными GET-запросами, анализ предложен ИИ.'}

APP_URL: ${meta.appUrl}
Проверяемый SHA репозитория аудита: ${meta.sha}
Прогон: ${meta.runUrl}
Режим: ${meta.mode}; событие: ${meta.eventName}
Устойчивый идентификатор проверки: ${finding.id}

Проверяется HTTP-доступность опубликованного приложения проекта 386. Это не браузерное тестирование интерфейса и не проверка темы встречи из проекта 387. Данные приложения не изменяются.

### Фактические данные${training ? ' учебного примера' : ''}

\`\`\`json
${JSON.stringify(finding.evidence, null, 2)}
\`\`\`

### Анализ агента

${finding.analysis}

Полный отчёт, исходные HTTP-ответы и фактический вывод агента сохранены в artifacts указанного прогона.
`;
}

export async function publishFindings({ meta, findings, directory, token, fetchImpl = fetch }) {
  mkdirSync(directory, { recursive: true });
  const result = { status: 'in-progress', issues: [], pending: null };
  const save = () => writeFileSync(join(directory, 'publication.json'), `${JSON.stringify(result, null, 2)}\n`);
  save();
  try {
    meta = assertPublicationMeta(meta);
    validateFindings(findings, meta);
    // Re-read current REST state, rather than trusting the model's earlier snapshot.
    const existing = findings.length ? await listAuditIssues({ repository: meta.repository, token, fetchImpl }) : [];
    for (const finding of findings) {
      const key = findingKey(meta.appUrl, finding.id);
      const found = existing.find((issue) => MARKER.exec(issue.body)?.[1] === key);
      if (found) {
        result.issues.push({ id: finding.id, key, action: 'existing', number: found.number, url: found.url, state: found.state });
        save();
        continue;
      }
      result.pending = { id: finding.id, key };
      save();
      // Never retry a POST: a network failure can happen after GitHub has created
      // the issue. A later audit discovers its marker through the REST listing.
      const response = await api(meta.repository, token, 'issues', {
        fetchImpl, method: 'POST', body: {
          title: meta.mode === 'training' ? '[App audit training] Учебный пример дедупликации' : `[App audit] ${finding.title}`,
          body: issueBody(meta, finding, key),
        },
      });
      assert(!response?.pull_request, 'Issue creation returned a pull request');
      const created = issueSnapshot(response, meta.repository);
      assert(MARKER.exec(created.body)?.[1] === key, 'Created issue is missing the audit marker');
      result.issues.push({ id: finding.id, key, action: 'created', number: created.number, url: created.url, state: created.state });
      existing.push(created);
      result.pending = null;
      save();
    }
    result.status = 'complete';
    save();
    return result;
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    save();
    throw error;
  }
}
