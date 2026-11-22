import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { assertPullRequest, classifyEvent, REPOSITORY, REVIEW_EVENTS } from './opencode-pr-policy.mjs';
import { applyEdit, buildPrompt, sessionEnvironment, validateEdit } from './opencode-pr.mjs';

// Every event, REST response and CLI below is a fixture. No test contacts GitHub
// or an AI provider; the executable stand-in records input and returns JSONL.
const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const branch = 'codex/existing-pr';
const human = { login: 'shinovnikita', type: 'User' };
const pr = () => ({
  number: 42, state: 'open', draft: false,
  base: { ref: 'main', repo: { full_name: REPOSITORY } },
  head: { ref: branch, sha, repo: { full_name: REPOSITORY } },
});
const event = (name = 'issue_comment', body = '/oc fix the confirmed finding') => ({
  action: 'created', repository: { full_name: REPOSITORY },
  comment: { body, user: human },
  ...(name === 'issue_comment' ? { issue: { number: 42, pull_request: {}, labels: [{ name: 'ready-for-agent' }] } }
    : { pull_request: pr() }),
});
const review = load(readFileSync('.github/workflows/opencode-review.yml', 'utf8'));
const manual = load(readFileSync('.github/workflows/opencode.yml', 'utf8'));
const reviewRequest = load(readFileSync('.github/workflows/opencode-review-request.yml', 'utf8'));
const inlineRequest = load(readFileSync('.github/workflows/opencode-inline-request.yml', 'utf8'));

test('both PR comment surfaces accept trusted explicit commands independent of ready labels', () => {
  for (const name of ['issue_comment', 'pull_request_review_comment']) {
    for (const body of ['/oc fix', 'Please\n/OPENCODE fix', '/Oc']) {
      assert.deepEqual(classifyEvent(event(name, body), name), { allowed: true, kind: 'fix', pr: 42 });
    }
    for (const body of ['/octopus fix', '/oc-extra fix', 'https://host/oc', '/opencode!', 'no command']) {
      assert.equal(classifyEvent(event(name, body), name).allowed, false, `${name}: ${body}`);
    }
    for (const user of [{ login: 'shinovnikita', type: 'Bot' }, { login: 'opencode-agent[bot]', type: 'Bot' },
      { login: 'someone-else', type: 'User' }]) {
      const input = event(name);
      input.comment.user = user;
      assert.equal(classifyEvent(input, name).allowed, false);
    }
    const edited = event(name); edited.action = 'edited';
    assert.equal(classifyEvent(edited, name).allowed, false);
    const foreign = event(name); foreign.repository.full_name = 'someone/fork';
    assert.equal(classifyEvent(foreign, name).allowed, false);
  }
  const issue = event(); delete issue.issue.pull_request;
  assert.equal(classifyEvent(issue, 'issue_comment').kind, 'issue');
});

test('automatic review starts only for its explicit lifecycle events and ready PRs', () => {
  for (const action of REVIEW_EVENTS) {
    const input = { repository: { full_name: REPOSITORY }, action, pull_request: pr() };
    assert.deepEqual(classifyEvent(input, 'pull_request'), { allowed: true, kind: 'review', pr: 42 });
    input.pull_request.draft = true;
    assert.equal(classifyEvent(input, 'pull_request').allowed, false);
  }
  assert.equal(classifyEvent({ repository: { full_name: REPOSITORY }, action: 'closed', pull_request: pr() }, 'pull_request').allowed, false);
});

test('live PR policy rejects forks, main, protected work branches, wrong repo and changed HEAD', () => {
  assert.equal(assertPullRequest(pr(), { sha, branch }).number, 42);
  for (const modify of [
    (value) => { value.head.repo.full_name = 'someone/fork'; },
    (value) => { value.base.repo.full_name = 'someone/other'; },
    (value) => { value.base.ref = 'develop'; },
    (value) => { value.state = 'closed'; },
    ...['main', 'opencode-budget', 'release-please--branches--main'].map((ref) =>
      (value) => { value.head.ref = ref; }),
    (value) => { value.head.sha = 'shortsha'; },
  ]) {
    const value = pr(); modify(value);
    assert.throws(() => assertPullRequest(value), /PR must be/);
  }
  assert.throws(() => assertPullRequest(pr(), { sha: newer }), /Stale PR HEAD/);
  assert.throws(() => assertPullRequest(pr(), { branch: 'codex/different-pr' }), /PR branch changed/);
});

