# Деплой CRM на TimeWeb VPS

Инструкция рассчитана на VPS с Ubuntu 22.04/24.04, Docker Compose и доменом. Для голосового помощника нужен HTTPS, поэтому production-контур использует Caddy с автоматическим сертификатом.

## 1. Подготовить домен

1. В DNS домена создайте `A`-запись на IP сервера TimeWeb.
2. Дождитесь обновления DNS.
3. Откройте на сервере порты `80` и `443`.

Проверка DNS с локального компьютера:

```bash
nslookup crm.example.ru
```

## 2. Подготовить сервер

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
docker compose version
```

## 3. Забрать проект с GitHub

```bash
cd /opt
sudo mkdir -p crm
sudo chown $USER:$USER crm
git clone https://github.com/Maxim-hub2020/crm.git crm
cd /opt/crm
```

Если используем отдельную ветку для релиза:

```bash
git checkout codex/timeweb-production
git pull
```

## 4. Заполнить `.env`

```bash
cp .env.example .env
nano .env
```

Минимально проверьте:

```env
APP_DOMAIN=crm.example.ru
DJANGO_SECRET_KEY=long-random-secret
ALLOWED_HOSTS=crm.example.ru,www.crm.example.ru,localhost,127.0.0.1,backend
CSRF_TRUSTED_ORIGINS=https://crm.example.ru
POSTGRES_PASSWORD=strong-password
DATABASE_URL=postgres://crm:strong-password@db:5432/crm
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/vertex-sa.json
VITE_ASSISTANT_LIVE=1
```

Сгенерировать секрет Django можно так:

```bash
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(64))
PY
```

## 5. Положить JSON-ключ Vertex AI

На сервере файл должен лежать здесь:

```bash
mkdir -p backend/secrets
nano backend/secrets/vertex-sa.json
chmod 600 backend/secrets/vertex-sa.json
```

В `.env` путь внутри контейнера должен быть:

```env
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/vertex-sa.json
```

## 6. Запустить production

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Создать администратора:

```bash
docker compose -f docker-compose.prod.yml exec backend python manage.py createsuperuser
```

Проверки:

```bash
curl -I https://crm.example.ru
curl https://crm.example.ru/api/health/
docker compose -f docker-compose.prod.yml logs -f backend
```

## 7. Автодеплой через GitHub Actions

После первого ручного запуска можно включить автоматическое обновление сервера при каждом push в ветку `codex/timeweb-production`.

### 7.1. Подготовить пользователя для runner

На сервере TimeWeb:

```bash
adduser --disabled-password --gecos "" github-runner
usermod -aG docker github-runner
chown -R github-runner:github-runner /opt/crm
```

Если Docker был установлен недавно, перезапустите SSH-сессию или выполните:

```bash
newgrp docker
```

### 7.2. Создать self-hosted runner в GitHub

Откройте:

`GitHub -> repository -> Settings -> Actions -> Runners -> New self-hosted runner`

Выберите `Linux` и `x64`. GitHub покажет команды установки. Выполняйте их на сервере под пользователем `github-runner`:

```bash
su - github-runner
mkdir actions-runner
cd actions-runner
```

Скопируйте и выполните команды `Download` и `Configure` из GitHub. При настройке runner укажите labels:

```text
timeweb,crm
```

После настройки установите runner как сервис:

```bash
exit
cd /home/github-runner/actions-runner
./svc.sh install github-runner
./svc.sh start
./svc.sh status
```

Runner должен появиться в GitHub со статусом `Idle`.

### 7.3. Добавить Secrets в GitHub

Откройте:

`GitHub -> repository -> Settings -> Secrets and variables -> Actions -> New repository secret`

Необязательный секрет:

```text
TIMEWEB_APP_DIR=/opt/crm
```

SSH-секреты `TIMEWEB_HOST`, `TIMEWEB_USER`, `TIMEWEB_SSH_KEY`, `TIMEWEB_PORT` для self-hosted runner больше не нужны.

### 7.4. Уведомления в Telegram

1. Напишите `@BotFather` в Telegram.
2. Создайте бота командой `/newbot`.
3. Скопируйте token бота.
4. Напишите любое сообщение своему новому боту.
5. Откройте в браузере:

```text
https://api.telegram.org/botBOT_TOKEN/getUpdates
```

В ответе найдите `chat.id`.

Добавьте в GitHub Secrets:

```text
TELEGRAM_BOT_TOKEN=токен_бота
TELEGRAM_CHAT_ID=ваш_chat_id
```

После этого workflow `.github/workflows/deploy-timeweb.yml` будет:

- запускаться при push в `codex/timeweb-production`;
- выполняться прямо на TimeWeb через self-hosted runner;
- делать `git pull --ff-only`;
- пересобирать `docker compose --env-file .env -f docker-compose.prod.yml up -d --build`;
- проверять backend через `python manage.py check`;
- отправлять сообщение в Telegram об успехе или ошибке.

## 8. Ручное обновление через GitHub

Рабочий процесс:

```bash
cd /opt/crm
git checkout codex/timeweb-production
git pull --ff-only
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
docker compose --env-file .env -f docker-compose.prod.yml ps
```

Если появились новые миграции, backend применит их сам при старте.

## 9. Бэкап базы

Создать бэкап:

```bash
mkdir -p backups
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/crm-$(date +%F-%H%M).sql
```

Восстановить бэкап:

```bash
cat backups/crm-YYYY-MM-DD-HHMM.sql | docker compose -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

## 10. Полезные команды

Логи:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy nginx backend ai-memory-worker
```

Перезапуск:

```bash
docker compose -f docker-compose.prod.yml restart backend
```

Остановить:

```bash
docker compose -f docker-compose.prod.yml down
```

Остановить с удалением базы нельзя делать без бэкапа:

```bash
docker compose -f docker-compose.prod.yml down -v
```

## 11. Важные замечания

- Голосовой помощник в браузере требует HTTPS, поэтому домен и Caddy обязательны для production.
- Не коммитьте `.env` и `backend/secrets/vertex-sa.json` в GitHub.
- Если TimeWeb firewall включен, разрешите входящие `80/tcp` и `443/tcp`.
- Если домен еще не направлен на сервер, Caddy не сможет получить сертификат.
