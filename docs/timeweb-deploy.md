# Деплой CRM на TimeWeb VPS

Инструкция рассчитана на VPS с Ubuntu 22.04/24.04, Docker Compose и доменом. Для голосового помощника нужен HTTPS, поэтому production-контур использует Caddy с автоматическим сертификатом.

## 1. Подготовить домен

1. В DNS домена создайте `A`-запись на IP сервера TimeWeb.
2. Дождитесь обновления DNS.
3. Откройте на сервере порты `80` и `443`.

Проверка DNS с локального компьютера:

```bash
nslookup cehcrm.ru
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
APP_DOMAIN=cehcrm.ru
DJANGO_SECRET_KEY=long-random-secret
ALLOWED_HOSTS=cehcrm.ru,localhost,127.0.0.1,backend
CSRF_TRUSTED_ORIGINS=https://cehcrm.ru
POSTGRES_PASSWORD=strong-password
DATABASE_URL=postgres://crm:strong-password@db:5432/crm
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/vertex-sa.json
GEMINI_TTS_PROVIDER=cloud_tts
GEMINI_TTS_CLOUD_VOICE=ru-RU-Chirp3-HD-Aoede
GEMINI_TTS_AUDIO_ENCODING=MP3
DADATA_API_KEY=ваш_dadata_api_key
DADATA_DEFAULT_REGION=Ростовская область
DADATA_DEFAULT_CITY=Ростов-на-Дону
YANDEX_DISK_CLIENT_ID=client_id_приложения_яндекса
YANDEX_DISK_CLIENT_SECRET=client_secret_приложения_яндекса
YANDEX_DISK_REDIRECT_URI=https://cehcrm.ru/api/yandex-disk/oauth/callback/
VITE_ASSISTANT_LIVE=0
```

Для Яндекс.Диска создайте OAuth-приложение в Яндексе, включите доступ к Яндекс.Диску и укажите Redirect URI:

```text
https://cehcrm.ru/api/yandex-disk/oauth/callback/
```

После деплоя откройте `Система -> Яндекс.Диск` и нажмите `Подключить CRM к Яндекс.Диску`.

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
curl -I https://cehcrm.ru
curl https://cehcrm.ru/api/health/
docker compose -f docker-compose.prod.yml logs -f backend
```

## 7. Автодеплой через GitHub Actions

После первого ручного запуска можно включить автоматическое обновление сервера при каждом push в ветку `codex/timeweb-production`.

### 7.1. Создать SSH-ключ для GitHub Actions

На локальном компьютере:

```bash
ssh-keygen -t ed25519 -C "github-actions-crm-timeweb" -f crm_timeweb_deploy_key
```

Публичный ключ нужно добавить на сервер TimeWeb:

```bash
cat crm_timeweb_deploy_key.pub
```

Скопируйте вывод и на сервере добавьте его в `authorized_keys`:

```bash
mkdir -p ~/.ssh
nano ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

Приватный ключ нужно добавить в GitHub Secrets:

```bash
cat crm_timeweb_deploy_key
```

### 7.2. Добавить Secrets в GitHub

Откройте:

`GitHub -> repository -> Settings -> Secrets and variables -> Actions -> New repository secret`

Обязательные секреты:

```text
TIMEWEB_USER=root
TIMEWEB_SSH_KEY=приватный_ssh_ключ_из_crm_timeweb_deploy_key
TELEGRAM_BOT_TOKEN=токен_бота
TELEGRAM_CHAT_ID=ваш_chat_id
```

Необязательные секреты:

```text
TIMEWEB_PORT=22
TIMEWEB_APP_DIR=/opt/crm
```

### 7.3. Уведомления в Telegram

1. Напишите `@BotFather` в Telegram.
2. Создайте бота командой `/newbot`.
3. Скопируйте token бота.
4. Напишите любое сообщение своему новому боту.
5. Откройте в браузере:

```text
https://api.telegram.org/botBOT_TOKEN/getUpdates
```

В ответе найдите `chat.id`.

После этого workflow `.github/workflows/deploy-timeweb.yml` будет:

- запускаться при push в `codex/timeweb-production`;
- собирать Docker-образы backend и nginx на GitHub;
- загружать образы и файлы проекта на TimeWeb через `scp`;
- сохранять серверные `.env` и `backend/secrets`;
- запускать `docker compose --env-file .env -f docker-compose.prod.yml up -d --no-build`;
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
