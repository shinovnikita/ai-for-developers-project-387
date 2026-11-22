import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api, applyEdit, current, git } from './opencode-pr.mjs';
import { REPOSITORY, SHA } from './opencode-pr-policy.mjs';
import { correctionCommitMessage, resolveLinkedIssues } from './opencode-linked-issues.mjs';

export const CHECK_IMAGE = 'mcr.microsoft.com/playwright@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579'; // v1.65.1-noble
export const WORKFLOW_PATH = '.github/workflows/opencode.yml';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b, message) => assert.deepEqual(a, b, message);
const runtimePaths = ['.git', 'node_modules', 'api/generated', 'frontend/dist', 'test-results', 'playwright-report', 'browser-evidence'];
const runtimePath = (path) => runtimePaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

// Fixed host policy, never candidate .gitignore. Special files and symlinks fail
// closed. The container has no .git mount and cannot write the trusted harness.
export function snapshot(directory, excludeRuntime = false) {
  const root = lstatSync(directory);
  assert(root.isDirectory() && !root.isSymbolicLink(), 'Candidate snapshot root must be a real directory');
  const files = [];
  function visit(relative = '') {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (excludeRuntime && runtimePath(path)) continue;
      const stat = lstatSync(join(directory, path));
      assert(!stat.isSymbolicLink(), `Symlink in candidate: ${path}`);
      if (stat.isDirectory()) visit(path);
      else {
        assert(stat.isFile(), `Special file in candidate: ${path}`);
        files.push({ path, mode: stat.mode & 0o111 ? '100755' : '100644',
          content: readFileSync(join(directory, path)).toString('base64') });
      }
    }
  }
  visit();
  assert(Buffer.byteLength(JSON.stringify(files)) <= 16 * 1024 * 1024, 'Candidate snapshot too large');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function exportFiles(files, directory) {
  mkdirSync(directory, { recursive: true });
  for (const file of files) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.content, 'base64'), { mode: file.mode === '100755' ? 0o755 : 0o644 });
  }
}
function validateMeta(meta) {
  assert(meta?.kind === 'fix' && Number.isSafeInteger(meta.pr) && meta.pr > 0
    && SHA.test(meta.sha) && SHA.test(meta.workflowSha) && meta.repository === REPOSITORY
    && /^[1-9][0-9]*$/.test(meta.runId) && Number.isSafeInteger(meta.attempt) && meta.attempt > 0,
  'Invalid correction provenance');
}
function runIdentity() {
  return { repository: REPOSITORY, workflowSha: process.env.TRUSTED_SHA,
    runId: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
}
function validateProposal(proposal) {
  validateMeta(proposal.meta);
  assert(proposal.schema === 1 && SHA.test(proposal.tree) && typeof proposal.summary === 'string'
    && Array.isArray(proposal.edits) && proposal.edits.length <= 50, 'Invalid proposal');
  for (const edit of proposal.edits) assert(!runtimePath(edit.path), 'Cannot edit runtime/generated directories');
}
export function reconstruct(proposal, directory, clone = (target) =>
  git(['clone', '--no-checkout', `https://github.com/${REPOSITORY}.git`, target])) {
  validateProposal(proposal);
  clone(directory);
  git(['-c', 'core.hooksPath=/dev/null', 'checkout', '-b', proposal.meta.branch, proposal.meta.sha], directory);
  for (const edit of proposal.edits) applyEdit(directory, edit);
  if (proposal.edits.length) git(['add', '--', ...proposal.edits.map(({ path }) => path)], directory);
  for (const path of git(['ls-files', '-z'], directory).split('\0').filter(Boolean)) {
    assert(!runtimePath(path), `Tracked runtime/generated path is outside the checked source contract: ${path}`);
  }
  return { tree: git(['write-tree'], directory).trim(), files: snapshot(directory, true) };
}

export function isolatedArguments({ work, runtime, mise, command }) {
  return ['run', '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--shm-size=1g', '--pids-limit=512',
    '--user', `${process.getuid()}:${process.getgid()}`, '--workdir', '/work',
    '--mount', `type=bind,src=${resolve(work)},dst=/work`,
    '--mount', `type=bind,src=${resolve(runtime)},dst=/runtime`,
    '--mount', `type=bind,src=${resolve(mise)},dst=/usr/local/bin/mise,readonly`,
    '--env', 'HOME=/runtime/home', '--env', 'MISE_DATA_DIR=/runtime/mise',
    '--env', 'MISE_CONFIG_DIR=/runtime/config', '--env', 'MISE_CACHE_DIR=/runtime/cache',
    '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright', '--env', 'CI=true', '--env', 'MISE_YES=1',
    CHECK_IMAGE, 'bash', '-euo', 'pipefail', '-c', command];
}
export function checkCandidate({ proposal, work, runtime, mise, execute }) {
  validateProposal(proposal);
  same(snapshot(work, true), proposal.files, 'Initial candidate differs from original proposal');
  mkdirSync(runtime, { recursive: true });
  execute(isolatedArguments({ work, runtime, mise, command:
    'mkdir -p "$HOME"; mise trust /work/mise.toml; mise install; mise exec -- npm ci; mise exec -- npm run generate:openapi; mise exec -- npm run generate:sdk' }));
  same(snapshot(work, true), proposal.files, 'Installation/generation changed source candidate');
  const generated = snapshot(join(work, 'api/generated'));
  assert(generated.length, 'Generation produced no API/SDK files');
  // Both containers terminate before host snapshots. No background candidate
  // process can mutate the frozen data or host GITHUB_OUTPUT after this point.
  execute(isolatedArguments({ work, runtime, mise, command: 'mise run check' }));
  const files = snapshot(work, true);
  same(files, proposal.files, 'mise run check changed the final source candidate');
  same(snapshot(join(work, 'api/generated')), generated, 'mise run check changed frozen generated API/SDK');
  return { schema: 1, meta: proposal.meta, tree: proposal.tree, files, generated, command: 'mise run check', result: 'PASS' };
}

export function verifyArtifactMetadata(artifact, expected) {
  assert(Number(artifact.id) === Number(expected.id) && artifact.name === expected.name && !artifact.expired
    && artifact.workflow_run?.id === Number(expected.runId)
    && artifact.workflow_run.head_sha === expected.workflowSha,
  'Artifact origin mismatch');
  const digest = expected.digest.replace(/^sha256:/, '');
  assert(/^[a-f0-9]{64}$/.test(digest) && artifact.digest === `sha256:${digest}`, 'Artifact service digest mismatch');
}
async function download(expected, member) {
  const artifact = await api(`actions/artifacts/${expected.id}`);
  verifyArtifactMetadata(artifact, expected);
  assert(artifact.size_in_bytes <= 20 * 1024 * 1024, 'Oversize candidate artifact');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${expected.id}/zip`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` },
  });
  assert(response.ok, 'Cannot download candidate artifact');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 20 * 1024 * 1024 && `sha256:${hash(bytes)}` === artifact.digest, 'Downloaded artifact digest mismatch');
  const result = spawnSync('python3', ['-c', `import io,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.namelist()==[sys.argv[1]]
i=z.getinfo(sys.argv[1])
assert i.file_size<=20*1024*1024
sys.stdout.buffer.write(z.read(i))`, member], { input: bytes, maxBuffer: 20 * 1024 * 1024 });
  assert(result.status === 0, 'Invalid candidate archive');
  return JSON.parse(result.stdout.toString('utf8'));
}
export function verifyJobs(run, jobs, identity, requireCheck = true) {
  assert(run.id === Number(identity.runId) && run.run_attempt === identity.attempt
    && run.path === WORKFLOW_PATH && run.head_sha === identity.workflowSha
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
    && ['issue_comment', 'workflow_run'].includes(run.event),
  'Untrusted correction workflow/run attempt');
  const required = { 'pr-fix': ['Run isolated fresh session', 'Prepare correction proposal', 'Upload correction proposal'] };
  if (requireCheck) required['candidate-check'] = ['Generate and check candidate in isolated containers', 'Upload checked candidate'];
  for (const [name, steps] of Object.entries(required)) {
    const matching = jobs.filter((job) => job.name === name);
    assert(matching.length === 1 && matching[0].conclusion === 'success' && matching[0].status === 'completed', `Unsuccessful/untrusted job: ${name}`);
    for (const step of steps) assert(matching[0].steps.some((value) => value.name === step
      && value.status === 'completed' && value.conclusion === 'success'), `Required successful step missing: ${step}`);
  }
}
async function verifyOrigin(requireCheck = true) {
  const identity = runIdentity();
  assert(SHA.test(identity.workflowSha) && /^[1-9][0-9]*$/.test(identity.runId)
    && Number.isSafeInteger(identity.attempt) && identity.attempt > 0, 'Invalid current workflow identity');
  const run = await api(`actions/runs/${identity.runId}`);
  const { jobs } = await api(`actions/runs/${identity.runId}/attempts/${identity.attempt}/jobs?per_page=100`);
  verifyJobs(run, jobs, identity, requireCheck);
  return identity;
}
function artifactExpected(kind, identity) {
  const prefix = kind === 'proposal' ? 'PROPOSAL' : 'CHECKED';
  return { ...identity, id: process.env[`${prefix}_ID`], digest: process.env[`${prefix}_DIGEST`] ?? '',
    name: `correction-${kind}-${identity.runId}-${identity.attempt}` };
}
export function verifyReceipt(proposal, checked, identity, proposalArtifact) {
  validateProposal(proposal);
  same({ ...proposal.meta, pr: undefined, branch: undefined, sha: undefined, kind: undefined },
    { ...identity, pr: undefined, branch: undefined, sha: undefined, kind: undefined }, 'Proposal run identity mismatch');
  assert(checked.schema === 1 && checked.result === 'PASS' && checked.command === 'mise run check', 'Candidate was not successfully checked');
  same(checked.meta, proposal.meta, 'Checked candidate base/run mismatch');
  assert(checked.proposalArtifactId === String(proposalArtifact.id)
    && checked.proposalArtifactDigest === proposalArtifact.digest.replace(/^sha256:/, ''), 'Checked result belongs to another proposal artifact');
  same(checked.files, proposal.files, 'Checked candidate source substituted');
  assert(checked.tree === proposal.tree && Array.isArray(checked.generated) && checked.generated.length > 0, 'Checked tree/generated outputs missing');
}