test('actual prepare command leaves allowed=false for a fork and records current PR head for inline fixes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-prepare-fixture-'));
  try {
    const loader = join(directory, 'rest-fixture.mjs');
    writeFileSync(loader, `import { readFileSync } from 'node:fs';\nglobalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(readFileSync(process.env.FIXTURE_PR, 'utf8')) });\n`);
    const eventPath = join(directory, 'event.json');
    const responsePath = join(directory, 'pr.json');
    const output = join(directory, 'output');
    writeFileSync(eventPath, JSON.stringify(event('pull_request_review_comment')));
    function prepare(value) {
      writeFileSync(output, ''); writeFileSync(responsePath, JSON.stringify(value));
      return spawnSync(process.execPath, ['--import', loader, 'scripts/opencode-pr.mjs', 'prepare'], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'pull_request_review_comment', GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: output, FIXTURE_PR: responsePath, GH_TOKEN: 'fixture-no-real-token' }, encoding: 'utf8',
      });
    }
    const fork = pr(); fork.head.repo.full_name = 'someone/fork';
    assert.equal(prepare(fork).status, 1);
    assert.equal(readFileSync(output, 'utf8'), 'allowed=false\n');
    const latest = pr(); latest.head.sha = newer;
    assert.equal(prepare(latest).status, 0);
    assert.equal(readFileSync(output, 'utf8'), `allowed=false\nallowed=true\npr=42\nsha=${newer}\nbranch=${branch}\nkind=fix\n`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the review prompt transmits trusted REVIEW.md, exact SHA and evidence without implementation authority', () => {
  const checklist = readFileSync('REVIEW.md', 'utf8');
  const context = { pr: pr(), checks: [{ head_sha: sha, name: 'check', conclusion: 'success' }],
    approval: 'https://github.com/shinovnikita/ai-for-developers-project-387/issues/4#issuecomment-7083268893',
    issues: [{ number: 7 }, { number: 8 }, { number: 9 }], diff: '+ fixture only' };
  const prompt = buildPrompt({ kind: 'review', meta: { pr: 42, sha, branch }, review: checklist, context });
  assert.ok(prompt.includes(`REVIEW.md (trusted main):\n${checklist}`));
  assert.ok(prompt.includes(`full checked head SHA: ${sha}`));
  assert.ok(prompt.includes(JSON.stringify(context)));
  assert.match(prompt, /inaccessible\s+links, missing evidence and scope outside approval/);
  assert.match(prompt, /confirmed actionable findings only/);
  assert.match(prompt, /Do not edit files or decide whether to merge/);
  assert.match(prompt, /Never run implement-spec/);
});

test('model environment strips GitHub/OIDC credentials, inherited config and executable hooks', () => {
  const base = { PATH: '/fixture/bin', HOME: '/real/home', GH_TOKEN: 'private', GITHUB_TOKEN: 'private',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private', ACTIONS_ID_TOKEN_REQUEST_URL: 'private', NODE_OPTIONS: '--import evil',
    OPENCODE_CONFIG_CONTENT: 'malicious', OPENCODE_CONFIG_DIR: '/repo/.opencode', OPENAI_API_KEY: 'fixture-key' };
  const env = sessionEnvironment(base, '/isolated', { permission: { '*': 'deny' } });
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'NODE_OPTIONS']) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.HOME, '/isolated/home');
  assert.equal(env.OPENCODE_CONFIG_DIR, '/isolated/config');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, 'true');
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, 'true');
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, 'true');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission, { '*': 'deny' });
});

