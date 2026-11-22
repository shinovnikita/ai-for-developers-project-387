import assert from 'node:assert/strict';
import { REPOSITORY } from './opencode-pr-policy.mjs';

// This explicit metadata block is the only source of correction commit Refs.
// Links in ordinary PR prose, comments, model output and closing keywords do not
// establish a relationship for this publisher.
export async function resolveLinkedIssues(body, { repository = REPOSITORY, readIssue } = {}) {
  assert.equal(repository, REPOSITORY, 'Linked issues must target the configured repository');
  assert(body === null || body === undefined || typeof body === 'string', 'Invalid PR body');
  const text = body ?? '';
  const markers = [...text.matchAll(/<!--\s*opencode-linked-issues\b/g)];
  if (!markers.length) return [];
  const blocks = [...text.matchAll(/<!--\s*opencode-linked-issues:\s*([\s\S]*?)\s*-->/g)];
  assert(markers.length === 1 && blocks.length === 1, 'Expected exactly one linked-issues metadata block');
  let links;
  try { links = JSON.parse(blocks[0][1]); }
  catch { throw new Error('Linked issues metadata must contain a JSON array of full issue URLs'); }
  assert(Array.isArray(links) && links.length <= 100, 'Linked issues metadata must be a bounded JSON array');
  const numbers = new Set();
  for (const link of links) {
    assert(typeof link === 'string', 'Linked issue must be a full GitHub issue URL');
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(link);
    assert(match && match[1] === repository, 'Linked issue must be a full same-repository issue URL');
    const number = Number(match[2]);
    assert(Number.isSafeInteger(number), 'Invalid linked issue number');
    numbers.add(number);
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  assert(!sorted.length || typeof readIssue === 'function', 'GitHub issue lookup is required');
  for (const number of sorted) {
    const issue = await readIssue(number);
    assert(issue?.number === number && !issue.pull_request
      && issue.repository_url === `https://api.github.com/repos/${repository}`
      && issue.url === `https://api.github.com/repos/${repository}/issues/${number}`
      && issue.html_url === `https://github.com/${repository}/issues/${number}`,
    `Linked issue #${number} does not identify an existing issue in the target repository`);
  }
  return sorted;
}

export function correctionCommitMessage(issueNumbers) {
  assert(Array.isArray(issueNumbers)
    && issueNumbers.every((number) => Number.isSafeInteger(number) && number > 0), 'Invalid linked issue numbers');
  const references = [...new Set(issueNumbers)].sort((a, b) => a - b).map((number) => `Refs #${number}`);
  return `fix: address PR review feedback${references.length ? `\n\n${references.join('\n')}` : ''}`;
}
