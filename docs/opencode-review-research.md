# OpenCode 1.19.6: независимое ревью PR и GitHub App

Проверено 22 ноября 2026 года по официальным исходникам OpenCode и документации GitHub. GitHub API разрешает тег `v1.19.6` в commit `f4e363c8295fa90a03dddc451882fffe8fbce357`; все ссылки на исходники ниже закреплены на этом commit. [GitHub API: tag](https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v1.19.6).

## Вывод для реализации

Для независимого ревью нужен отдельный `opencode run` с новой сессией, заданным заголовком, отдельными каталогами конфигурации и состояния, без инструментов и GitHub-учётных данных. Контекст PR, diff и CI следует собрать доверенным кодом до запуска и передать через stdin. Встроенный `opencode github run` умеет ревью PR, но также автоматически сохраняет изменения и публикует комментарии; это другой уровень полномочий. Основания: [создание сессии CLI](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/run.ts#L451-L531), [маршрутизация PR wrapper](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L550-L587).

Для последующей публикации достаточно отдельного доверенного скрипта, который повторяет уже используемый OpenCode обмен Actions OIDC на GitHub App installation token. Вызов модели для получения токена не требуется. [Клиент обмена](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L963-L998), [сервер обмена](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/function/src/api.ts#L259-L307).

## Когда wrapper получает полномочия

`github run` сначала получает токен, создаёт Octokit, подготавливает Git, проверяет права инициатора, и только затем создаёт сессию. Прямой модельный вызов находится в `chat()`. Поэтому бюджетный gate, поставленный только в модельный prompt или инструмент `gh`, слишком поздно контролирует запуск. Проверку бюджета нужно завершить до запуска OpenCode. [Порядок операций](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L468-L510), [вызов prompt](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L875-L909).

Есть официальный обход App/OIDC: `USE_GITHUB_TOKEN=true` берёт `GITHUB_TOKEN`; при отсутствии переменной wrapper завершает работу с ошибкой. Это не отдельный режим «только получить токен». [Реализация](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L468-L485), [нормализация флага](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L667-L679).

Проверка actor допускает только collaborator permission `admin` или `write`. GitHub App token при этом уже получен. [Проверка прав](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L1145-L1165).

## Дополнительные обращения к модели

| Путь                              | Когда происходит                                                                                      | Как закрепить или исключить                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Основной `chat()` wrapper         | Обработка запроса; использует `MODEL` и `VARIANT`                                                     | Задать обе переменные для wrapper                                                                         |
| Заголовок сессии                  | Первый запрос новой корневой сессии с автоматически назначенным заголовком; запускается фоновым fiber | Передать CLI `--title` с обычным явным текстом и/или `agent.title.disable: true`                          |
| Краткий заголовок коммита wrapper | Обнаружены изменения; повторный `chat()` с просьбой сократить ответ                                   | Не использовать wrapper для изолированного review/fix; commit message строит доверенный код               |
| Fallback summary wrapper          | Основной ответ не содержит текста                                                                     | Повторный prompt той же сессии, той же `MODEL`/`VARIANT`, `tools: {"*": false}`                           |
| Compaction                        | Контекст требует сжатия                                                                               | `compaction.auto: false`, `OPENCODE_DISABLE_AUTOCOMPACT=true`; модель compaction можно закрепить отдельно |

Источники: [основной chat и оба summary wrapper](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L865-L960), [условия title и вызов LLM](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/prompt.ts#L193-L245), [фоновый запуск title](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/prompt.ts#L1132-L1139), [выбор compaction model](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/compaction.ts#L358-L361), [модельный processor compaction](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/compaction.ts#L420-L448), [флаг отключения auto compaction](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/config/config.ts#L593-L598).

Title может выбрать другую модель: сначала `agent.title.model`, затем `small_model`/эвристика провайдера, затем модель пользователя. Одного `--model` или `MODEL` недостаточно, чтобы закрепить все обращения. [Выбор title model](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/prompt.ts#L216-L234), [эвристика small model](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/provider/provider.ts#L1964-L2030).

Встроенные агенты `title`, `summary`, `compaction` существуют; конфигурация разрешает задавать им `model` или `disable`. Однако сервис `SessionSummary.summarize()` в 1.19.6 вычисляет diff/метаданные и сам модель не вызывает. Это не тот же путь, что fallback summary wrapper. [Встроенные агенты и overrides](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/agent/agent.ts#L219-L294), [SessionSummary](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/summary.ts#L102-L127).

## События PR и поведение ветки

Поддерживаются `pull_request`, `pull_request_review_comment`, `issue_comment`, `issues`, `schedule`, `workflow_dispatch`. Для `pull_request` без `PROMPT` используется запрос ревью; для review-comment извлекаются путь, строка и diff hunk. Ответ wrapper публикует обычным issue-комментарием PR через `issues.createComment`, а не GitHub review. [Список событий](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L146-L151), [контекст комментария и prompt](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L693-L756), [публикация](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L1252-L1261).

Для same-repository PR wrapper получает и checkout-ит `headRefName`, затем при изменениях делает commit и обычный `git push` в ту же ветку. Для fork PR создаётся локальная ветка, push идёт в fork как `HEAD:<headRefName>`. Изменения HEAD тоже учитываются; если агент переключил ветку, инфраструктурный push пропускается. [Ветка PR](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L550-L587), [checkout](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L1034-L1058), [push и dirty detection](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L1085-L1132).

## Доверенный workflow и событие PR

GitHub связывает `pull_request` и `pull_request_review_comment` с PR merge ref; checkout `main` внутри job сам по себе не делает исходный workflow доверенным. Для привилегированного агента подходит разделение: непривилегированный request workflow принимает событие, затем `workflow_run` запускает worker из default branch. У `workflow_run` значения `GITHUB_SHA`/`GITHUB_REF` относятся к default branch; этот worker может иметь secrets/write token, даже если request их не имел. [GitHub: события PR и workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

Источник request нужно повторно проверить через GitHub API: repository, workflow path, event, conclusion, attempt, связь с PR; для команды — также инициатора и существующий комментарий с доверенным автором. Artifact остаётся недоверенными данными: ограничить размер, читать только ожидаемый JSON, не извлекать исполняемые файлы в workspace и не исполнять содержимое. GitHub отдельно предупреждает о повышении привилегий и отравлении кэша при исполнении недоверенного кода в `workflow_run`. Это выводы для архитектуры проекта на основании [официального описания и примера передачи artifact](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#using-data-from-the-triggering-workflow).

SHA worker нельзя подменять SHA проверяемого PR: итоговая идентичность ревью — полный `pull_request.head.sha`, проверенный по live REST-ответу. Соответствие полей source run реальному head необходимо проверить контрольным запуском; отсутствие однозначной связи должно завершаться отказом до модели.

## Независимая CLI-сессия без инструментов

`opencode run` без `--continue`, `--session`, `--fork`, `--attach` создаёт новую сессию. stdin читается как данные; `--format json` выдаёт JSONL, включая завершённые текстовые части (`type: "text"`, `part.text`), tool events, step events и ошибки. Доверенный parser должен проверять ошибки и собирать только нужные текстовые части. CLI в обычном неинтерактивном режиме отклоняет запросы разрешения, если не включены `--auto`/`--yolo`/`--dangerously-skip-permissions`. [stdin](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/run.ts#L417-L423), [новая сессия](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/run.ts#L451-L531), [JSONL события](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/run.ts#L668-L753), [отклонение разрешений](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/run.ts#L790-L815).

Рекомендуемый доверенный конфиг для обеих стадий — review и построения JSON-правок:

```json
{
  "model": "openai/gpt-6.1-sol",
  "small_model": "openai/gpt-6.1-sol",
  "default_agent": "pr",
  "enabled_providers": ["openai"],
  "share": "disabled",
  "snapshot": false,
  "autoupdate": false,
  "instructions": [],
  "plugin": [],
  "mcp": {},
  "permission": { "*": "deny" },
  "compaction": { "auto": false, "prune": false },
  "agent": {
    "pr": {
      "mode": "primary",
      "model": "openai/gpt-6.1-sol",
      "variant": "medium",
      "permission": { "*": "deny" }
    },
    "title": { "disable": true },
    "summary": { "model": "openai/gpt-6.1-sol" },
    "compaction": { "model": "openai/gpt-6.1-sol" }
  }
}
```

Это поддерживаемая v1-схема: [общие поля](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/core/src/v1/config/config.ts#L52-L164), [агент](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/core/src/v1/config/agent.ts#L12-L38), [произвольный permission key и wildcard](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/core/src/v1/config/permission.ts#L14-L47). Правило `"*": "deny"` преобразуется в запрет всех инструментов; при выборе действует последнее подходящее правило. [Применение permissions](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/permission/index.ts#L28-L39), [удаление запрещённых tools](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/permission/index.ts#L186-L213).

Для каждого запуска нужен новый пустой рабочий каталог вне checkout PR и новые `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TEST_HOME`. Самого `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` недостаточно: загрузчик объединяет конфиги, глобальные файлы и каталоги, причём `.opencode` из home остаётся кандидатом даже при отключении project config. Изолированный home исключает также пользовательские инструкции и auth. [Глобальные пути](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/core/src/global.ts#L9-L29), [config merge и auto-discovery](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/config/config.ts#L412-L489), [home `.opencode`](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/config/paths.ts#L23-L40).

Рекомендуемые флаги окружения: `OPENCODE_DISABLE_PROJECT_CONFIG=true`, `OPENCODE_DISABLE_CLAUDE_CODE=true`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=true`, `OPENCODE_DISABLE_AUTOCOMPACT=true`. Claude-флаг отдельно не выключает `.agents/skills`; поэтому нужен external-skills флаг. `instructions: []` и `plugin: []` также не заменяют изоляцию источников до merge. [Флаги](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/effect/runtime-flags.ts#L17-L37), [project config flag](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/core/src/flag/flag.ts#L52-L70), [поиск внешних skills](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/skill/index.ts#L181-L208), [инструкции](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/instruction.ts#L58-L130).

Команда в таком окружении: `opencode run --format json --agent pr --model openai/gpt-6.1-sol --variant medium --title 'PR review <head-sha>'`, stdin — подготовленный текст. В окружение модели передаётся ключ провайдера; GitHub token и Actions OIDC переменные передавать ей не требуется. Правки модель может вернуть текстом, например JSON `{ "edits": [{ "path": "...", "beforeSha256": "...", "content": "..." }] }`; проверка схемы, путей, базовых SHA, актуального head и применение выполняются уже доверенным кодом. Это предлагаемая архитектура на основании описанных механизмов CLI, а не встроенная функция OpenCode.

## Получение GitHub App token без модели

Доверенный helper может выполнить такой протокол после проверки события и бюджета:

1. Проверить наличие `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN` и `id-token: write`; запросить ID token, добавив query `audience=opencode-github-action`, заголовок `Authorization: Bearer <ACTIONS_ID_TOKEN_REQUEST_TOKEN>`.
2. Проверить HTTP-успех и непустой строковый `value` в ответе GitHub.
3. Отправить `POST https://api.opencode.ai/exchange_github_app_token` с `Authorization: Bearer <value>`. Body не нужен. Ожидается JSON `{ "token": "<installation-token>" }`; проверить успех и непустую строку.
4. Использовать token только в доверенном коде публикации. Не печатать токен, заголовки или сырой error-response; при необходимости передавать между steps — предварительно маскировать. В `finally` отозвать `DELETE https://api.github.com/installation/token` с этим токеном.

Первые три шага повторяют официальный клиент; сервер проверяет issuer `https://token.actions.githubusercontent.com`, audience и `repository` claim, находит installation и выдаёт его токен. Он не требует `owner/repo` в body OIDC-запроса. PAT endpoint — отдельный путь для локального тестирования, здесь не нужен. [GitHub OIDC: разрешение и запрос](https://docs.github.com/en/actions/reference/security/oidc#methods-for-requesting-the-oidc-token), [OpenCode клиент](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L963-L998), [OpenCode сервер](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/function/src/api.ts#L259-L313), [repository claim](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/function/src/github.ts#L3-L14), [отзыв в wrapper](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/github.handler.ts#L1562-L1573), [GitHub revoke endpoint](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28#revoke-an-installation-access-token).

Область installation token определяется установленным App; сервер обмена не передаёт `repositoryIds` или урезанные `permissions`. Следовательно, его нельзя считать узким review-токеном только из-за отдельного helper. Изоляция достигается отсутствием токена у модели и детерминированными ограничениями publisher. [Параметры выпуска токена](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/function/src/api.ts#L286-L300).

App token подходит для push, после которого CI запускается автоматически. Для обычного `GITHUB_TOKEN` GitHub подавляет новые `push` workflow runs; актуальная документация отдельно допускает PR `opened/synchronize/reopened` с требованием approval. Не следует рассчитывать на `GITHUB_TOKEN` для автоматического цикла push → CI. [GitHub: triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

## Бюджет до модели: Git ref как журнал резервирований

Для журнала достаточно стандартного `GITHUB_TOKEN` с `contents: write`; App token не нужен. GitHub API позволяет читать reference, создавать commit и обновлять reference с `force: false`. У PATCH reference нет параметра `expectedOldSha`: сам запрос не является буквальным CAS. [Reference API](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#update-a-reference), [Commit API](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit), [GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

Предлагаемый CAS-протокол: прочитать ledger commit `C` → проверить лимит → создать уникальный commit `N` с единственным parent `C`, новым состоянием и reservation ID → обновить ledger ref на `N` только с `force: false`. Два конкурирующих кандидата от `C` будут sibling commits; после победы одного второй не является fast-forward и должен перечитать журнал. Это вывод из документированных параметров `parents` и гарантий fast-forward, а не отдельная транзакционная функция API. При timeout нельзя начинать модель на основании неизвестного результата: нужно найти своё reservation ID в актуальной истории или отказать безопасно. [Создание commit с parents](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit), [обновление ref без force](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#update-a-reference).

Бюджет должен учитывать запуск CLI целиком, включая возможные служебные вызовы и повторы, а не только финальный ответ. Определение цены, размера резерва, общего лимита и правил возврата резерва остаётся политикой проекта; исследованные API сами этих правил не предоставляют.
