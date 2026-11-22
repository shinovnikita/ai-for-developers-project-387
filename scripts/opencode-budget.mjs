#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LIMIT = 6;
export const STATE_BRANCH = 'opencode-budget';
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function reservationKey(value) {
  return `${value.runId}:${value.attempt}:${value.kind}`;
}

function validateReservation(value) {
  assert(value && typeof value === 'object', 'Invalid budget reservation');
  assert(Number.isSafeInteger(value.pr) && value.pr > 0, 'Invalid PR number');
  assert(SHA.test(value.sha), 'Expected a complete PR head SHA');
  assert(typeof value.runId === 'string' && /^[1-9][0-9]*$/.test(value.runId), 'Invalid workflow run ID');
  assert(Number.isSafeInteger(value.attempt) && value.attempt > 0, 'Invalid workflow run attempt');
  assert(['review', 'fix'].includes(value.kind), 'Invalid session kind');
  assert(typeof value.log === 'string' && /^https:\/\//.test(value.log), 'Invalid workflow log URL');
  assert(typeof value.reservedAt === 'string'
    && !Number.isNaN(Date.parse(value.reservedAt)), 'Invalid reservation timestamp');
}

export function validateLedger(ledger, repository) {
  assert(REPOSITORY.test(repository), 'Invalid repository');
  assert(ledger?.schema === 1, 'Unsupported or missing budget schema');
  assert.equal(ledger.repository, repository, 'Budget repository mismatch');
  assert(Array.isArray(ledger.reservations), 'Missing budget reservations');
  const seen = new Set();
  for (const reservation of ledger.reservations) {
    validateReservation(reservation);
    const key = reservationKey(reservation);
    assert(!seen.has(key), 'Duplicate session in budget ledger');
    seen.add(key);
  }
  return ledger;
}

// One successful fast-forward update reserves one whole OpenCode session. The
// reservation is never refunded: cancellation, failure and rerun cannot reset it.
export async function reserveBudget({ store, reservation, limit = DEFAULT_LIMIT, maxAttempts = 12 }) {
  validateReservation(reservation);
  assert(Number.isSafeInteger(limit) && limit > 0, 'Invalid trusted budget limit');
  assert(Number.isSafeInteger(maxAttempts) && maxAttempts > 0, 'Invalid retry limit');
  const details = {
    pr: reservation.pr, sha: reservation.sha, kind: reservation.kind,
    runId: reservation.runId, attempt: reservation.attempt, log: reservation.log, limit,
  };
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { commit, ledger } = await store.read();
      assert(SHA.test(commit), 'Invalid budget state commit');
      validateLedger(ledger, store.repository);
      const used = ledger.reservations.filter(({ pr }) => pr === reservation.pr).length;
      if (ledger.reservations.some((entry) => reservationKey(entry) === reservationKey(reservation))) {
        return { ...details, allowed: false, reason: 'session-already-reserved', used };
      }
      if (used >= limit) return { ...details, allowed: false, reason: 'budget-exhausted', used };
      const next = { ...ledger, reservations: [...ledger.reservations, reservation] };
      if (await store.append(commit, next)) {
        return { ...details, allowed: true, reason: 'reserved', used: used + 1 };
      }
      // A concurrent fast-forward won. Re-read the full durable ledger before
      // considering another reservation; never infer an empty state from errors.
    }
    return { ...details, allowed: false, reason: 'reservation-contention' };
  } catch (error) {
    return { ...details, allowed: false, reason: 'budget-state-unavailable', error: error.message };
  }
}

