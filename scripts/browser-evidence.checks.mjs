import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { identity, observations, render } from './browser-evidence.mjs';

const head = 'a'.repeat(40);
const event = {
  repository: { full_name: 'owner/repo' },
  pull_request: { number: 42, head: { sha: head } },
};
const env = {
  GITHUB_RUN_ATTEMPT: '2', GITHUB_RUN_ID: '123',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo',
};

test('browser identity records the full PR head, never the merge SHA', () => {
  assert.deepEqual(identity(event, head, env), {
    repository: 'owner/repo', pullRequest: 42, headSha: head, checkoutSha: head,
    runAttempt: '2', runUrl: 'https://github.com/owner/repo/actions/runs/123',
  });
  assert.throws(() => identity(event, 'b'.repeat(40), env), /Checkout differs/);
  assert.throws(() => identity({ ...event, pull_request: undefined }, head, env), /pull_request/);
  assert.throws(() => identity({ ...event, pull_request: { number: 42, head: { sha: 'abcdef' } } }, head, env), /full head SHA/);
});

test('reports use observed results and cannot turn missing or failed tests into success', () => {
  const report = { suites: [{ suites: [{ specs: [{
    title: 'real browser fixture', file: 'browser/booking-conflict.browser.ts',
    tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 10, errors: [{ message: '409 missing' }] }] }],
  }] }] }] };
  const rows = observations(report);
  assert.equal(rows[0].status, 'unexpected');
  assert.match(rows[0].steps.join('\n'), /Соседний.*настоящему Fastify/);
  const metadata = identity(event, head, env);
  assert.match(render(metadata, rows, 'success'), /FAIL \/ INCOMPLETE/);
  assert.match(render(metadata, rows, 'failure'), /409 missing/);
  assert.match(render(metadata, [], 'success'), /успешная браузерная проверка не подтверждена/);
  rows[0].status = 'expected';
  assert.match(render(metadata, rows, 'success'), /Result: PASS/);
  assert.match(render(metadata, rows, 'skipped'), /FAIL \/ INCOMPLETE/);
});

test('stable CI and browser checks run on all PR changes with no secret or write permission', () => {
  const check = load(readFileSync('.github/workflows/check.yml', 'utf8'));
  const browser = load(readFileSync('.github/workflows/browser-evidence.yml', 'utf8'));
  for (const workflow of [check, browser]) {
    assert.deepEqual(workflow.on.pull_request.branches, ['main']);
    assert.equal(workflow.on.pull_request.paths, undefined);
    assert.equal(workflow.on.pull_request['paths-ignore'], undefined);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|OPENAI_API_KEY|id-token|pull_request_target/);
  }
  assert.equal(check.jobs.check.name, 'check');
  assert.ok(check.jobs.check.steps.some(({ run }) => run === 'mise run check'));
  const steps = browser.jobs['browser-evidence'].steps;
  const checkout = steps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(steps.find(({ name }) => name === 'Write observed results').if, 'always()');
  assert.equal(steps.find(({ uses }) => uses?.startsWith('actions/upload-artifact@')).if, 'always()');
});
