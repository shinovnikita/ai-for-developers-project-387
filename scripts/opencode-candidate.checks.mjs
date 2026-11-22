import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';
import {
  CHECK_IMAGE, WORKFLOW_PATH, checkCandidate, commitAndPush, isolatedArguments,
  reconstruct, snapshot, verifyArtifactMetadata, verifyJobs, verifyReceipt,
} from './opencode-candidate.mjs';
import { REPOSITORY } from './opencode-pr-policy.mjs';

// These checks use real local Git repositories, but Docker/mise execution and
// GitHub API responses are explicit fixtures. No model, GitHub or network runs.
const workflowSha = 'a'.repeat(40);
const artifactDigest = 'd'.repeat(64);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const identity = { repository: REPOSITORY, workflowSha, runId: '700', attempt: 1 };
const artifact = { ...identity, id: '801', name: 'correction-proposal-700-1', digest: artifactDigest };

function git(directory, args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(directory, path, content, mode = 0o644) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), content, { mode });
}
function materialize(files, directory) {
  mkdirSync(directory, { recursive: true });
  for (const file of files) write(directory, file.path, Buffer.from(file.content, 'base64'), file.mode === '100755' ? 0o755 : 0o644);
}
async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-candidate-fixture-'));
  try {
    const base = join(directory, 'base'); mkdirSync(base);
    git(base, ['init', '--initial-branch=main']);
    write(base, '.gitignore', 'node_modules/\napi/generated/\ntest-results/\nplaywright-report/\n');
    write(base, 'mise.toml', '[tasks.check]\nrun = "fixture command, not executed"\n');
    write(base, 'server/value.txt', 'before\n');
    write(base, 'server/untouched.txt', 'must remain unchanged\n');
    write(base, 'server/deleted.txt', 'removed by proposal\n');
    write(base, 'scripts/executable.sh', '#!/bin/sh\nexit 0\n', 0o755);
    git(base, ['add', '.']);
    git(base, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'test: create local fixture']);
    const sha = git(base, ['rev-parse', 'HEAD']);
    const proposal = { schema: 1, meta: { ...identity, pr: 42, sha, branch: 'codex/candidate-fixture', kind: 'fix' },
      summary: 'Fixture correction', tree: sha, edits: [
        { path: 'server/value.txt', beforeSha256: digest('before\n'), content: 'after\n' },
        { path: 'server/added.txt', beforeSha256: null, content: 'new file\n' },
        { path: 'server/deleted.txt', beforeSha256: digest('removed by proposal\n'), content: null },
      ] };
    const repository = join(directory, 'repository');
    const clone = (target) => {
      git(directory, ['clone', '--no-checkout', base, target]);
      git(target, ['remote', 'set-url', 'origin', `https://github.com/${REPOSITORY}.git`]);
    };
    Object.assign(proposal, reconstruct(proposal, repository, clone));
    const work = join(directory, 'work'); materialize(proposal.files, work);
    const runtime = join(directory, 'runtime');
    function checker(events, change = () => {}) {
      return (args) => {
        const command = args.at(-1);
        if (command === 'mise run check') events.push('check');
        else { events.push('generate'); write(work, 'api/generated/openapi.yaml', 'fixture generated API\n');
          write(work, 'api/generated/sdk/index.ts', 'export {};\n'); }
        change(command);
      };
    }
    function receipt(events = []) {
      return { ...checkCandidate({ proposal, work, runtime, mise: '/fixture/mise', execute: checker(events) }),
        proposalArtifactId: artifact.id, proposalArtifactDigest: artifact.digest };
    }
    function publisher(checked, events, options = {}) {
      return commitAndPush({ proposal, checked, work: repository,
        readCurrent: async (meta) => {
          events.push('read-current');
          assert.equal(meta.sha, options.actualHead ?? sha, 'Stale PR HEAD');
          return { body: options.body ?? '' };
        },
        readIssues: async (number) => { events.push(`issue:${number}`); return {
          number, url: `https://api.github.com/repos/${REPOSITORY}/issues/${number}`,
          html_url: `https://github.com/${REPOSITORY}/issues/${number}`,
          repository_url: `https://api.github.com/repos/${REPOSITORY}`,
        }; },
        remoteHead: async () => { events.push('remote-head'); return options.remoteHead ?? sha; },
        commit: async (message) => {
          events.push('commit');
          git(repository, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
            '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message]);
        },
        push: async () => { events.push('push'); }, // No external push in fixtures.
      });
    }
    await run({ directory, base, proposal, repository, work, runtime, checker, receipt, publisher, clone, sha });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a successful final candidate check precedes the real Git commit and simulated push', async () => {
  await fixture(async ({ proposal, repository, receipt, publisher, sha }) => {
    const events = [];
    const checked = receipt(events);
    verifyReceipt(proposal, checked, identity, artifact);
    await publisher(checked, events, { body: `<!-- opencode-linked-issues: ["https://github.com/${REPOSITORY}/issues/8"] -->` });
    assert.ok(events.indexOf('generate') < events.indexOf('check'));
    assert.ok(events.indexOf('check') < events.indexOf('commit'));
    assert.ok(events.indexOf('commit') < events.indexOf('push'));
    assert.equal(git(repository, ['rev-parse', 'HEAD^']), sha);
    assert.equal(git(repository, ['rev-parse', 'HEAD^{tree}']), checked.tree);
    assert.equal(git(repository, ['log', '-1', '--format=%B']), 'fix: address PR review feedback\n\nRefs #8');
    assert.ok(events.includes('issue:8'));
    assert.equal(checked.generated.length, 2);
    assert.equal(existsSync(join(repository, 'server/deleted.txt')), false);
    assert.equal(readFileSync(join(repository, 'server/untouched.txt'), 'utf8'), 'must remain unchanged\n');
    assert.equal(checked.files.find(({ path }) => path === 'scripts/executable.sh').mode, '100755');
  });
});

