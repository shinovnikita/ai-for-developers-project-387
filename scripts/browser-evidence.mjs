import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scenarios = {
  'upcoming-meetings.browser.ts': [
    'Основной: создать тип встречи в UI владельца.',
    'Пройти главная → запись → подтверждение, проверить дату, время и часовой пояс.',
    'Открыть список владельца, проверить запись и обновление списка после соседней записи.',
  ],
  'booking-conflict.browser.ts': [
    'Соседний: выбрать слот и занять его прямым HTTP-запросом к настоящему Fastify.',
    'Подтвердить в UI, проверить 409 SLOT_TAKEN и сохранение имени/типа встречи.',
    'Выбрать смежный слот и проверить успешное подтверждение.',
  ],
  'booking-retry.browser.ts': [
    'Соседний: сохранить запись на сервере и оборвать настоящий ответ.',
    'Сдвинуть окно записи и повторить исходный запрос.',
    'Проверить тот же payload, ответ 200 и восстановленное подтверждение без дубля.',
  ],
};

export function identity(event, checkoutSha, env) {
  const pr = event.pull_request;
  if (!Number.isSafeInteger(pr?.number) || !/^[a-f0-9]{40}$/.test(pr?.head?.sha ?? '')) {
    throw new Error('Expected a pull_request event with a full head SHA');
  }
  if (checkoutSha !== pr.head.sha) throw new Error('Checkout differs from pull_request.head.sha');
  return {
    repository: event.repository.full_name,
    pullRequest: pr.number,
    headSha: pr.head.sha,
    checkoutSha,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  };
}

export function observations(report) {
  const rows = [];
  function visit(suites = []) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          rows.push({
            file: spec.file,
            title: spec.title,
            status: test.status,
            results: test.results.map(({ status, duration, errors, attachments }) => ({
              status, duration, errors, attachments,
            })),
            steps: scenarios[spec.file.split('/').at(-1)] ?? ['См. шаги и assertions в HTML-отчёте и trace.'],
          });
        }
      }
      visit(suite.suites);
    }
  }
  visit(report?.suites);
  return rows;
}

export function render(metadata, rows, outcome) {
  const success = outcome === 'success' && rows.length > 0
    && rows.every(({ status }) => status === 'expected');
  const lines = [
    '# Browser evidence', '',
    `PR: #${metadata.pullRequest}`, `Repository: ${metadata.repository}`,
    `pull_request.head.sha: ${metadata.headSha}`, `Checked-out SHA: ${metadata.checkoutSha}`,
    `Run: ${metadata.runUrl} (attempt ${metadata.runAttempt})`, '',
    `Result: ${success ? 'PASS' : 'FAIL / INCOMPLETE'}; browser step: ${outcome ?? 'not run'}.`, '',
    'Настоящие Fastify, SQLite и Vite запускаются fixture browser/fixtures.ts; успешные ответы бронирования не подменяются.',
    'Сценарии темы из #7 в этом инфраструктурном PR не реализованы.', '',
  ];
  for (const row of rows) {
    lines.push(`## ${row.title}`, '', `Source: ${row.file}; observed result: ${row.status}.`, '');
    lines.push(...row.steps.map((step, index) => `${index + 1}. ${step}`), '');
    for (const result of row.results) {
      lines.push(`Attempt: ${result.status}; duration: ${result.duration} ms.`);
      for (const error of result.errors ?? []) lines.push(`Error: ${error.message ?? 'See JSON/HTML report'}`);
    }
    lines.push('');
  }
  if (!rows.length) lines.push('Нет завершённого JSON-отчёта; успешная браузерная проверка не подтверждена.', '');
  lines.push('Доказательства: playwright.json, junit.xml, browser.log, playwright-report/index.html и test-results/ (traces и screenshots).', '');
  return lines.join('\n');
}

function main() {
  mkdirSync('browser-evidence', { recursive: true });
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const metadata = identity(event, sha, process.env);
  writeFileSync('browser-evidence/identity.json', `${JSON.stringify(metadata, null, 2)}\n`);
  if (process.argv[2] === 'prepare') return;
  if (process.argv[2] !== 'report') throw new Error('Usage: browser-evidence.mjs prepare|report');
  const report = existsSync('browser-evidence/playwright.json')
    ? JSON.parse(readFileSync('browser-evidence/playwright.json', 'utf8')) : undefined;
  const rows = observations(report);
  const markdown = render(metadata, rows, process.env.BROWSER_OUTCOME);
  writeFileSync('browser-evidence/README.md', markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
