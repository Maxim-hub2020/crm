#!/bin/sh
set -e

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "==> Migrate..."
python manage.py migrate --noinput

echo "==> Collect static..."
python manage.py collectstatic --noinput

echo "==> Run daphne ASGI..."
exec daphne -b 0.0.0.0 -p 8000 crm_core.asgi:application
