# Деплой CRM на TimeWeb VPS

Инструкция рассчитана на VPS с Ubuntu 22.04/24.04, Docker Compose и доменом. Production-контур использует Caddy для автоматического HTTPS.

## 1. Подготовить домен
1. В DNS домена создайте `A`-запись на IP сервера TimeWeb.
2. Дождитесь обновления DNS.
3. Откройте на сервере порты `80` и `443`.

Проверка DNS:

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
DADATA_API_KEY=ваш_dadata_api_key
DADATA_DEFAULT_REGION=Ростовская область
YANDEX_DISK_CLIENT_ID=client_id_приложения_яндекса
YANDEX_DISK_CLIENT_SECRET=client_secret_приложения_яндекса
YANDEX_DISK_REDIRECT_URI=https://oauth.yandex.ru/verification_code
```

Сгенерировать секрет Django можно так:

```bash
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(64))
PY
```

## 5. Подключить Яндекс.Диск
Создайте OAuth-приложение в Яндексе, включите доступ к Яндекс.Диску и используйте Redirect URI:

```text
https://oauth.yandex.ru/verification_code
```

После деплоя откройте `Система -> Яндекс.Диск`, нажмите `Подключить CRM к Яндекс.Диску`, скопируйте код Яндекса в CRM и сохраните доступ.

## 6. Запустить production

```bash
docker compose -p crm --env-file .env -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -p crm --env-file .env -f docker-compose.prod.yml ps
```

Создать администратора:

```bash
docker compose -p crm --env-file .env -f docker-compose.prod.yml exec backend python manage.py createsuperuser
```

Проверки:

```bash
curl -I https://cehcrm.ru
curl https://cehcrm.ru/api/health/
docker compose -p crm --env-file .env -f docker-compose.prod.yml logs -f backend
```

## 7. Автодеплой через GitHub Actions
Workflow `.github/workflows/deploy-timeweb.yml` запускается при push в `codex/timeweb-production`.

Обязательные GitHub Secrets:

```text
TIMEWEB_USER=root
TIMEWEB_SSH_KEY=приватный_ssh_ключ
TELEGRAM_BOT_TOKEN=токен_бота
TELEGRAM_CHAT_ID=ваш_chat_id
```

Необязательные:

```text
TIMEWEB_PORT=22
```

Workflow собирает Docker-образы на GitHub, загружает архивы на TimeWeb, сохраняет серверный `.env`, затем запускает `db`, `backend`, `nginx` и `caddy`.

## 8. Ручное обновление

```bash
cd /opt/crm
git checkout codex/timeweb-production
git pull --ff-only
docker compose -p crm --env-file .env -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -p crm --env-file .env -f docker-compose.prod.yml ps
```

## 9. Бэкап базы

```bash
mkdir -p backups
docker compose -p crm --env-file .env -f docker-compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/crm-$(date +%F-%H%M).sql
```

Восстановление:

```bash
cat backups/crm-YYYY-MM-DD-HHMM.sql | docker compose -p crm --env-file .env -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

## 10. Полезные команды

```bash
docker compose -p crm --env-file .env -f docker-compose.prod.yml logs -f caddy nginx backend
docker compose -p crm --env-file .env -f docker-compose.prod.yml restart backend
docker compose -p crm --env-file .env -f docker-compose.prod.yml down
```

Не удаляйте volumes базы без свежего бэкапа:

```bash
docker compose -p crm --env-file .env -f docker-compose.prod.yml down -v
```

## Важные замечания
- Не коммитьте `.env` в GitHub.
- Если TimeWeb firewall включен, разрешите входящие `80/tcp` и `443/tcp`.
- Если домен ещё не направлен на сервер, Caddy не сможет получить сертификат.
