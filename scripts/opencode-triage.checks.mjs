import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

const workflow = load(readFileSync('.github/workflows/opencode-triage.yml', 'utf8'));
const manual = load(readFileSync('.github/workflows/opencode.yml', 'utf8'));
const job = workflow.jobs.triage;
const [filter, ...protectedSteps] = job.steps;
const agent = protectedSteps.find(({ name }) => name === 'Run OpenCode');
const gate = "steps.eligibility.outputs.allowed == 'true'";
const repository = 'shinovnikita/ai-for-developers-project-387';

// These fixtures exercise the actual workflow shell, without GitHub or a model.
// Ready fixtures deliberately retain the same trusted human as the allowed case.
const ordinary = {
  action: 'opened',
  repository: { full_name: repository },
  sender: { login: 'unrelated-sender', type: 'Bot' },
  issue: {
    number: 12345,
    user: { login: 'shinovnikita', type: 'User' },
    labels: [],
    title: 'Fixture: a new request',
    body: 'A calendar request without a command mention.',
  },
};

const fixtures = [
  { name: 'trusted User, ordinary issue without /oc', allowed: true },
  { name: 'same trusted User, ready-for-agent', labels: ['enhancement', 'ready-for-agent'], allowed: false },
  { name: 'same trusted User, ready-for-human', labels: ['ready-for-human'], allowed: false },
  { name: 'bot', user: { login: 'opencode-agent[bot]', type: 'Bot' }, allowed: false },
  { name: 'trusted login with Bot account type', user: { login: 'shinovnikita', type: 'Bot' }, allowed: false },
  { name: 'untrusted User despite trusted sender', user: { login: 'someone-else', type: 'User' },
    sender: ordinary.issue.user, allowed: false },
  { name: 'another repository', repository: 'someone-else/fork', allowed: false },
  { name: 'label added later is not an opened event', action: 'labeled', allowed: false },
  { name: 'issue_comment is not an issues event', eventName: 'issue_comment', allowed: false },
  { name: 'PR is not an ordinary issue', pullRequest: {}, allowed: false },
  { name: 'missing author', user: null, allowed: false },
  { name: 'shell and expression syntax in issue text remains data',
    body: '$(exit 99) `exit 98`\nNODE\nexit 97\n${{ secrets.OPENAI_API_KEY }}', allowed: true },
];

test('workflow gates every checkout, setup and model step before exposing credentials', () => {
  assert.deepEqual(workflow.on, { issues: { types: ['opened'] } });
  assert.equal(job.if, `github.repository == '${repository}'`);
  assert.equal(filter.id, 'eligibility');
  assert.equal(filter.if, undefined);
  assert.equal(filter.env, undefined);
  assert.equal(workflow.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.equal(protectedSteps.length, 4);
  for (const step of protectedSteps) assert.equal(step.if, gate, step.name);
  const secretSteps = job.steps.filter((step) => JSON.stringify(step).includes('secrets.'));
  assert.deepEqual(secretSteps, [agent]);
  assert.equal(agent.env.OPENAI_API_KEY, '${{ secrets.OPENAI_API_KEY }}');
  for (const step of job.steps) {
    // Untrusted issue fields must never become executable shell source.
    assert.doesNotMatch(step.run ?? '', /\$\{\{/);
  }
});

test('trusted runtime, auth and concurrency match the manual workflow', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(job.permissions, undefined);
  assert.equal(job['timeout-minutes'], 20);
  assert.deepEqual(job.concurrency, manual.jobs.opencode.concurrency);
  assert.equal(job.concurrency.group, 'opencode-${{ github.repository }}');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  const checkout = protectedSteps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
  assert.deepEqual(checkout.with, { ref: 'refs/heads/main', 'persist-credentials': false });
  const manualSteps = manual.jobs.opencode.steps;
  const install = protectedSteps.find(({ name }) => name.startsWith('Install OpenCode'));
  assert.equal(install.run, manualSteps.find(({ name }) => name.startsWith('Install OpenCode')).run);
  assert.match(install.run, /opencode-ai@1\.19\.6/);
  assert.equal(agent.run, manualSteps.find(({ name }) => name === 'Run OpenCode').run);
  for (const key of ['MODEL', 'VARIANT', 'SHARE', 'OPENCODE_PERMISSION', 'GH_PROMPT_DISABLED']) {
    assert.equal(agent.env[key], manualSteps.find(({ name }) => name === 'Run OpenCode').env[key], key);
  }
  assert.equal(agent.env.MODEL, 'openai/gpt-6.1-sol');
  assert.equal(agent.env.SHARE, 'false');
  assert.ok(agent.env.PROMPT.trim());
  assert.doesNotMatch(agent.env.PROMPT, /\$\{\{/);
  // Readiness filtering is exclusive to auto-triage; manual commands stay usable.
  assert.deepEqual(manual.on, { issue_comment: { types: ['created'] }, workflow_run: { workflows: ['OpenCode inline request'], types: ['completed'] } });
  assert.doesNotMatch(JSON.stringify(manual), /ready-for-agent|ready-for-human/);
  assert.equal(manualSteps.find(({ name }) => name === 'Run OpenCode').env.MENTIONS, '/oc,/opencode');
});

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-triage-'));
    try {
      const event = structuredClone(ordinary);
      if (fixture.user !== undefined) event.issue.user = fixture.user;
      if (fixture.labels) event.issue.labels = fixture.labels.map((name) => ({ name }));
      if (fixture.repository) event.repository.full_name = fixture.repository;
      if (fixture.sender) event.sender = fixture.sender;
      if (fixture.action) event.action = fixture.action;
      if (fixture.pullRequest) event.issue.pull_request = fixture.pullRequest;
      if (fixture.body) event.issue.body = event.issue.title = fixture.body;
      const eventPath = join(directory, 'event.json');
      const outputPath = join(directory, 'output');
      const callsPath = join(directory, 'model-calls');
      writeFileSync(eventPath, JSON.stringify(event));
      writeFileSync(outputPath, '');
      const env = {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: fixture.eventName ?? 'issues',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      };
      const filtered = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', filter.run], {
        cwd: directory, env, encoding: 'utf8',
      });
      assert.equal(filtered.status, 0, filtered.stderr);
      const output = readFileSync(outputPath, 'utf8');
      assert.equal(output, `allowed=${fixture.allowed}\n`);
      assert.equal(filtered.stdout, `Issue eligibility: allowed=${fixture.allowed}\n`);

      // Evaluate the exact, structurally asserted step gate, then execute the
      // actual model-step shell with a harmless OpenCode stand-in. No API calls.
      writeFileSync(callsPath, '');
      writeFileSync(join(directory, 'opencode'), '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.19.6\nelse\n  echo "$*" >> "$MODEL_CALLS"\nfi\n', { mode: 0o755 });
      assert.equal(agent.if, gate);
      if (output === 'allowed=true\n') {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', agent.run], {
          cwd: directory,
          env: { PATH: `${directory}:${process.env.PATH}`, MODEL_CALLS: callsPath },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(readFileSync(callsPath, 'utf8'), fixture.allowed ? 'github run\n' : '');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