test('actual model orchestration uses a fresh isolated CLI, stdin prompt and JSONL (harmless stand-in, no model)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-session-fixture-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const session = join(directory, 'session'); mkdirSync(session);
    const calls = join(directory, 'calls.json');
    const prompt = buildPrompt({ kind: 'review', meta: { pr: 42, sha, branch },
      review: readFileSync('REVIEW.md', 'utf8'), context: { checks: [{ head_sha: sha }] } });
    writeFileSync(join(session, 'prompt.txt'), prompt);
    writeFileSync(join(session, 'meta.json'), JSON.stringify({ pr: 42, sha, branch, kind: 'review' }));
    writeFileSync(join(bin, 'opencode'), `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';
if(process.argv[2]==='--version'){console.log('1.19.6');process.exit(0);}
writeFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd(),input:readFileSync(0,'utf8')}));
console.log(JSON.stringify({type:'step_start',part:{type:'step-start'}}));
console.log(JSON.stringify({type:'text',part:{text:'Fixture review, no provider invoked'}}));\n`, { mode: 0o755 });
    const model = review.jobs.review.steps.find(({ name }) => name === 'Run isolated fresh session');
    const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', model.run], {
      env: { PATH: `${bin}:${process.env.PATH}`, SESSION_DIR: session, GH_TOKEN: 'fixture-should-be-stripped',
        OPENAI_API_KEY: 'fixture-key-no-model', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-should-be-stripped' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const call = JSON.parse(readFileSync(calls, 'utf8'));
    assert.deepEqual(call.args, ['run', '--format', 'json', '--model', 'openai/gpt-6.1-sol',
      '--variant', 'medium', '--agent', 'pr', '--title', `PR 42 review ${sha}`]);
    assert.equal(call.input, prompt);
    assert.equal(call.cwd, realpathSync(join(session, 'work')));
    assert.equal(call.env.GH_TOKEN, undefined);
    assert.equal(call.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
    const config = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.permission, { '*': 'deny' });
    assert.deepEqual(config.agent.pr.permission, { '*': 'deny' });
    assert.deepEqual(config.plugin, []); assert.deepEqual(config.mcp, {});
    assert.equal(config.snapshot, false);
    assert.equal(config.agent.title.disable, true);
    assert.equal(readFileSync(join(session, 'answer.txt'), 'utf8'), 'Fixture review, no provider invoked');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unsafe edit aliases, traversal, workflow files and generated files are rejected before writing', () => {
  for (const path of ['../outside', '/absolute', '.git/config', './.github/workflows/pwn.yml', '.github/workflows/pwn.yml',
    'api//generated/sdk/pwn.ts', './api/generated/sdk/pwn.ts', 'api/generated', 'api/generated/sdk/pwn.ts',
    'file;echo-pwn', 'a/../../outside', 'a//file', '.', '.github']) {
    assert.throws(() => validateEdit({ path, beforeSha256: null, content: 'fixture' }), /Unsafe/, path);
  }
  assert.doesNotThrow(() => validateEdit({ path: 'server/new-file.ts', beforeSha256: null, content: 'fixture' }));
});

