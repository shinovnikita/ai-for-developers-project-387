#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

function fail(message) {
  console.error(`OpenCode gh: ${message}`);
  process.exit(1);
}

const workspace = process.env.GITHUB_WORKSPACE;
const executable = process.env.OPENCODE_GH_EXECUTABLE;
if (process.env.GITHUB_ACTIONS !== 'true' || !workspace || !isAbsolute(workspace)
  || !executable || !isAbsolute(executable)) {
  fail('requires the Actions workspace and the original gh executable');
}

// The GitHub wrapper configures this header before starting the agent. Read it
// through a private pipe; neither the header nor the token belongs in tool output.
const credential = spawnSync('git', [
  '-C', workspace, 'config', '--local', '--get',
  'http.https://github.com/.extraheader',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8192 });
if (credential.error || credential.status !== 0) {
  fail('GitHub wrapper credentials are unavailable');
}

const header = /^AUTHORIZATION:\s+basic\s+([A-Za-z0-9+/]+={0,2})$/i
  .exec(credential.stdout.trim());
const decoded = header && Buffer.from(header[1], 'base64');
const token = decoded && decoded.toString('base64') === header[1]
  && /^x-access-token:([^\s:]+)$/.exec(decoded.toString('utf8'))?.[1];
if (!token) fail('GitHub wrapper credentials have an unexpected format');

// Use the same temporary App token as the wrapper, with no cached/local fallback.
const result = spawnSync(executable, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' },
});
if (result.error) fail('could not start the original gh executable');
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
