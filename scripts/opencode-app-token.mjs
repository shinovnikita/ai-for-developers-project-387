// The same OIDC exchange as OpenCode 1.19.6 github.handler.ts, without a session.
import { appendFileSync } from 'node:fs';
try {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', 'opencode-github-action');
  const identity = await fetch(url, { headers: {
    Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
  } });
  if (!identity.ok) throw new Error(`OIDC request HTTP ${identity.status}`);
  const { value } = await identity.json();
  if (typeof value !== 'string' || !value) throw new Error('Missing OIDC identity');
  const exchange = await fetch('https://api.opencode.ai/exchange_github_app_token', {
    method: 'POST', headers: { Authorization: `Bearer ${value}` },
  });
  if (!exchange.ok) throw new Error(`App exchange HTTP ${exchange.status}`);
  const { token } = await exchange.json();
  if (typeof token !== 'string' || !/^[\w.-]+$/.test(token)) throw new Error('Missing App token');
  console.log(`::add-mask::${token}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `token=${token}\n`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