test('actual edit application checks source hashes and rejects existing and dangling symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-apply-fixture-'));
  try {
    const work = join(directory, 'checkout'); mkdirSync(work);
    const path = 'server/fixture.ts';
    applyEdit(work, { path, beforeSha256: null, content: 'before' });
    assert.equal(readFileSync(join(work, path), 'utf8'), 'before');
    assert.throws(() => applyEdit(work, { path, beforeSha256: '0'.repeat(64), content: 'bad' }), /Source hash changed/);
    assert.equal(readFileSync(join(work, path), 'utf8'), 'before');
    const beforeSha256 = createHash('sha256').update('before').digest('hex');
    applyEdit(work, { path, beforeSha256, content: 'after' });
    assert.equal(readFileSync(join(work, path), 'utf8'), 'after');
    const target = join(directory, 'outside.txt');
    symlinkSync(target, join(work, 'dangling.txt'));
    assert.throws(() => applyEdit(work, { path: 'dangling.txt', beforeSha256: null, content: 'escape' }), /Symlink/);
    assert.equal(existsSync(target), false);
    symlinkSync(directory, join(work, 'parent-link'));
    assert.throws(() => applyEdit(work, { path: 'parent-link/outside.txt', beforeSha256: null, content: 'escape' }), /Symlink/);
    assert.equal(existsSync(target), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workflow budget gate precedes setup/model, and only the permitted model step has its key', () => {
  assert.deepEqual(review.permissions, {});
  assert.deepEqual(review.on.workflow_run, { workflows: ['Independent PR review request'], types: ['completed'] });
  assert.equal(review.on.pull_request, undefined);
  assert.deepEqual(reviewRequest.on.pull_request.types, REVIEW_EVENTS);
  assert.equal(review.concurrency['cancel-in-progress'], true);
  assert.notEqual(review.concurrency.group, manual.jobs['pr-fix'].concurrency.group);
  assert.equal(manual.jobs['pr-fix'].concurrency['cancel-in-progress'], false);
  assert.match(review.jobs.review.if, /head_repository\.full_name == github\.repository/);
  assert.deepEqual(manual.on.issue_comment.types, ['created']);
  assert.deepEqual(manual.on.workflow_run, { workflows: ['OpenCode inline request'], types: ['completed'] });
  assert.equal(manual.on.pull_request_review_comment, undefined);
  assert.match(manual.jobs['pr-fix'].if, /workflow_run\.actor\.login == 'shinovnikita'/);
  assert.match(manual.jobs['pr-fix'].if, /workflow_run\.actor\.type == 'User'/);
  assert.equal(manual.jobs['pr-fix'].steps.find(({ name }) => name === 'Collect data without executing PR code').env.COMMENT_ID,
    '${{ steps.context.outputs.commentId }}');
  for (const job of [review.jobs.review, manual.jobs['pr-fix']]) {
    const steps = job.steps;
    const model = steps.find(({ name }) => name === 'Run isolated fresh session');
    const budget = steps.find(({ id }) => id === 'budget');
    const context = steps.find(({ id }) => id === 'context');
    assert.equal(model.if, "steps.budget.outputs.allowed == 'true'");
    assert.equal(budget.if, "steps.context.outputs.allowed == 'true'");
    assert.ok(steps.indexOf(context) < steps.indexOf(budget));
    assert.ok(steps.indexOf(budget) < steps.indexOf(steps.find(({ name }) => name === 'Install pinned OpenCode')));
    assert.ok(steps.indexOf(budget) < steps.indexOf(model));
    assert.equal(budget.env.OPENAI_API_KEY, undefined);
    assert.equal(context.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(steps.filter((step) => JSON.stringify(step).includes('secrets.OPENAI_API_KEY')), [model]);
    assert.equal(model.env.OPENAI_API_KEY, '${{ secrets.OPENAI_API_KEY }}');
    assert.equal(model.env.GH_TOKEN, undefined);
    const checkout = steps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
    assert.deepEqual(checkout.with, { ref: job === manual.jobs['pr-fix'] ? '${{ github.workflow_sha }}' : 'refs/heads/main', 'persist-credentials': false });
    assert.doesNotMatch(JSON.stringify(job), /ready-for-agent|ready-for-human/);
  }
});

test('PR request workflows only signal untrusted data without checkout, model, OIDC or write rights', () => {
  for (const request of [reviewRequest, inlineRequest]) {
    assert.deepEqual(request.permissions, { contents: 'read' });
    assert.doesNotMatch(JSON.stringify(request), /secrets\.|OPENAI_API_KEY|id-token|pull_request_target/);
    assert.equal(Object.keys(request.jobs).length, 1);
    for (const step of request.jobs.request.steps) {
      assert.doesNotMatch(step.uses ?? '', /checkout|setup|mise/);
      assert.doesNotMatch(step.run ?? '', /npm |opencode |git /);
      assert.doesNotMatch(step.run ?? '', /\$\{\{/);
    }
  }
  assert.deepEqual(inlineRequest.on.pull_request_review_comment.types, ['created']);
  const upload = inlineRequest.jobs.request.steps.find(({ uses }) => uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, "steps.command.outputs.allowed == 'true'");
  assert.equal(upload.with.name, 'inline-command-${{ github.run_id }}-${{ github.run_attempt }}');
});

test('actual inline request filter emits identifiers only and rejects bots, forks and noncommands without a model', () => {
  const filter = inlineRequest.jobs.request.steps.find(({ id }) => id === 'command');
  for (const fixture of [
    { name: 'trusted', allowed: true },
    { name: 'trusted untrusted body remains data', body: '/oc $(exit 98) `exit 97`\nNODE\nexit 96', allowed: true },
    { name: 'bot', user: { login: 'shinovnikita', type: 'Bot' }, allowed: false },
    { name: 'untrusted', user: { login: 'someone', type: 'User' }, allowed: false },
    { name: 'fork', fork: true, allowed: false },
    { name: 'no command', body: '/octopus', allowed: false },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'inline-signal-fixture-'));
    try {
      const input = event('pull_request_review_comment', fixture.body); input.comment.id = 501;
      if (fixture.user) input.comment.user = fixture.user;
      if (fixture.fork) input.pull_request.head.repo.full_name = 'someone/fork';
      const eventPath = join(directory, 'event.json'); const output = join(directory, 'output');
      writeFileSync(eventPath, JSON.stringify(input)); writeFileSync(output, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', filter.run], {
        cwd: directory, env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: '800', GITHUB_RUN_ATTEMPT: '1' }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);
      assert.equal(readFileSync(output, 'utf8'), `allowed=${fixture.allowed}\n`);
      const requestPath = join(directory, 'request/inline.json');
      if (fixture.allowed) {
        assert.deepEqual(JSON.parse(readFileSync(requestPath, 'utf8')), { commentId: 501, pr: 42, runId: '800', attempt: '1' });
      } else assert.equal(existsSync(requestPath), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

function forwardedFixture(kind, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'forwarded-prepare-fixture-'));
  try {
    const loader = join(directory, 'rest-fixture.mjs');
    writeFileSync(loader, `import { readFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  if(url.endsWith('/actions/artifacts/900/zip'))return {ok:true,arrayBuffer:async()=>new Uint8Array(readFileSync(process.env.FIXTURE_ZIP)).buffer};
  const data=JSON.parse(readFileSync(process.env.FIXTURE_REST,'utf8'));
  const path=url.split('/repos/${REPOSITORY}/')[1];
  if(!(path in data))throw Error('Unexpected fixture URL: '+path);
  return {ok:true,json:async()=>data[path]};
};\n`);
    const run = { id: 800, run_attempt: 1, conclusion: 'success', head_sha: sha,
      created_at: '2026-11-22T18:00:00Z', repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY }, pull_requests: [{ number: 42 }], actor: human,
      path: `.github/workflows/opencode-${kind === 'review' ? 'review' : 'inline'}-request.yml`,
      event: kind === 'review' ? 'pull_request' : 'pull_request_review_comment' };
    const input = { action: 'completed', repository: { full_name: REPOSITORY }, workflow_run: { id: 800, run_attempt: 1 } };
    const request = { commentId: 501, pr: 42, runId: '800', attempt: '1' };
    const comment = { id: 501, user: human, body: '/oc fix the confirmed finding',
      pull_request_url: `https://api.github.com/repos/${REPOSITORY}/pulls/42`, created_at: run.created_at };
    const artifact = { id: 900, name: 'inline-command-800-1', expired: false, size_in_bytes: 512 };
    const source = { run, input, request, comment, artifact, pr: pr(), zipMember: 'inline.json' };
    function prepare(fixture = source) {
      const eventPath = join(directory, 'event.json'); const restPath = join(directory, 'rest.json');
      const zipPath = join(directory, 'request.zip'); const output = join(directory, 'output');
      writeFileSync(eventPath, JSON.stringify(fixture.input)); writeFileSync(output, '');
      writeFileSync(restPath, JSON.stringify({ 'actions/runs/800': fixture.run,
        'actions/runs/800/artifacts?name=inline-command-800-1': { artifacts: [fixture.artifact] },
        'pulls/comments/501': fixture.comment, 'pulls/42': fixture.pr }));
      const zip = spawnSync('python3', ['-c', 'import io,json,sys,zipfile\nb=io.BytesIO()\nz=zipfile.ZipFile(b,"w")\nv=json.load(sys.stdin)\nz.writestr(v["name"],json.dumps(v["request"]))\nz.close()\nsys.stdout.buffer.write(b.getvalue())'],
        { input: JSON.stringify({ name: fixture.zipMember, request: fixture.request }) });
      assert.equal(zip.status, 0, zip.stderr.toString()); writeFileSync(zipPath, zip.stdout);
      const result = spawnSync(process.execPath, ['--import', loader, 'scripts/opencode-pr.mjs', 'prepare'], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: output, FIXTURE_REST: restPath, FIXTURE_ZIP: zipPath, GH_TOKEN: 'fixture-no-real-token' }, encoding: 'utf8',
      });
      return { ...result, output: readFileSync(output, 'utf8') };
    }
    callback(source, prepare);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('actual forwarded review preflight validates source run and rejects stale, fork or replayed metadata', () => {
  forwardedFixture('review', (source, prepare) => {
    const accepted = prepare(); assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.output, `allowed=false\nallowed=true\npr=42\nsha=${sha}\nbranch=${branch}\nkind=review\n`);
    for (const modify of [
      (value) => { value.pr.head.sha = newer; },
      (value) => { value.run.head_repository.full_name = 'someone/fork'; },
      (value) => { value.run.path = '.github/workflows/unknown.yml'; },
      (value) => { value.run.event = 'issue_comment'; },
      (value) => { value.input.workflow_run.run_attempt = 2; },
    ]) {
      const fixture = structuredClone(source); modify(fixture);
      const rejected = prepare(fixture);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.output, 'allowed=false\n');
    }
  });
});

test('actual forwarded Release Please PR is eligible for independent review but not inline correction', () => {
  forwardedFixture('review', (source, prepare) => {
    source.pr.head.ref = 'release-please--branches--main--components--call-calendar';
    const accepted = prepare();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.output, `allowed=false\nallowed=true\npr=42\nsha=${sha}\nbranch=${source.pr.head.ref}\nkind=review\n`);
  });
  forwardedFixture('fix', (source, prepare) => {
    source.pr.head.ref = 'release-please--branches--main--components--call-calendar';
    const rejected = prepare();
    assert.equal(rejected.status, 1);
    assert.equal(rejected.output, 'allowed=false\n');
  });
});