export class GitHubStore {
  constructor({ repository, token, fetchImpl = fetch }) {
    assert(REPOSITORY.test(repository), 'Invalid repository');
    assert(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required before model authorization');
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`GitHub budget API ${options.method ?? 'GET'} ${path}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async ref() {
    const state = await this.request(`/git/ref/heads/${STATE_BRANCH}`);
    assert(state.ref === `refs/heads/${STATE_BRANCH}` && state.object?.type === 'commit'
      && SHA.test(state.object.sha), 'Unexpected budget branch reference');
    return state.object.sha;
  }

  async read() {
    const commit = await this.ref();
    const stateCommit = await this.request(`/git/commits/${commit}`);
    assert(SHA.test(stateCommit.tree?.sha), 'Invalid budget tree');
    const tree = await this.request(`/git/trees/${stateCommit.tree.sha}`);
    assert(Array.isArray(tree.tree) && !tree.truncated, 'Incomplete budget tree');
    const file = tree.tree.find(({ path }) => path === 'budget.json');
    assert(file?.type === 'blob' && file.mode === '100644' && SHA.test(file.sha), 'Missing budget.json');
    const blob = await this.request(`/git/blobs/${file.sha}`);
    assert.equal(blob.encoding, 'base64', 'Unexpected budget encoding');
    assert(typeof blob.content === 'string', 'Missing budget content');
    const ledger = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    validateLedger(ledger, this.repository);
    return { commit, ledger };
  }

  async append(expectedCommit, ledger) {
    assert(SHA.test(expectedCommit), 'Invalid expected budget commit');
    validateLedger(ledger, this.repository);
    const parent = await this.request(`/git/commits/${expectedCommit}`);
    const tree = await this.request('/git/trees', {
      method: 'POST',
      body: {
        base_tree: parent.tree.sha,
        tree: [{ path: 'budget.json', mode: '100644', type: 'blob', content: `${JSON.stringify(ledger, null, 2)}\n` }],
      },
    });
    const reservation = ledger.reservations.at(-1);
    const commit = await this.request('/git/commits', {
      method: 'POST',
      body: {
        // Distinct candidates even for duplicate invocations of the same gate:
        // otherwise identical Git objects could let both PATCH calls succeed.
        message: `chore: reserve ${reservation.kind} session for PR #${reservation.pr}\n\nReservation candidate: ${randomUUID()}`,
        tree: tree.sha,
        parents: [expectedCommit],
      },
    });
    try {
      await this.request(`/git/refs/heads/${STATE_BRANCH}`, {
        method: 'PATCH', body: { sha: commit.sha, force: false },
      });
      return true;
    } catch (error) {
      // Sibling commits cannot fast-forward the same ref. Only a confirmed
      // reference change is a retryable race, not permissions or API failure.
      if ((error.status === 409 || error.status === 422) && await this.ref() !== expectedCommit) return false;
      throw error;
    }
  }
}

function argumentsForCLI(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(['--pr', '--sha', '--kind', '--output'].includes(args[index])
      && args[index + 1] && !result[args[index]], 'Usage: --pr N --sha FULL --kind review|fix --output PATH');
    result[args[index]] = args[index + 1];
  }
  assert(Object.keys(result).length === 4, 'Usage: --pr N --sha FULL --kind review|fix --output PATH');
  return result;
}

async function main() {
  const args = argumentsForCLI(process.argv.slice(2));
  const reservation = {
    pr: Number(args['--pr']), sha: args['--sha'], kind: args['--kind'],
    runId: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    log: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
    reservedAt: new Date().toISOString(),
  };
  let decision;
  try {
    validateReservation(reservation);
    const store = new GitHubStore({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
    decision = await reserveBudget({ store, reservation });
  } catch (error) {
    decision = { ...reservation, allowed: false, reason: 'budget-state-unavailable', error: error.message, limit: DEFAULT_LIMIT };
  }
  writeFileSync(args['--output'], `${JSON.stringify(decision, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${decision.allowed}\n`);
  const summary = `OpenCode budget: ${decision.reason}; PR #${reservation.pr}; head ${reservation.sha}; log ${reservation.log}; used ${decision.used ?? 'unknown'}/${DEFAULT_LIMIT}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (!decision.allowed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`OpenCode budget refused: ${error.message}`);
    process.exitCode = 1;
  });
}
