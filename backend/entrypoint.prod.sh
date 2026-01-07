#!/bin/sh
set -e

echo "==> Migrate..."
python manage.py migrate --noinput

echo "==> Collect static..."
python manage.py collectstatic --noinput

echo "==> Run gunicorn..."
exec gunicorn crm_core.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers 3 \
    --timeout 60
