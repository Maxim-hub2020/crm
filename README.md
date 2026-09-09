# CRM Projects

## Stack
- Django 5 + Django REST Framework + JWT
- Daphne ASGI for production HTTP
- PostgreSQL 16
- React 18 + Vite + Tailwind
- Docker Compose + Nginx + Caddy
- Python 3.14 supported

## What The App Does
- Stores projects, clients, tasks, comments, files, bonuses, and project finances.
- Supports kanban/list project views, custom project fields, Yandex.Disk project folders, and Dadata address suggestions.
- Has a `Чаты` module for Chatwoot unified inbox integration settings.
- Separates company data through a workspace/tenant layer.
- Supports `admin` and `manager` roles.
- Includes finance analytics and cash forecast. Gemini/Vertex AI can be used only as an optional finance analytics engine.
- Includes calculator settings and public calculator API.
- The old voice/chat AI module has been removed.

## Local Run
In the repository root:

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec backend python manage.py createsuperuser
```

App:
- `http://localhost/`

Admin:
- `http://localhost/admin/`

## Frontend Dev Mode
If you want to run the Vite dev server separately:

```bash
cd crm-ui
cp .env.example .env
npm install
npm run dev
```

UI:
- `http://localhost:5173`

Vite proxies `/api`, `/admin`, `/static`, and `/media` to the backend on `http://localhost:8000`.

## Backend Dev Mode
If you want to run Django locally without Docker:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

Backend:
- `http://localhost:8000`

## API
- `POST /api/auth/token/`
- `GET /api/me/`
- `GET/POST /api/projects/`
- `GET/POST /api/payments/`
- `GET /api/address-suggestions/`
- `GET/PATCH /api/calculator-settings/`
- `GET/POST /api/calculator-quotes/`
- `DELETE /api/calculator-quotes/<quote_id>/`
- `GET/PATCH /api/yandex-disk/settings/`
- `POST /api/finance-analytics/ai/`
- `POST /api/cash-forecast/ai/`

## Integrations
Dadata address suggestions are proxied through Django at `/api/address-suggestions/`, so the token must stay in backend `.env` as `DADATA_API_KEY`; it is not a frontend `VITE_*` key.

Gemini/Vertex AI is optional and used for finance analytics/cash forecast only:

```env
GEMINI_BACKEND=vertex_ai
VERTEX_AI_PROJECT_ID=your-google-cloud-project
VERTEX_AI_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/vertex-sa.json
GEMINI_MODEL=gemini-2.5-flash
GEMINI_FAST_MODEL=gemini-2.5-flash-lite
DADATA_API_KEY=
DADATA_DEFAULT_REGION=Ростовская область
```

## Testing
Backend tests:

```bash
cd backend
python manage.py test crm_app.tests
```

Frontend build:

```bash
cd crm-ui
npm run build
```

## Production Note
The production compose file builds the frontend into the Nginx image, runs Django through Daphne ASGI, keeps PostgreSQL in Docker, and uses Caddy for automatic HTTPS. This is suitable for a first TimeWeb VPS deployment.

TimeWeb deployment guide:
- [docs/timeweb-deploy.md](docs/timeweb-deploy.md)

Chatwoot chats integration:
- [docs/chatwoot-integration.md](docs/chatwoot-integration.md)
