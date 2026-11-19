# Вход в MCP хостинга из Codex

Инструкции ниже относятся к продолжению в `shinovnikita/ai-for-developers-project-387`. [Опубликованное приложение первого проекта](https://call-calendar-386-production-aa4bcc9c.up.railway.app) относится к репозиторию 386; перенос файлов в 387 сам по себе не создаёт новый деплой.

Добавьте секцию нужного хостинга из [шаблона](codex-mcp.example.toml) в личный файл `~/.codex/config.toml`, сохранив остальные настройки. В шаблоне только адрес сервера, публичный идентификатор клиента OAuth и команда запуска. Учётные данные остаются на компьютере пользователя. [Настройка MCP в Codex](https://developers.openai.com/codex/mcp/)

## Render как альтернативный хостинг

1. Скопируйте обе секции Render и выполните `codex mcp login render`. Войдите в Render в открывшемся браузере и подтвердите доступ.
2. В Codex запросите список рабочих пространств Render и выберите пространство для календаря. Перед созданием проверьте, есть ли там сервис этого репозитория.
3. Через MCP создайте Blueprint из ветки `main` репозитория `shinovnikita/ai-for-developers-project-387`. Корневой [render.yaml](../render.yaml) описывает один Docker Web Service на плане `free` с проверкой `/health`. Проверьте план синхронизации и примените его. Хостинг задаёт `PORT`. После деплоя проверьте, что `/health` на публичном адресе возвращает HTTP 200.

На Render Free перезапуск, новый деплой или остановка после 15 минут без входящего трафика очищают временную файловую систему. При следующем запуске приложение создаст пустую базу SQLite. Если Render предлагает только платный ресурс, проверьте бесплатный вариант Railway. [Официальный Render MCP](https://render.com/docs/mcp-server) · [Файловая система Render Free](https://render.com/docs/free#local-files-lost-on-redeploy) · [Health Check Path](https://render.com/docs/health-checks)

## Railway

1. Установите Railway CLI и выполните `railway login`. Подтвердите вход в браузере. Для входа с другого устройства выполните `railway login --browserless`, откройте выданную ссылку и введите там одноразовый код из терминала. Секция Railway в шаблоне запускает официальный MCP-сервер с этой сессией. [Установка Railway CLI](https://docs.railway.com/cli) · [Вход](https://docs.railway.com/cli/login) · [Инструменты MCP](https://docs.railway.com/ai/mcp-server#run-the-server-locally)
2. В Codex запросите `whoami` у Railway. Проверьте тариф и остаток кредита в рабочем пространстве. Согласуйте платный ресурс до создания. [Условия бесплатного тарифа и пробного периода](https://docs.railway.com/pricing/free-plan)
3. Для запуска через Railway MCP используйте репозиторий `shinovnikita/ai-for-developers-project-387` и ветку `main`. Railway обнаруживает `Dockerfile` в корне. Установите **Healthcheck Path** в `/health`, включите Serverless, оставьте назначение `PORT` хостингу и создайте публичный домен для сервиса. Сверьте SHA успешного деплоя с GitHub и проверьте `/health` по HTTPS. [Сборка из Dockerfile](https://docs.railway.com/builds/dockerfiles) · [Проверка готовности](https://docs.railway.com/deployments/healthchecks)
