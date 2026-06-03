# Yandex Cloud Migration Notes

## Target baseline
- `Compute Cloud` VM for `backend + nginx`
- `Managed Service for PostgreSQL` for the main database
- `Container Registry` for Docker images
- Optional `Object Storage` for future media growth and backups

## Current app shape
- The frontend is served by Nginx from the same host as the API.
- Nginx proxies `/api` and `/admin` to Django.
- Django static and media files are mounted through Docker volumes.
- Manager commission calculations are disabled in the current product version.

## Recommended first migration path
1. Move PostgreSQL from Docker to Yandex Managed PostgreSQL.
2. Keep the app on one VM first to reduce moving parts.
3. Push Docker images to Yandex Container Registry.
4. Put TLS termination in front of the VM using Yandex Application Load Balancer and Certificate Manager, or terminate TLS on the host if you want to stay simpler at the very beginning.

## Environment values to prepare
- `ALLOWED_HOSTS`
- `CSRF_TRUSTED_ORIGINS`
- `DATABASE_URL`
- `DJANGO_SECRET_KEY`
- `DJANGO_SECURE_SSL_REDIRECT`
- `TIME_ZONE`

## Follow-up work for the next iteration
- Move media from local volume to Object Storage if files become important.
- Add backups and restore instructions.
- Add CI image build and deploy pipeline.
- Add health checks and smoke tests after deploy.
