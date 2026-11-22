import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_LIMIT, GitHubStore, reserveBudget, validateLedger } from './opencode-budget.mjs';

const repository = 'shinovnikita/ai-for-developers-project-387';
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const stateSha = (revision) => revision.toString(16).padStart(40, '0');
const ledger = () => ({ schema: 1, repository, reservations: [] });
const reservation = (number, overrides = {}) => ({
  pr: 42, sha, runId: String(1000 + number), attempt: 1, kind: 'review',
  log: `https://github.com/${repository}/actions/runs/${1000 + number}/attempts/1`,
  reservedAt: '2026-11-22T18:00:00.000Z', ...overrides,
});

// Deterministic adapters below exercise the real reservation/REST algorithms.
// They are fixtures, not real GitHub requests or OpenCode/model sessions.
class MemoryStore {
  repository = repository;
  revision = 1;
  ledger = ledger();
  conflicts = 0;

  async read() {
    return { commit: stateSha(this.revision), ledger: structuredClone(this.ledger) };
  }

  async append(expected, next) {
    if (expected !== stateSha(this.revision)) {
      this.conflicts += 1;
      return false;
    }
    this.ledger = structuredClone(next);
    this.revision += 1;
    return true;
  }
}

test('one reservation is a whole session and exhausted budget refuses both session kinds', async () => {
  const store = new MemoryStore();
  for (let index = 0; index < DEFAULT_LIMIT; index += 1) {
    const result = await reserveBudget({ store, reservation: reservation(index, { kind: index % 2 ? 'fix' : 'review' }) });
    assert.equal(result.allowed, true);
    assert.equal(result.used, index + 1);
  }
  for (const kind of ['review', 'fix']) {
    const result = await reserveBudget({ store, reservation: reservation(99, { kind }) });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'budget-exhausted');
    assert.equal(result.used, 6);
    assert.equal(result.sha, sha);
    assert.match(result.log, /actions\/runs\/1099/);
  }
  assert.equal(store.ledger.reservations.length, 6);
});

test('SHA changes, retries and cancelled/failed sessions retain reservations; PRs have separate totals', async () => {
  const store = new MemoryStore();
  const first = reservation(0);
  assert.equal((await reserveBudget({ store, reservation: first })).used, 1);
  // No refund operation exists; a later SHA and another run attempt still count.
  const rerun = await reserveBudget({ store, reservation: { ...first, sha: otherSha, attempt: 2 } });
  assert.equal(rerun.allowed, true);
  assert.equal(rerun.used, 2);
  const another = await reserveBudget({ store, reservation: reservation(1, { sha: otherSha }) });
  assert.equal(another.used, 3);
  const otherPR = await reserveBudget({ store, reservation: reservation(2, { pr: 43 }) });
  assert.equal(otherPR.used, 1);
  assert.deepEqual(store.ledger.reservations.map(({ sha: head }) => head), [sha, otherSha, otherSha, sha]);
});

test('the same run attempt cannot reserve twice, including after a SHA change', async () => {
  const store = new MemoryStore();
  await reserveBudget({ store, reservation: reservation(1) });
  const duplicate = await reserveBudget({ store, reservation: reservation(1, { sha: otherSha }) });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, 'session-already-reserved');
  assert.equal(store.ledger.reservations.length, 1);
});

test('concurrent duplicate invocations permit only one session for a run attempt', async () => {
  const store = new MemoryStore();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    reserveBudget({ store, reservation: reservation(1) })));
  assert.equal(results.filter(({ allowed }) => allowed).length, 1);
  assert.equal(store.ledger.reservations.length, 1);
  assert(results.filter(({ allowed }) => !allowed).every(({ reason }) => reason === 'session-already-reserved'));
});

test('parallel reservations retry compare-and-swap conflicts without exceeding the common PR limit', async () => {
  const store = new MemoryStore();
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    reserveBudget({ store, reservation: reservation(index, { kind: index % 2 ? 'fix' : 'review' }), maxAttempts: 40 })));
  assert.equal(results.filter(({ allowed }) => allowed).length, DEFAULT_LIMIT);
  assert.equal(store.ledger.reservations.length, DEFAULT_LIMIT);
  assert(store.conflicts > 0, 'The fixture must actually exercise racing writes');
  assert(results.filter(({ allowed }) => !allowed).every(({ reason }) => reason === 'budget-exhausted'));
  assert.equal(new Set(store.ledger.reservations.map(({ runId }) => runId)).size, DEFAULT_LIMIT);
});

test('missing, corrupt, wrong-repository or unreadable state fails closed without append', async () => {
  for (const broken of [null, {}, { ...ledger(), schema: 2 }, { ...ledger(), repository: 'someone/fork' },
    { ...ledger(), reservations: [reservation(1), reservation(1)] }]) {
    let writes = 0;
    const store = { repository, read: async () => ({ commit: sha, ledger: broken }), append: async () => { writes += 1; } };
    const result = await reserveBudget({ store, reservation: reservation(2) });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'budget-state-unavailable');
    assert.equal(writes, 0);
  }
  const result = await reserveBudget({ store: { repository, read: async () => { throw new Error('HTTP 404'); } }, reservation: reservation(1) });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'budget-state-unavailable');
});

