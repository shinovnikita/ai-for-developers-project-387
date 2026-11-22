import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPullRequest, REPOSITORY } from './opencode-pr-policy.mjs';
import { correctionCommitMessage, resolveLinkedIssues } from './opencode-linked-issues.mjs';

// All issue objects below are REST fixtures; these tests do not contact GitHub.
const issueUrl = (number) => `https://github.com/${REPOSITORY}/issues/${number}`;
const metadata = (links) => `<!-- opencode-linked-issues: ${JSON.stringify(links)} -->`;
const issue = (number) => ({
  number, state: 'open', repository_url: `https://api.github.com/repos/${REPOSITORY}`,
  url: `https://api.github.com/repos/${REPOSITORY}/issues/${number}`, html_url: issueUrl(number),
});

const sha = 'a'.repeat(40);
function releasePullRequest() {
  return {
    number: 13, state: 'open',
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
    head: { ref: 'release-please--branches--main--components--call-calendar', sha,
      repo: { full_name: REPOSITORY } },
  };
}

test('release PR is readable by independent review but never automatically corrected', () => {
  const pr = releasePullRequest();
  assert.equal(assertPullRequest(pr, { sha, branch: pr.head.ref }, 'review'), pr);
  assert.throws(() => assertPullRequest(pr, {}, 'fix'), /PR must be/);
});

test('review release allowance retains repository, fork, state, protected branch and SHA guards', () => {
  for (const kind of ['review', 'fix']) {
    for (const change of [
      (pr) => { pr.state = 'closed'; },
      (pr) => { pr.base.ref = 'develop'; },
      (pr) => { pr.base.repo.full_name = 'someone/else'; },
      (pr) => { pr.head.repo.full_name = 'someone/fork'; },
      (pr) => { pr.head.ref = 'main'; },
      (pr) => { pr.head.ref = 'opencode-budget'; },
      (pr) => { pr.head.sha = 'short'; },
    ]) {
      const pr = releasePullRequest(); pr.head.ref = 'codex/work'; change(pr);
      assert.throws(() => assertPullRequest(pr, {}, kind), /PR must be/);
    }
  }
  const pr = releasePullRequest();
  assert.throws(() => assertPullRequest(pr, { sha: 'b'.repeat(40) }, 'review'), /Stale PR HEAD/);
  assert.throws(() => assertPullRequest(pr, { branch: 'release-please--changed' }, 'review'), /PR branch changed/);
  assert.throws(() => assertPullRequest(pr, {}, 'unknown'), /Unknown PR session kind/);
});

test('explicit verified linked tickets create distinct sorted Conventional Commit Refs', async () => {
  const lookedUp = [];
  const numbers = await resolveLinkedIssues(
    `Context #4 and ${issueUrl(7)} are ordinary mentions.\n${metadata([issueUrl(9), issueUrl(8), issueUrl(9)])}`,
    { readIssue: async (number) => { lookedUp.push(number); return issue(number); } },
  );
  assert.deepEqual(numbers, [8, 9]);
  assert.deepEqual(lookedUp, [8, 9]);
  assert.equal(correctionCommitMessage(numbers), 'fix: address PR review feedback\n\nRefs #8\nRefs #9');
  assert.equal(correctionCommitMessage([9, 8, 8]), correctionCommitMessage(numbers));
});

test('missing or empty linkage never turns prose, closing keywords or #4 into a commit reference', async () => {
  let lookups = 0;
  const options = { readIssue: async () => { lookups++; throw new Error('Unexpected lookup'); } };
  for (const body of [null, '', `Refs #4; closes #8; ${issueUrl(9)}`, `${metadata([])}\nRelated #4`]) {
    const numbers = await resolveLinkedIssues(body, options);
    assert.deepEqual(numbers, []);
    assert.equal(correctionCommitMessage(numbers), 'fix: address PR review feedback');
  }
  assert.equal(lookups, 0);
});

test('ambiguous, malformed or foreign linkage is rejected before any issue lookup', async () => {
  let lookups = 0;
  const options = { readIssue: async (number) => { lookups++; return issue(number); } };
  for (const body of [
    `${metadata([issueUrl(8)])}\n${metadata([issueUrl(9)])}`,
    '<!-- opencode-linked-issues: not-json -->',
    '<!-- opencode-linked-issues [] -->',
    '<!-- opencode-linked-issues: [8] -->',
    '<!-- opencode-linked-issues: null -->',
    metadata(['https://github.com/someone/else/issues/8']),
    metadata([`${issueUrl(8)}#issuecomment-123`]),
    metadata([`https://github.com/${REPOSITORY}/pull/14`]),
    metadata(['#8']),
    metadata([issueUrl(8), issueUrl(0)]),
  ]) await assert.rejects(resolveLinkedIssues(body, options));
  await assert.rejects(resolveLinkedIssues(metadata([issueUrl(8)]), { ...options, repository: 'someone/else' }), /configured repository/);
  assert.equal(lookups, 0);
});

test('linked issue lookup must prove an existing ordinary issue in the target repository', async () => {
  for (const response of [
    null,
    { ...issue(8), number: 9 },
    { ...issue(8), pull_request: {} },
    { ...issue(8), repository_url: 'https://api.github.com/repos/someone/else' },
    { ...issue(8), html_url: 'https://github.com/someone/else/issues/8' },
    { ...issue(8), url: `https://api.github.com/repos/${REPOSITORY}/pulls/8` },
  ]) {
    await assert.rejects(resolveLinkedIssues(metadata([issueUrl(8)]), { readIssue: async () => response }), /existing issue/);
  }
  await assert.rejects(resolveLinkedIssues(metadata([issueUrl(8)]), { readIssue: async () => { throw new Error('GitHub HTTP 404'); } }), /HTTP 404/);
  assert.deepEqual(await resolveLinkedIssues(metadata([issueUrl(8)]), {
    readIssue: async () => ({ ...issue(8), state: 'closed' }),
  }), [8]);
});
