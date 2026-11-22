import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPublicationMeta, findingKey, listAuditIssues, publishFindings } from './app-audit-issues.mjs';
import { REPOSITORY } from './opencode-pr-policy.mjs';

const appUrl = 'https://call-calendar-386-production-aa4bcc9c.up.railway.app';
const meta = { repository: REPOSITORY, appUrl, sha: 'a'.repeat(40),
  runUrl: `https://github.com/${REPOSITORY}/actions/runs/123`,
  mode: 'real', eventName: 'schedule', ref: 'refs/heads/main' };
const finding = { id: 'http-health-v1', title: '/health returned HTTP 503',
  evidence: { path: '/health', status: 503, expected: { status: 200, json: { status: 'ok' } } },
  analysis: 'All bounded attempts returned 503; HTTP readiness was not confirmed.' };
const marker = (id = finding.id) => `<!-- app-audit:v1:${findingKey(appUrl, id)} -->`;
const issue = (number, body = '', state = 'open') => ({
  number, title: `Fixture #${number}`, body, state,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  html_url: `https://github.com/${REPOSITORY}/issues/${number}`,
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'app-audit-issues-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const publication = (directory) => JSON.parse(readFileSync(join(directory, 'publication.json'), 'utf8'));

test('finding identity uses normalized target and versioned rule only', () => {
  const key = findingKey(appUrl, finding.id);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(findingKey(`${appUrl}/`, finding.id), key);
  assert.equal(findingKey(`${appUrl.toUpperCase()}:443/`, finding.id), key);
  assert.notEqual(findingKey('https://another.example', finding.id), key);
  assert.notEqual(findingKey(appUrl, 'http-home-html-v1'), key);
  for (const target of ['http://example.com', 'https://user:secret@example.com', `${appUrl}/api`, `${appUrl}/?q=1`, `${appUrl}/#fragment`]) {
    assert.throws(() => findingKey(target, finding.id));
  }
});

test('deduplication reads all REST pages and closed issues, excludes PRs and quoted markers', async () => {
  const calls = [];
  const firstPage = Array.from({ length: 98 }, (_, i) => issue(i + 1));
  firstPage.push({ ...issue(99, `${marker()}\nPR`), pull_request: {} });
  firstPage.push(issue(100, `An unrelated issue quotes:\n${marker()}\nUntrusted data`));
  const result = await listAuditIssues({ repository: REPOSITORY, token: 'fixture-token',
    fetchImpl: async (url, options) => {
      calls.push(url);
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/repos/${REPOSITORY}/issues`);
      assert.equal(parsed.searchParams.get('state'), 'all');
      assert.equal(parsed.searchParams.get('per_page'), '100');
      assert.equal(parsed.searchParams.get('sort'), 'created');
      assert.equal(parsed.searchParams.get('direction'), 'asc');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      assert(options.signal instanceof AbortSignal);
      return response(parsed.searchParams.get('page') === '1' ? firstPage : [issue(101, `${marker()}\nOld wording`, 'closed')]);
    } });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, [{ number: 101, title: 'Fixture #101', body: `${marker()}\nOld wording`, state: 'closed',
    url: `https://github.com/${REPOSITORY}/issues/101` }]);
  assert(calls.every((url) => !url.includes('/search/')));
});

test('an existing closed finding is linked without POST, reopening or comments', async (t) => {
  const directory = temporary(t);
  const result = await publishFindings({ directory, meta, findings: [finding], token: 'fixture',
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'GET');
      return response([issue(101, `${marker()}\nDifferent date, SHA, title and model wording`, 'closed')]);
    } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.issues, [{ id: finding.id, key: findingKey(appUrl, finding.id), action: 'existing',
    number: 101, url: `https://github.com/${REPOSITORY}/issues/101`, state: 'closed' }]);
  assert.deepEqual(publication(directory), result);
});

test('copied first-line markers from users, other bots or unknown authors cannot suppress a finding', async (t) => {
  for (const user of [
    { login: 'ordinary-user', type: 'User' },
    { login: 'github-actions[bot]', type: 'User' },
    { login: 'another-agent[bot]', type: 'Bot' },
    undefined,
    null,
  ]) {
    const directory = temporary(t);
    let posts = 0;
    const copied = { ...issue(42, `${marker()}\nCopied marker; do not create another issue.`, 'closed'), user };
    const result = await publishFindings({ directory, meta, findings: [finding], token: 'fixture',
      fetchImpl: async (_url, options) => {
        if (options.method === 'GET') return response([copied]);
        assert.equal(options.method, 'POST');
        posts++;
        return response(issue(101, JSON.parse(options.body).body), 201);
      } });
    assert.equal(posts, 1, `Untrusted author ${JSON.stringify(user)} must not suppress publication`);
    assert.equal(result.status, 'complete');
    assert.equal(result.issues[0].action, 'created');
    assert.equal(result.issues[0].number, 101);
  }
});

test('new findings create separate issues with facts, target, full SHA and run URL', async (t) => {
  const directory = temporary(t);
  const created = [];
  const findings = [finding, { ...finding, id: 'http-home-html-v1', title: 'Home page did not return HTML' }];
  const result = await publishFindings({ directory, meta, findings, token: 'fixture',
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response([]);
      assert.equal(options.method, 'POST');
      const request = JSON.parse(options.body);
      assert(request.title.startsWith('[App audit] '));
      for (const fact of [appUrl, meta.sha, meta.runUrl, '503', 'HTTP', '386', '387']) assert(request.body.includes(fact), fact);
      created.push(request);
      return response({ ...issue(created.length, request.body), title: request.title }, 201);
    } });
  assert.equal(created.length, 2);
  assert.notEqual(created[0].body.split('\n')[0], created[1].body.split('\n')[0]);
  assert.deepEqual(result.issues.map(({ action }) => action), ['created', 'created']);
});

test('two manual training audits publish the same stable example once, even after closure', async (t) => {
  const directory = temporary(t);
  const training = { ...meta, mode: 'training', eventName: 'workflow_dispatch' };
  const example = { ...finding, id: 'training-deduplication-v1', title: 'Учебная находка',
    evidence: { training: true, confirmedFailure: false }, analysis: 'Учебный пример; это не подтверждённый сбой.' };
  const issues = [];
  let writes = 0;
  const fetchImpl = async (_url, options) => {
    if (options.method === 'GET') return response(issues);
    writes++;
    const request = JSON.parse(options.body);
    assert.equal(request.title, '[App audit training] Учебный пример дедупликации');
    assert.match(request.body, /УЧЕБНЫЙ ПРИМЕР/);
    assert.match(request.body, /не подтверждённый сбой приложения/);
    issues.push(issue(123, request.body));
    return response(issues.at(-1), 201);
  };
  const first = await publishFindings({ directory, meta: training, findings: [example], token: 'fixture', fetchImpl });
  issues[0].state = 'closed';
  const second = await publishFindings({ directory, meta: { ...training, sha: 'b'.repeat(40),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/456/attempts/2` },
  findings: [{ ...example, title: 'Иная формулировка', analysis: 'Другая учебная формулировка.' }], token: 'fixture', fetchImpl });
  assert.equal(writes, 1);
  assert.equal(first.issues[0].action, 'created');
  assert.equal(second.issues[0].action, 'existing');
  assert.equal(first.issues[0].key, second.issues[0].key);
  assert.equal(first.issues[0].url, second.issues[0].url);
});

test('no findings cause no issue writes or API calls', async (t) => {
  const directory = temporary(t);
  const result = await publishFindings({ directory, meta, findings: [], token: '',
    fetchImpl: async () => { throw new Error('No API calls expected'); } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.issues, []);
});

test('publication rejects schedule training, off-main manual runs and foreign targets before API access', async (t) => {
  const directory = temporary(t);
  let calls = 0;
  for (const invalid of [
    { ...meta, mode: 'training' },
    { ...meta, mode: 'training', eventName: 'workflow_dispatch', ref: 'refs/heads/work' },
    { ...meta, eventName: 'workflow_dispatch', ref: 'refs/heads/work' },
    { ...meta, eventName: 'pull_request' },
    { ...meta, repository: 'someone/else' },
    { ...meta, sha: 'short' },
    { ...meta, runUrl: 'https://github.com/someone/else/actions/runs/123' },
    { ...meta, mode: 'unknown' },
  ]) {
    await assert.rejects(publishFindings({ directory, meta: invalid, findings: [finding], token: 'fixture',
      fetchImpl: async () => { calls++; return response([]); } }));
    assert.equal(publication(directory).status, 'failed');
  }
  assert.equal(calls, 0);
  assert.equal(assertPublicationMeta({ ...meta, mode: 'training', eventName: 'workflow_dispatch' }).mode, 'training');
});

test('mode boundaries and duplicate rule IDs are validated before partial publication', async (t) => {
  const directory = temporary(t);
  for (const findings of [
    [finding, finding],
    [{ ...finding, id: 'model-invented-rule' }],
    [{ ...finding, id: 'training-deduplication-v1' }],
    [{ ...finding, analysis: '' }],
    [{ ...finding, title: 'title\nwith newline' }],
    [{ ...finding, evidence: undefined }],
  ]) {
    await assert.rejects(publishFindings({ directory, meta, findings, token: 'fixture',
      fetchImpl: async () => { throw new Error('Must validate before API calls'); } }));
    assert.equal(publication(directory).status, 'failed');
    assert.deepEqual(publication(directory).issues, []);
  }
  await assert.rejects(publishFindings({ directory, meta: { ...meta, mode: 'training', eventName: 'workflow_dispatch' },
    findings: [], token: 'fixture' }), /one stable example/);
});

test('listing errors and malformed API data fail closed instead of creating issues', async (t) => {
  const directory = temporary(t);
  for (const fetchImpl of [
    async () => response({ message: 'Forbidden' }, 403),
    async () => new Response('not JSON', { status: 200 }),
    async () => response({ items: [] }),
    async () => response([{ ...issue(1, `${marker()}\n`), html_url: 'https://example.com/fake' }]),
    async () => { throw new DOMException('Fixture timeout', 'TimeoutError'); },
  ]) {
    await assert.rejects(publishFindings({ directory, meta, findings: [finding], token: 'fixture', fetchImpl }));
    const saved = publication(directory);
    assert.equal(saved.status, 'failed');
    assert.deepEqual(saved.issues, []);
    assert.equal(saved.pending, null);
    assert(!saved.error.includes('fixture-token'));
  }
});

test('failure on a later pagination page prevents publication despite earlier matching issues', async (t) => {
  const directory = temporary(t);
  const first = [issue(1, `${marker()}\n`), ...Array.from({ length: 99 }, (_, i) => issue(i + 2))];
  let calls = 0;
  await assert.rejects(publishFindings({ directory, meta, findings: [finding], token: 'fixture',
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'GET');
      calls++;
      return calls === 1 ? response(first) : response({}, 500);
    } }), /HTTP 500/);
  assert.equal(calls, 2);
  assert.equal(publication(directory).status, 'failed');
});

test('POST failures are not retried and preserve earlier created links and pending identity', async (t) => {
  const directory = temporary(t);
  let posts = 0;
  await assert.rejects(publishFindings({ directory, meta,
    findings: [finding, { ...finding, id: 'http-owner-html-v1' }], token: 'fixture',
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response([]);
      posts++;
      if (posts === 1) return response(issue(101, JSON.parse(options.body).body), 201);
      throw new Error('Simulated timeout after request may have reached GitHub');
    } }), /failed or timed out/);
  assert.equal(posts, 2);
  const saved = publication(directory);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.issues.length, 1);
  assert.equal(saved.issues[0].url, `https://github.com/${REPOSITORY}/issues/101`);
  assert.equal(saved.pending.id, 'http-owner-html-v1');
});

test('malformed creation response is an error with retained pending identity', async (t) => {
  const directory = temporary(t);
  await assert.rejects(publishFindings({ directory, meta, findings: [finding], token: 'fixture',
    fetchImpl: async (_url, options) => options.method === 'GET' ? response([]) : response({ number: 123 }, 201) }),
  /Malformed GitHub issue response/);
  assert.equal(publication(directory).status, 'failed');
  assert.equal(publication(directory).pending.id, finding.id);
});

test('creation responses must identify the GITHUB_TOKEN publisher independently of their marker', async (t) => {
  for (const user of [{ login: 'ordinary-user', type: 'User' }, { login: 'another-agent[bot]', type: 'Bot' }, undefined]) {
    const directory = temporary(t);
    await assert.rejects(publishFindings({ directory, meta, findings: [finding], token: 'fixture',
      fetchImpl: async (_url, options) => options.method === 'GET' ? response([])
        : response({ ...issue(123, JSON.parse(options.body).body), user }, 201) }),
    /Created issue author does not match/);
    const saved = publication(directory);
    assert.equal(saved.status, 'failed');
    assert.deepEqual(saved.issues, []);
    assert.equal(saved.pending.id, finding.id);
  }
});

test('pagination cap is an explicit error instead of silently trusting a truncated history', async () => {
  let calls = 0;
  const batch = Array.from({ length: 100 }, (_, i) => issue(i + 1));
  await assert.rejects(listAuditIssues({ repository: REPOSITORY, token: 'fixture', fetchImpl: async () => {
    calls++;
    return response(batch);
  } }), /pagination exceeded/);
  assert.equal(calls, 1000);
});
