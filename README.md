# Календарь звонков — продолжение

[**Открыть опубликованное приложение первого проекта**](https://call-calendar-386-production-aa4bcc9c.up.railway.app)

[![hexlet-check](https://github.com/shinovnikita/ai-for-developers-project-387/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/shinovnikita/ai-for-developers-project-387/actions/workflows/hexlet-check.yml)
[![Check](https://github.com/shinovnikita/ai-for-developers-project-387/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/shinovnikita/ai-for-developers-project-387/actions/workflows/check.yml?query=branch%3Amain)

Интегрируйте работу агентов в GitHub проект

Сервис для бронирования календаря, разработанный совместно с ИИ.

Учебный проект Хекслета: https://ru.hexlet.io/programs/ai-for-developers
Как это должно работать: https://files.hexlet.app/a/2ipc5m

## Происхождение проекта

Продолжение начато с отслеживаемых файлов репозитория [shinovnikita/ai-for-developers-project-386](https://github.com/shinovnikita/ai-for-developers-project-386), коммит [`5fc7d74ac8e53a573845898c978019c0cacb638d`](https://github.com/shinovnikita/ai-for-developers-project-386/commit/5fc7d74ac8e53a573845898c978019c0cacb638d).

Активные задачи продолжения ведутся в [GitHub Issues проекта 387](https://github.com/shinovnikita/ai-for-developers-project-387/issues). Исторические материалы остаются в первом репозитории:

- [Карта первого проекта (#1)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/1).
- [Спецификация первого проекта (#9)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/9).
- [Рабочее время и часовой пояс календаря (#2)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/2).
- [Поля и ограничения типа встречи (#3)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/3).
- [Правила показа слотов на 14 календарных дней (#4)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/4).
- [Подтверждение записи и поведение при конфликте (#5)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/5).
- [Состав списка предстоящих встреч владельца (#6)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/6).
- [Контракт API календаря звонков (#7)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/7).
- [Сценарии приёмки и границы тестирования (#8)](https://github.com/shinovnikita/ai-for-developers-project-386/issues/8).

Адрес выше ведёт на опубликованное приложение первого проекта 386.

## Сценарий записи на звонок

1. Владелец календаря создаёт тип встречи, указывает название, описание и длительность. После сохранения тип появляется в каталоге для гостей.
2. Гость без регистрации выбирает тип встречи в каталоге. Он открывает календарь на ближайшие 14 календарных дней, выбирает день и видит свободное время. Длительность каждого слота совпадает с длительностью выбранного типа встречи.
3. Гость выбирает время и подтверждает запись. Если слот ещё свободен, приложение создаёт встречу и показывает подтверждение с датой и временем. Если слот уже заняли, приложение предлагает выбрать другое время.
4. Владелец открывает общий список предстоящих встреч и видит новую запись с типом встречи, датой и временем.

У приложения один заранее заданный владелец и один календарь для всех типов встреч. Частичное и полное пересечение записей запрещено, в том числе при одновременных запросах. Следующая встреча может начаться в момент окончания предыдущей. В проекте нет авторизации, личных кабинетов и интеграций с внешними календарями.

Для API используем контракт TypeSpec. Из него генерируется OpenAPI, а Hey API создаёт из OpenAPI клиентский SDK и типы маршрутов Fastify. Fastify регистрирует обработчики, которые проверяют входные данные и соблюдают правила бронирования. Приложение собирается в Docker-образ и запускается в контейнере.

Референс Cal.com. [Создание типа встречи](https://cal.com/blog/event-types-guide-calcom) · [Запись гостя](https://cal.com/scheduling) · [Список встреч владельца](https://cal.com/blog/a-complete-walkthrough-of-cal-com-s-booking-dashboard-its-key-features)

## Стек

- Node.js 24 LTS, TypeScript и Fastify 5.
- React, Vite и Mantine.

## Установка

Для установки закреплённой версии Node.js нужен [mise](https://mise.jdx.dev/).

```bash
git clone https://github.com/shinovnikita/ai-for-developers-project-387.git
cd ai-for-developers-project-387
mise trust
mise install
mise exec -- npm ci
mise exec -- npm run generate:openapi
mise exec -- npm run generate:sdk
```

## Использование

Запустите сервер из корня проекта.

```bash
mise exec -- npm start
```

Fastify использует порт из переменной окружения `PORT`. По умолчанию это `3000`.

В другом терминале проверьте, что сервер отвечает `200 OK` с телом `{"status":"ok"}`.

```bash
curl --noproxy 127.0.0.1 -i http://127.0.0.1:3000/health
```

Для разработки фронтенда запустите Vite из корня проекта.

```bash
mise exec -- npm run dev
```

Страница откроется по адресу [127.0.0.1:5173](http://127.0.0.1:5173/).

Чтобы создать тип встречи, откройте [страницу владельца](http://127.0.0.1:5173/owner). Сервер сохраняет типы встреч в файле `calendar.sqlite` в рабочем каталоге. Путь к файлу можно задать переменной `CALENDAR_DB_PATH`.

Чтобы открыть каталог с демонстрационным типом встречи, запустите `mise exec -- npm run demo:catalog` вместо `npm start` и перейдите на [страницу записи](http://127.0.0.1:5173/booking). Ответ каталога можно проверить напрямую.

```bash
curl --noproxy 127.0.0.1 --fail-with-body -i http://127.0.0.1:3000/api/meeting-types
```

Для сборки и локального предпросмотра собранной страницы выполните следующие команды.

```bash
mise exec -- npm run build
mise exec -- npm run preview
```

Сборка сохраняется в `frontend/dist`. Предпросмотр доступен по адресу [127.0.0.1:4173](http://127.0.0.1:4173/).

### Локальный запуск Docker

Из корня проекта соберите образ и запустите контейнер. Для этих команд нужен запущенный Docker; установка локальных npm-зависимостей не требуется.

```bash
docker build -t call-calendar:local .
docker run --rm --name call-calendar -p 127.0.0.1:3000:3000 call-calendar:local
```

Приложение доступно по адресу [127.0.0.1:3000](http://127.0.0.1:3000/), страница записи — [/booking](http://127.0.0.1:3000/booking), страница владельца — [/owner](http://127.0.0.1:3000/owner). Контейнер слушает порт `3000`. После остановки контейнер удаляется вместе с созданной в нём базой данных.

### Railway: опубликованное приложение первого проекта

Этот раздел описывает опубликованное приложение проекта 386 по адресу [call-calendar-386-production-aa4bcc9c.up.railway.app](https://call-calendar-386-production-aa4bcc9c.up.railway.app).

Railway собирает ветку `main` [первого репозитория](https://github.com/shinovnikita/ai-for-developers-project-386) из корневого `Dockerfile` с контекстом `.`. Fastify слушает на `0.0.0.0` и использует порт из переменной `PORT`, которую задаёт Railway. Хостинг проверяет готовность приложения запросом `GET /health`. [Настройка Codex MCP и вход в хостинг](docs/deployment.md)

Типы встреч и записи гостей хранятся в `/app/data/calendar.sqlite` на временном диске контейнера, без постоянного тома. При перезапуске процесса в том же контейнере файл сохраняется. Новый деплой заменяет контейнер, и календарь начинает работу с пустой базой. [Перезапуск и хранение данных на Railway](https://docs.railway.com/deployments/reference#restart)

У сервиса включён режим Serverless. Через 5–10 минут без исходящего трафика сервис засыпает, а первый запрос его будит. В редких случаях для пробуждения Railway пересобирает сервис, поэтому без тома сохранность записей после сна не гарантируется. [Режим Serverless](https://docs.railway.com/deployments/serverless)

### Рабочее расписание

По умолчанию запись доступна по будням с 09:00 до 18:00 по часовому поясу `Europe/Moscow`. Чтобы задать другое расписание, передайте переменную окружения `CALENDAR_SCHEDULE` с JSON-объектом. Ключи от `0` (воскресенье) до `6` (суббота) соответствуют дням недели. Для каждого рабочего дня укажите один или несколько интервалов в формате `ЧЧ:ММ`. Окончание `24:00` обозначает границу дня. Пустой объект `{}` отключает доступность.

```bash
CALENDAR_SCHEDULE='{"1":[{"startsAt":"10:00","endsAt":"17:00"}]}' mise exec -- npm start
```

## Проверки

Перед первым запуском установите Chromium для Playwright. На Linux добавьте `--with-deps`, чтобы установить системные зависимости, как в GitHub Actions.

```bash
mise exec -- npm exec -- playwright install chromium
```

Из корня проекта запустите `mise run check`. Эта команда генерирует OpenAPI и SDK, проверяет код и запускает Vitest и Playwright. GitHub Actions выполняет её при каждом push.

```bash
mise run check
```

Линтер и тесты можно запустить отдельно.

```bash
mise exec -- npm run lint
mise exec -- npm test
```

Браузерные тесты запускают локальные Fastify и Vite. Их можно запустить отдельно.

```bash
mise exec -- npm run test:browser
```

### Проверка Docker-образа

Из корня проекта выполните команду, которую запускает отдельная проверка CI. Для неё нужны запущенный Docker, `curl` и `jq`.

```bash
bash scripts/docker-smoke.sh
```

Команда собирает образ со сгенерированным SDK и фронтендом, запускает контейнер с `PORT=8080` и проверяет по HTTP `/health`, `/booking` и `/owner` через этот порт. Docker назначает свободный порт на локальной машине. После проверки контейнер удаляется.

---

<details>
<summary>Автоматические тесты Хекслета</summary>

Тесты запускаются на каждый коммит. За запуск отвечает файл `.github/workflows/hexlet-check.yml` — не удаляйте и не переименовывайте ни его, ни репозиторий.

</details>

## Выпуск версии

При каждом обновлении `main` запускается Release Please. Для ручного запуска откройте **Actions → Release Please → Run workflow** и выберите `main`. [Workflow Release Please](.github/workflows/release-please.yml)

До первого запуска настройте один из способов доступа к GitHub API.

- Для встроенного `GITHUB_TOKEN` включите **Allow GitHub Actions to create and approve pull requests** в **Settings → Actions → General → Workflow permissions**. [Настройки GitHub Actions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests)
- Чтобы push в ветку release PR запускал проверки CI, добавьте секрет `RELEASE_PLEASE_TOKEN` в **Settings → Secrets and variables → Actions**. Используйте fine-grained personal access token с доступом к этому репозиторию и правом записи в **Contents**, **Issues** и **Pull requests**. [Учётные данные Release Please](https://github.com/googleapis/release-please-action/tree/45996ed1f6d02564a971a2fa1b5860e934307cf7#other-actions-on-release-please-prs)

1. Добавьте в `main` изменение с сообщением по Conventional Commits, например `feat: add a meeting type catalog` или `fix: handle an empty catalog`. При squash merge используйте этот формат в сообщении итогового коммита.
2. Release Please создаст или обновит release PR. Проверьте версию в `package.json` и `package-lock.json` и описание изменений в `CHANGELOG.md`.
3. Объедините release PR с `main`. При следующем запуске Release Please создаст тег версии и GitHub Release.

## О Хекслете

[Хекслет](https://ru.hexlet.io/) — школа программирования: авторские программы обучения с практикой, поддержкой наставников и реальными проектами, которые остаются в резюме. Этот репозиторий — один из таких проектов.