test('a failed mise run check prevents both commit and push and leaves original HEAD intact', async () => {
  await fixture(async ({ proposal, repository, work, runtime, checker, publisher, sha }) => {
    const events = [];
    await assert.rejects(async () => {
      const checked = checkCandidate({ proposal, work, runtime, mise: '/fixture/mise',
        execute: checker(events, (command) => { if (command === 'mise run check') throw new Error('fixture failing check'); }) });
      await publisher(checked, events);
    }, /fixture failing check/);
    assert.deepEqual(events, ['generate', 'check']);
    assert.equal(git(repository, ['rev-parse', 'HEAD']), sha);
  });
});

test('source or generated output mutation during installation/check cannot receive a PASS receipt', async () => {
  for (const stage of ['install-source', 'check-source', 'check-generated', 'check-untracked']) {
    await fixture(async ({ proposal, work, runtime, checker }) => {
      const events = [];
      assert.throws(() => checkCandidate({ proposal, work, runtime, mise: '/fixture/mise',
        execute: checker(events, (command) => {
          if (stage === 'install-source' && command !== 'mise run check') write(work, 'server/untouched.txt', 'substituted\n');
          if (stage === 'check-source' && command === 'mise run check') write(work, 'server/value.txt', 'substituted\n');
          if (stage === 'check-generated' && command === 'mise run check') write(work, 'api/generated/sdk/index.ts', 'substituted generated file\n');
          if (stage === 'check-untracked' && command === 'mise run check') write(work, 'hidden-by-gitignore.ts', 'unexpected source\n');
        }) }), /changed|differs/);
    });
  }
});

test('a generated directory symlink is rejected before host reads or publishes its target', async () => {
  await fixture(async ({ directory, proposal, work, runtime }) => {
    const outside = join(directory, 'outside'); mkdirSync(outside); write(outside, 'secret.txt', 'fixture secret');
    const events = [];
    assert.throws(() => checkCandidate({ proposal, work, runtime, mise: '/fixture/mise', execute() {
      events.push('generate'); mkdirSync(join(work, 'api'), { recursive: true }); symlinkSync(outside, join(work, 'api/generated'));
    } }), /Symlink|directory/);
    assert.deepEqual(events, ['generate']);
  });
});

test('tracked files hidden under runtime/generated exclusions cannot bypass complete candidate checking', async () => {
  for (const path of ['api/generated/tracked.ts', 'node_modules/tracked.ts']) {
    await fixture(({ directory, base, proposal, clone }) => {
      write(base, path, 'tracked data that must not be silently excluded\n');
      git(base, ['add', '-f', path]);
      git(base, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'test: track an excluded path']);
      const changed = structuredClone(proposal);
      changed.meta.sha = git(base, ['rev-parse', 'HEAD']);
      changed.tree = changed.meta.sha;
      assert.throws(() => reconstruct(changed, join(directory, 'excluded-runtime-repository'), clone), /Tracked runtime\/generated path/);
    });
  }
});