async function propose() {
  const directory = resolve(process.env.SESSION_DIR);
  const meta = { ...JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8')), ...runIdentity() };
  validateMeta(meta);
  await current(meta);
  const answer = JSON.parse(readFileSync(join(directory, 'answer.txt'), 'utf8'));
  const proposal = { schema: 1, meta, summary: answer.summary, edits: answer.edits, tree: meta.sha };
  // Build a Git index/tree only; no commit and no candidate execution.
  const built = reconstruct(proposal, join(directory, 'proposal-repository'));
  Object.assign(proposal, built);
  writeFileSync(join(directory, 'proposal.json'), JSON.stringify(proposal));
}
async function check() {
  const identity = await verifyOrigin(false);
  const expected = artifactExpected('proposal', identity);
  const proposal = await download(expected, 'proposal.json');
  validateProposal(proposal);
  same(proposal.meta.workflowSha, identity.workflowSha, 'Unexpected trusted workflow SHA');
  await current(proposal.meta);
  const directory = resolve(process.env.CANDIDATE_DIR);
  mkdirSync(directory, { recursive: true });
  const rebuilt = reconstruct(proposal, join(directory, 'repository'));
  same(rebuilt, { files: proposal.files, tree: proposal.tree }, 'Original proposal does not reconstruct');
  const work = join(directory, 'work');
  exportFiles(rebuilt.files, work);
  const log = openSync(join(directory, 'candidate-check.log'), 'w');
  let checked;
  try {
    checked = checkCandidate({ proposal, work, runtime: join(directory, 'runtime'), mise: process.env.MISE_BINARY,
      execute(args) {
        const result = spawnSync('docker', args, { stdio: ['ignore', log, log], timeout: 20 * 60 * 1000 });
        assert(result.status === 0, 'Isolated candidate command failed; see candidate-check.log');
      } });
  } finally { closeSync(log); }
  Object.assign(checked, { proposalArtifactId: String(expected.id), proposalArtifactDigest: expected.digest.replace(/^sha256:/, '') });
  writeFileSync(join(directory, 'checked.json'), JSON.stringify(checked));
  console.log('Isolated mise run check passed; complete source and generated snapshot unchanged.');
}
async function verified() {
  const identity = await verifyOrigin();
  const expected = artifactExpected('proposal', identity);
  const proposal = await download(expected, 'proposal.json');
  const checked = await download(artifactExpected('checked', identity), 'checked.json');
  verifyReceipt(proposal, checked, identity, expected);
  await current(proposal.meta);
  mkdirSync(resolve(process.env.CANDIDATE_DIR), { recursive: true });
  const work = mkdtempSync(join(resolve(process.env.CANDIDATE_DIR), 'publish-'));
  const rebuilt = reconstruct(proposal, work);
  same(rebuilt.tree, checked.tree, 'Publication tree differs from checked tree');
  same(rebuilt.files, checked.files, 'Full publication candidate differs from checked data');
  return { proposal, checked, work };
}
export async function commitAndPush({ proposal, checked, work, readCurrent, readIssues, commit, push, remoteHead }) {
  // This orchestration seam is also exercised with real Git fixtures in tests.
  assert(checked.result === 'PASS' && checked.command === 'mise run check', 'Candidate check did not pass');
  same(snapshot(work, true), checked.files, 'Candidate changed after verification');
  assert(git(['write-tree'], work).trim() === checked.tree, 'Candidate index changed after verification');
  const pr = await readCurrent(proposal.meta);
  const issues = await resolveLinkedIssues(pr.body, { repository: REPOSITORY, readIssue: readIssues });
  if (git(['diff', '--cached', '--name-only'], work).trim()) {
    assert(await remoteHead() === proposal.meta.sha, 'Remote HEAD changed before commit');
    await commit(correctionCommitMessage(issues));
    await readCurrent(proposal.meta);
    assert(git(['remote', 'get-url', 'origin'], work).trim() === `https://github.com/${REPOSITORY}.git`
      && git(['branch', '--show-current'], work).trim() === proposal.meta.branch
      && git(['rev-parse', 'HEAD^'], work).trim() === proposal.meta.sha
      && git(['rev-parse', 'HEAD^{tree}'], work).trim() === checked.tree
      && await remoteHead() === proposal.meta.sha, 'Repository/branch/HEAD changed before push');
    await push();
  }
}
async function smoke() {
  const directory = resolve(process.env.CANDIDATE_DIR);
  mkdirSync(directory, { recursive: true });
  const proposal = { schema: 1, meta: { ...runIdentity(), kind: 'fix',
    pr: Number(process.env.PR_NUMBER), sha: git(['rev-parse', 'HEAD']).trim(), branch: 'candidate-smoke' },
    summary: 'Read-only isolation smoke; no model, commit or push', edits: [],
    tree: git(['rev-parse', 'HEAD^{tree}']).trim(), files: snapshot(process.cwd(), true) };
  const work = join(directory, 'work');
  exportFiles(proposal.files, work);
  const log = openSync(join(directory, 'candidate-check.log'), 'w');
  try {
    const receipt = checkCandidate({ proposal, work, runtime: join(directory, 'runtime'), mise: process.env.MISE_BINARY,
      execute(args) {
        const result = spawnSync('docker', args, { stdio: ['ignore', log, log], timeout: 20 * 60 * 1000 });
        assert(result.status === 0, 'Isolated candidate smoke failed; see candidate-check.log');
      } });
    writeFileSync(join(directory, 'checked.json'), JSON.stringify(receipt));
  } finally { closeSync(log); }
  console.log('Real container generation and mise run check passed; no model or publisher invoked.');
}
async function publish() {
  const { proposal, checked, work } = await verified();
  assert(process.env.APP_TOKEN, 'App token is required only for publication');
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.APP_TOKEN}`).toString('base64')}`;
  function authenticatedGit(args) {
    const result = spawnSync('git', ['-c', `http.https://github.com/.extraheader=${header}`, ...args], { cwd: work, encoding: 'utf8' });
    assert(result.status === 0, `Authenticated git ${args[0]} failed (details suppressed)`);
    return result.stdout;
  }
  await commitAndPush({ proposal, checked, work, readCurrent: current, readIssues: (n) => api(`issues/${n}`),
    remoteHead: () => authenticatedGit(['ls-remote', 'origin', `refs/heads/${proposal.meta.branch}`]).split(/\s/)[0],
    commit: (message) => git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=opencode-agent[bot]',
      '-c', 'user.email=opencode-agent[bot]@users.noreply.github.com', 'commit', '-m', message], work),
    push: () => authenticatedGit(['push', 'origin', `HEAD:refs/heads/${proposal.meta.branch}`]) });
  await api(`issues/${proposal.meta.pr}/comments`, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.APP_TOKEN}` }, body: JSON.stringify({ body:
    `PR correction based on ${proposal.meta.sha}; isolated mise run check PASS before commit.\n\n${proposal.summary}\n\nhttps://github.com/${REPOSITORY}/actions/runs/${proposal.meta.runId}` }) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = { propose, check, verify: verified, publish, smoke }[process.argv[2]];
    assert(command, 'Use propose|check|verify|publish|smoke');
    await command();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