test('release review wait and publication preserve review policy and the exact checked head SHA', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-review-fixture-'));
  try {
    const loader = join(directory, 'rest-fixture.mjs');
    const responsePath = join(directory, 'pr.json');
    const publication = join(directory, 'review.json');
    writeFileSync(loader, `import {readFileSync,writeFileSync} from 'node:fs';
globalThis.fetch=async(url,options={})=>{
 if(url.endsWith('/pulls/42'))return {ok:true,json:async()=>JSON.parse(readFileSync(process.env.FIXTURE_PR,'utf8'))};
 if(url.includes('/check-runs?'))return {ok:true,json:async()=>({check_runs:[{name:'check',status:'completed'},{name:'browser-evidence',status:'completed'}]})};
 if(url.endsWith('/pulls/42/reviews')&&options.method==='POST'){writeFileSync(process.env.FIXTURE_PUBLICATION,options.body);return {ok:true,json:async()=>({id:1})};}
 throw Error('Unexpected fixture URL: '+url);
};\n`);
    const release = pr(); release.head.ref = 'release-please--branches--main--components--call-calendar';
    writeFileSync(responsePath, JSON.stringify(release));
    const waitStep = review.jobs.review.steps.find(({ name }) => name === 'Wait for CI of this head SHA');
    assert.equal(waitStep.env.SESSION_KIND, 'review');
    const env = { PATH: process.env.PATH, GH_TOKEN: 'fixture-no-real-token', PR_NUMBER: '42', HEAD_SHA: sha,
      HEAD_BRANCH: release.head.ref, SESSION_KIND: waitStep.env.SESSION_KIND, SESSION_DIR: directory,
      FIXTURE_PR: responsePath, FIXTURE_PUBLICATION: publication,
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '700' };
    const waited = spawnSync(process.execPath, ['--import', loader, 'scripts/opencode-pr.mjs', 'wait'], { env, encoding: 'utf8' });
    assert.equal(waited.status, 0, waited.stderr);
    writeFileSync(join(directory, 'meta.json'), JSON.stringify({ pr: 42, sha, branch: release.head.ref, kind: 'review' }));
    writeFileSync(join(directory, 'answer.txt'), 'Fixture independent read-only review; no model invoked.');
    const published = spawnSync(process.execPath, ['--import', loader, 'scripts/opencode-pr.mjs', 'publish'], { env, encoding: 'utf8' });
    assert.equal(published.status, 0, published.stderr);
    const result = JSON.parse(readFileSync(publication, 'utf8'));
    assert.equal(result.event, 'COMMENT'); assert.equal(result.commit_id, sha);
    assert.ok(result.body.includes(`checked head SHA: ${sha}`));
    rmSync(publication);
    release.head.sha = newer; writeFileSync(responsePath, JSON.stringify(release));
    const stale = spawnSync(process.execPath, ['--import', loader, 'scripts/opencode-pr.mjs', 'publish'], { env, encoding: 'utf8' });
    assert.equal(stale.status, 1);
    assert.equal(existsSync(publication), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual inline forwarding verifies bounded ZIP identifiers against live REST comment and current PR', () => {
  forwardedFixture('fix', (source, prepare) => {
    source.pr.head.sha = newer;
    const accepted = prepare(); assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.output, `allowed=false\nallowed=true\npr=42\nsha=${newer}\nbranch=${branch}\nkind=fix\ncommentId=501\n`);
    for (const modify of [
      (value) => { value.comment.user = { login: 'shinovnikita', type: 'Bot' }; },
      (value) => { value.comment.user = { login: 'someone', type: 'User' }; },
      (value) => { value.comment.body = '/octopus'; },
    ]) {
      const fixture = structuredClone(source); modify(fixture);
      const rejected = prepare(fixture);
      assert.equal(rejected.status, 0, rejected.stderr);
      assert.equal(rejected.output, 'allowed=false\n');
    }
    for (const modify of [
      (value) => { value.run.actor = { login: 'someone', type: 'User' }; },
      (value) => { value.run.actor = { login: 'shinovnikita', type: 'Bot' }; },
      (value) => { value.request.pr = 43; },
      (value) => { value.request.runId = '799'; },
      (value) => { value.request.attempt = '2'; },
      (value) => { value.comment.pull_request_url = `https://api.github.com/repos/${REPOSITORY}/pulls/43`; },
      (value) => { value.comment.created_at = '2026-11-21T18:00:00Z'; },
      (value) => { value.artifact.expired = true; },
      (value) => { value.zipMember = '../inline.json'; },
    ]) {
      const fixture = structuredClone(source); modify(fixture);
      const rejected = prepare(fixture);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(rejected.output, 'allowed=false\n');
    }
  });
});

test('publication is tied to reviewed SHA and explicit non-force destination with hooks disabled', () => {
  const source = readFileSync('scripts/opencode-pr.mjs', 'utf8');
  const publisher = readFileSync('scripts/opencode-candidate.mjs', 'utf8');
  assert.match(source, /commit_id: meta\.sha/);
  assert.match(source, /Independent AI review — checked head SHA: \$\{meta\.sha\}/);
  assert.match(publisher, /git\(\['branch', '--show-current'\], work\)\.trim\(\) === proposal\.meta\.branch/);
  assert.match(publisher, /git\(\['rev-parse', 'HEAD\^'\], work\)\.trim\(\) === proposal\.meta\.sha/);
  assert.match(publisher, /authenticatedGit\(\['ls-remote', 'origin', `refs\/heads\/\$\{proposal\.meta\.branch\}`\]/);
  assert.match(publisher, /authenticatedGit\(\['push', 'origin', `HEAD:refs\/heads\/\$\{proposal\.meta\.branch\}`\]/);
  assert.doesNotMatch(publisher, /['"]--force(?:-with-lease)?['"]/);
  assert.match(publisher, /core\.hooksPath=\/dev\/null/);
  assert.match(publisher, /git\(\['add', '--',/);
});