test('a full-tree substitution or stale PR/remote HEAD prevents commit and push', async () => {
  for (const scenario of ['source', 'mode', 'index', 'head', 'remote']) {
    await fixture(async ({ proposal, repository, receipt, publisher }) => {
      const checked = receipt();
      verifyReceipt(proposal, checked, identity, artifact);
      if (scenario === 'source') write(repository, 'server/untouched.txt', 'substituted unchanged file');
      if (scenario === 'mode') chmodSync(join(repository, 'scripts/executable.sh'), 0o644);
      if (scenario === 'index') {
        write(repository, 'server/untouched.txt', 'wrong staged content');
        git(repository, ['add', 'server/untouched.txt']);
        write(repository, 'server/untouched.txt', 'must remain unchanged\n');
      }
      const events = [];
      const options = scenario === 'head' ? { actualHead: 'b'.repeat(40) }
        : scenario === 'remote' ? { remoteHead: 'b'.repeat(40) } : {};
      await assert.rejects(publisher(checked, events, options), /Candidate|candidate|HEAD/);
      assert.equal(events.includes('commit'), false, scenario);
      assert.equal(events.includes('push'), false, scenario);
    });
  }
});

test('without explicit linked issues the correction commit has no fictitious Refs #4', async () => {
  await fixture(async ({ repository, receipt, publisher }) => {
    const events = [];
    await publisher(receipt(), events, { body: 'Context: #4 and https://github.com/other/repo/issues/9 are prose only.' });
    assert.equal(git(repository, ['log', '-1', '--format=%B']), 'fix: address PR review feedback');
    assert.equal(events.some((value) => value.startsWith('issue:')), false);
  });
});

test('receipts are bound to the immutable original proposal, full candidate, run and attempt', async () => {
  await fixture(({ proposal, receipt }) => {
    const checked = receipt();
    verifyReceipt(proposal, checked, identity, artifact);
    for (const mutate of [
      (value) => { value.checked.result = 'FAIL'; },
      (value) => { value.checked.command = 'echo pass'; },
      (value) => { value.checked.proposalArtifactId = '999'; },
      (value) => { value.checked.proposalArtifactDigest = 'e'.repeat(64); },
      (value) => { value.checked.files.find(({ path }) => path === 'server/untouched.txt').content = Buffer.from('substituted').toString('base64'); },
      (value) => { value.checked.tree = 'b'.repeat(40); },
      (value) => { value.checked.generated = []; },
      (value) => { value.checked.meta.sha = 'b'.repeat(40); },
      (value) => { value.checked.meta.attempt = 2; },
      (value) => { value.proposal.meta.runId = '701'; },
      (value) => { value.proposal.meta.workflowSha = 'b'.repeat(40); },
    ]) {
      // Separate immutable archives are parsed independently in the real flow.
      const value = { proposal: structuredClone(proposal), checked: structuredClone(checked) }; mutate(value);
      assert.throws(() => verifyReceipt(value.proposal, value.checked, identity, artifact));
    }
  });
});

test('artifact origin and digest are checked against GitHub metadata rather than an artifact claim', () => {
  const metadata = { id: 801, name: artifact.name, expired: false, digest: `sha256:${artifactDigest}`,
    workflow_run: { id: 700, head_sha: workflowSha } };
  verifyArtifactMetadata(metadata, artifact);
  for (const mutate of [
    (value) => { value.id = 999; }, (value) => { value.name = 'arbitrary-artifact'; },
    (value) => { value.expired = true; }, (value) => { value.digest = `sha256:${'e'.repeat(64)}`; },
    (value) => { value.workflow_run.id = 701; }, (value) => { value.workflow_run.head_sha = 'b'.repeat(40); },
  ]) {
    const value = structuredClone(metadata); mutate(value);
    assert.throws(() => verifyArtifactMetadata(value, artifact));
  }
});

test('only the expected successful workflow jobs and steps from the exact attempt are accepted', () => {
  const run = { id: 700, run_attempt: 1, path: WORKFLOW_PATH, head_sha: workflowSha,
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
    event: 'issue_comment', status: 'in_progress' };
  const step = (name) => ({ name, status: 'completed', conclusion: 'success' });
  const jobs = [
    { name: 'pr-fix', status: 'completed', conclusion: 'success', steps: [
      'Run isolated fresh session', 'Prepare correction proposal', 'Upload correction proposal',
    ].map(step) },
    { name: 'candidate-check', status: 'completed', conclusion: 'success', steps: [
      'Generate and check candidate in isolated containers', 'Upload checked candidate',
    ].map(step) },
  ];
  verifyJobs(run, jobs, identity);
  for (const mutate of [
    (value) => { value.run.path = '.github/workflows/arbitrary.yml'; },
    (value) => { value.run.run_attempt = 2; },
    (value) => { value.run.id = 701; },
    (value) => { value.run.repository.full_name = 'someone/fork'; },
    (value) => { value.run.head_repository.full_name = 'someone/fork'; },
    (value) => { value.run.head_sha = 'b'.repeat(40); },
    (value) => { value.jobs[1].name = 'check-lookalike'; },
    (value) => { value.jobs[1].conclusion = 'failure'; },
    (value) => { value.jobs[1].steps[0].conclusion = 'skipped'; },
    (value) => { value.jobs[1].steps.pop(); },
    (value) => { value.jobs.push(structuredClone(value.jobs[1])); },
  ]) {
    const value = structuredClone({ run, jobs }); mutate(value);
    assert.throws(() => verifyJobs(value.run, value.jobs, identity));
  }
});