test('permanent append errors do not retry as if the state were empty', async () => {
  let reads = 0;
  let appends = 0;
  const result = await reserveBudget({
    store: {
      repository,
      read: async () => { reads += 1; return { commit: sha, ledger: ledger() }; },
      append: async () => { appends += 1; throw new Error('HTTP 403'); },
    }, reservation: reservation(1),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'budget-state-unavailable');
  assert.equal(reads, 1);
  assert.equal(appends, 1);
});

test('bounded contention refuses a session instead of allowing an unreserved model call', async () => {
  const store = { repository, read: async () => ({ commit: sha, ledger: ledger() }), append: async () => false };
  const result = await reserveBudget({ store, reservation: reservation(1), maxAttempts: 2 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'reservation-contention');
});

test('ledger schema rejects invalid records instead of treating them as uncounted sessions', () => {
  for (const invalid of [
    { sha: 'merge-sha' }, { pr: 0 }, { runId: 123 }, { attempt: 0 }, { kind: 'model-supplied' },
    { reservedAt: 'yesterday' }, { log: 'file:///tmp/log' },
  ]) assert.throws(() => validateLedger({ ...ledger(), reservations: [reservation(1, invalid)] }, repository));
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('REST store reads exact ref, commit, tree and blob and appends a non-force child commit', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = url.split(repository)[1];
    const body = options.body && JSON.parse(options.body);
    calls.push({ path, method: options.method, body, headers: options.headers });
    if (path === '/git/ref/heads/opencode-budget') return response(200, { ref: 'refs/heads/opencode-budget', object: { type: 'commit', sha } });
    if (path === `/git/commits/${sha}`) return response(200, { tree: { sha: stateSha(2) } });
    if (path === `/git/trees/${stateSha(2)}`) return response(200, { tree: [{ path: 'budget.json', type: 'blob', mode: '100644', sha: stateSha(3) }], truncated: false });
    if (path === `/git/blobs/${stateSha(3)}`) return response(200, { encoding: 'base64', content: Buffer.from(JSON.stringify(ledger())).toString('base64') });
    if (path === '/git/trees') return response(201, { sha: stateSha(4) });
    if (path === '/git/commits') return response(201, { sha: stateSha(5) });
    if (path === '/git/refs/heads/opencode-budget') return response(200, {});
    assert.fail(`Unexpected fixture request ${path}`);
  };
  const store = new GitHubStore({ repository, token: 'fixture-token', fetchImpl });
  const result = await reserveBudget({ store, reservation: reservation(1) });
  assert.equal(result.allowed, true);
  assert.deepEqual(calls.find(({ path }) => path === '/git/commits').body.parents, [sha]);
  assert.deepEqual(calls.find(({ path }) => path === '/git/refs/heads/opencode-budget').body, { sha: stateSha(5), force: false });
  const tree = calls.find(({ path }) => path === '/git/trees').body;
  assert.equal(tree.base_tree, stateSha(2));
  assert.equal(JSON.parse(tree.tree[0].content).reservations.length, 1);
  await store.append(sha, { ...ledger(), reservations: [reservation(1)] });
  const candidates = calls.filter(({ path }) => path === '/git/commits').map(({ body }) => body.message);
  assert.equal(new Set(candidates).size, 2, 'Identical gate invocations must create sibling Git objects, not the same commit');
  assert(calls.every(({ headers }) => headers.Authorization === 'Bearer fixture-token'));
});

test('REST 404 never initializes a branch or resets state', async () => {
  const calls = [];
  const store = new GitHubStore({ repository, token: 'fixture-token', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    return response(404, {});
  } });
  const decision = await reserveBudget({ store, reservation: reservation(1) });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'budget-state-unavailable');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('REST reports a retryable CAS race only after confirming the ref changed', async () => {
  for (const changed of [true, false]) {
    const store = new GitHubStore({ repository, token: 'fixture-token', fetchImpl: async (url, options) => {
      const path = url.split(repository)[1];
      if (path === `/git/commits/${sha}`) return response(200, { tree: { sha: stateSha(2) } });
      if (path === '/git/trees') return response(201, { sha: stateSha(3) });
      if (path === '/git/commits') return response(201, { sha: stateSha(4) });
      if (path === '/git/refs/heads/opencode-budget' && options.method === 'PATCH') return response(422, {});
      if (path === '/git/ref/heads/opencode-budget') return response(200, { ref: 'refs/heads/opencode-budget', object: { type: 'commit', sha: changed ? otherSha : sha } });
      assert.fail(`Unexpected fixture request ${path}`);
    } });
    const next = { ...ledger(), reservations: [reservation(1)] };
    if (changed) assert.equal(await store.append(sha, next), false);
    else await assert.rejects(store.append(sha, next), /HTTP 422/);
  }
});

test('CLI refusal exits nonzero, persists PR/head/log, and makes no model invocation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'budget-refusal-'));
  try {
    const output = join(directory, 'outputs');
    const summary = join(directory, 'summary');
    const decision = join(directory, 'decision.json');
    const calls = join(directory, 'model-calls');
    writeFileSync(calls, '');
    writeFileSync(join(directory, 'opencode'), '#!/bin/sh\nprintf invoked >> "$MODEL_CALLS"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [resolve('scripts/opencode-budget.mjs'), '--pr', '42', '--sha', sha, '--kind', 'review', '--output', decision], {
      env: {
        PATH: `${directory}:${process.env.PATH}`, MODEL_CALLS: calls,
        GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        // Deliberately no GH_TOKEN or model key. Authorization failure must be
        // detected by plain code rather than starting OpenCode to obtain auth.
      }, encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    const refusal = JSON.parse(readFileSync(decision, 'utf8'));
    assert.equal(refusal.allowed, false);
    assert.equal(refusal.pr, 42);
    assert.equal(refusal.sha, sha);
    assert.equal(refusal.reason, 'budget-state-unavailable');
    assert.equal(refusal.log, `https://github.com/${repository}/actions/runs/1234/attempts/2`);
    assert.equal(readFileSync(output, 'utf8'), 'allowed=false\n');
    assert.match(readFileSync(summary, 'utf8'), /budget-state-unavailable/);
    assert.equal(readFileSync(calls, 'utf8'), '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
