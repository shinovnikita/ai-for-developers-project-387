# OpenCode 1.19.6: запуск HTTP-аудита из Actions

Проверено по официальным исходникам версии **1.19.6**, закреплённым на commit `f4e363c8295fa90a03dddc451882fffe8fbce357`, и документации OpenCode V1. Это проверка способа интеграции, а не результат запуска аудита приложения. [Тег версии](https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v1.19.6).

## Выбор CLI

Для `schedule` и `workflow_dispatch` используем `opencode run`, сохраняя существующий в проекте подход изолированной сессии. Официальная документация описывает `run` как неинтерактивный режим для автоматизации и подтверждает `--format json`, `--agent`, `--model`, `--variant` и `--title`. [CLI V1](https://opencode.ai/v1/docs/cli/#run).

```text
opencode run --format json --model openai/gpt-6.1-sol \
  --variant medium --agent audit --title 'Application HTTP availability audit'
```

Без `--session`, `--continue`, `--fork` и `--attach` CLI создаёт новую сессию; prompt принимает через stdin. Неинтерактивная сессия запрещает `question`, `plan_enter`, `plan_exit`, остальные запросы разрешений автоматически отклоняет. `--mini` включает интерактивность; `--auto`, `--yolo` и `--dangerously-skip-permissions` в аудите не используются. JSONL содержит `sessionID`, завершённые текстовые части, `step_finish` и ошибки; ошибки выставляют ненулевой exit code. Корень зависит от `PWD ?? cwd`, поэтому унаследованный `PWD` в модельное окружение не передаётся. [run.ts закреплённой версии](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/cli/cmd/run.ts).

GitHub-wrapper официально поддерживает оба нужных события, но объединяет модель с GitHub-контекстом, авторизацией и возможной публикацией. Прямой `run` выбран для разделения модели и publisher; утверждение, что wrapper вообще не поддерживает расписание, было бы неверным. Это архитектурный вывод из [документации GitHub-интеграции](https://opencode.ai/v1/docs/github/#supported-events).

## Модель, разрешения и конфигурация

`share: "disabled"`, `enabled_providers`, `model`, `small_model`, `snapshot` и `autoupdate` поддерживаются схемой конфигурации. В аудите закреплены основной и служебные model IDs, выключены sharing, snapshot и обновления. [Схема V1](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/core/src/v1/config/config.ts).

Wildcard `permission: {"*":"deny"}` блокирует инструменты; последнее совпавшее правило имеет приоритет. [Permissions V1](https://opencode.ai/v1/docs/permissions/#configuration). У агента `audit` повторяется запрет, включая явный `external_directory: "deny"`: `agent.ts` иначе добавляет разрешение для внешнего каталога усечённого вывода. `title.disable: true` удаляет title-агента. [agent.ts](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/agent/agent.ts).

Явный `--title` также исключает генерацию заголовка: `ensureTitle` работает только с автоматически назначенным заголовком. Это устраняет служебный запрос модели для title. [Условие ensureTitle](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/prompt.ts#L193-L245).

`OPENCODE_CONFIG_CONTENT` объединяется с другими источниками конфигурации; одного inline JSON недостаточно для изоляции. Существующий `sessionEnvironment` задаёт отдельные HOME/XDG/config/data/cache/state, а запуск использует отдельный рабочий каталог. В окружение допускаются ключ OpenAI и необходимые служебные настройки, но не GitHub/App/OIDC-токены. `OPENCODE_DISABLE_AUTOCOMPACT` принудительно задаёт `compaction.auto: false`; в конфигурации также отключён prune. [Загрузка конфигурации](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/config/config.ts).

Флаги `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS` и `OPENCODE_DISABLE_AUTOCOMPACT` документированы. Они исключают проектные инструкции, внешние skills и неявные плагины из модельного процесса. [Переменные CLI](https://opencode.ai/v1/docs/cli/#environment-variables).

## Завершение и границы результата

В `step_finish.part` сохраняются `reason`, `tokens`, `cost`, `messageID` и `sessionID`; эти сведения возникают при обработке завершения шага провайдера. [processor.ts](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/processor.ts).

Доверенный parser проекта требует одну сессию, завершённый текст, единственный `step_finish` с `reason: "stop"` и отсутствие событий ошибок или инструментов. Пустой, оборванный или несовместимый поток завершается ошибкой, даже если процесс вернул 0. Далее отдельно проверяется JSON-схема ответа и совпадение всех IDs кандидатов со сборщиком. Это политика аудита проекта, а не встроенная JSON-схема OpenCode.

`OPENAI_API_KEY` получает только дочерний процесс модели, а проверка `opencode --version` выполняется без него и сохраняет результат в `model-version.json`. Вызов ограничен восемью минутами; stdout, stderr и код завершения сохраняются до разбора. Publisher использует отдельный `GITHUB_TOKEN` с `issues: write`, не GitHub App/OIDC, и не выполняет инструкции из текста модели. Такой выбор полномочий соответствует отдельной публикации issues через [GitHub REST API](https://docs.github.com/en/rest/issues/issues#create-an-issue).

Локальные проверки используют фикстуры; реальный доступ модели и создание/дедупликация учебного issue в Actions проверяются после слияния по шагам в README.