test('candidate execution receives only explicit container data mounts and no credentials or runner access', () => {
  const args = isolatedArguments({ work: '/fixture/candidate-work', runtime: '/fixture/runtime', mise: '/fixture/mise', command: 'mise run check' });
  assert.ok(args.includes(CHECK_IMAGE));
  assert.match(CHECK_IMAGE, /@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('type=bind,src=/fixture/mise,dst=/usr/local/bin/mise,readonly'));
  assert.doesNotMatch(args.join('\n'), /OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|ACTIONS_ID_TOKEN|GITHUB_OUTPUT|docker\.sock|\/\.git|--privileged|--network[= ]host/);
  assert.equal(args.at(-1), 'mise run check');
});

test('trusted workflow keeps candidate checking separate and binds artifact IDs/digests through job outputs', () => {
  const workflow = load(readFileSync(WORKFLOW_PATH, 'utf8'));
  const producer = workflow.jobs['pr-fix'];
  const checker = workflow.jobs['candidate-check'];
  const publisher = workflow.jobs['publish-fix'];
  assert.equal(producer.permissions['id-token'], undefined);
  assert.deepEqual(checker.permissions, { contents: 'read', actions: 'read' });
  assert.equal(checker.needs, 'pr-fix');
  assert.deepEqual(publisher.needs, ['pr-fix', 'candidate-check']);
  assert.equal(publisher.permissions['id-token'], 'write');
  assert.equal(publisher.permissions.contents, 'read');
  for (const job of [producer, checker, publisher]) {
    const checkout = job.steps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
    assert.deepEqual(checkout.with, { ref: '${{ github.workflow_sha }}', 'persist-credentials': false });
  }
  assert.equal(producer.outputs['proposal-id'], '${{ steps.proposal.outputs.artifact-id }}');
  assert.equal(producer.outputs['proposal-digest'], '${{ steps.proposal.outputs.artifact-digest }}');
  const check = checker.steps.find(({ name }) => name === 'Generate and check candidate in isolated containers');
  assert.equal(check.env.PROPOSAL_ID, '${{ needs.pr-fix.outputs.proposal-id }}');
  assert.equal(check.env.PROPOSAL_DIGEST, '${{ needs.pr-fix.outputs.proposal-digest }}');
  assert.equal(checker.outputs['checked-id'], '${{ steps.checked.outputs.artifact-id }}');
  assert.equal(checker.outputs['checked-digest'], '${{ steps.checked.outputs.artifact-digest }}');
  assert.equal(publisher.env.PROPOSAL_ID, '${{ needs.pr-fix.outputs.proposal-id }}');
  assert.equal(publisher.env.PROPOSAL_DIGEST, '${{ needs.pr-fix.outputs.proposal-digest }}');
  assert.equal(publisher.env.CHECKED_ID, '${{ needs.candidate-check.outputs.checked-id }}');
  assert.equal(publisher.env.CHECKED_DIGEST, '${{ needs.candidate-check.outputs.checked-digest }}');
  for (const job of [checker, publisher]) assert.doesNotMatch(JSON.stringify(job), /OPENAI_API_KEY|secrets\./);
  assert.doesNotMatch(JSON.stringify(checker), /id-token|opencode-app-token|candidate\.mjs publish/);
  const verify = publisher.steps.findIndex(({ name }) => name === 'Verify successful check and complete candidate provenance');
  const app = publisher.steps.findIndex(({ name }) => name === 'Exchange App OIDC without a model');
  const publish = publisher.steps.findIndex(({ name }) => name === 'Commit verified candidate and push to the original PR branch');
  assert.ok(verify >= 0 && verify < app && app < publish);
  assert.doesNotMatch(JSON.stringify(publisher), /npm ci|mise run check|generate:openapi|docker run/);
});
