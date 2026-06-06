# CRM Projects

## Stack
- Django 5 + Django REST Framework + JWT
- Django Channels + Daphne for WebSocket voice assistant
- PostgreSQL 16
- React 18 + Vite + Tailwind
- Docker Compose + Nginx
- Python 3.14 supported

## What the app does now
- Stores projects and client cards
- Stores payments linked to projects
- Supports `admin` and `manager` roles
- Supports Gemini/Vertex voice assistant through backend endpoint `/api/assistant/voice/`
- Does not calculate manager commissions in the current version

## Local run
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

## Frontend dev mode
If you want to run the Vite dev server separately:

```bash
cd crm-ui
cp .env.example .env
npm install
npm run dev
```

UI:
- `http://localhost:5173`

Vite proxies `/api`, `/ws`, `/admin`, `/static`, and `/media` to the backend on `http://localhost:8000`.

## Backend dev mode
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
- `WS /ws/assistant/live/`

## Gemini / Vertex AI Voice Assistant
The stable voice mode records microphone audio in the browser, sends it to Django at `/api/assistant/voice/`, and the backend uses Vertex AI Gemini for transcription, CRM reasoning/tool calls, and speech generation. The browser does not use Web Speech recognition or browser TTS in this mode.

Required backend `.env` values:

```env
GEMINI_BACKEND=vertex_ai
VERTEX_AI_PROJECT_ID=your-google-cloud-project
VERTEX_AI_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=C:/path/to/vertex-sa.json
GEMINI_MODEL=gemini-2.5-flash
GEMINI_AUDIO_MODEL=gemini-2.5-flash
GEMINI_TTS_PROVIDER=cloud_tts
GEMINI_TTS_CLOUD_VOICE=ru-RU-Chirp3-HD-Aoede
GEMINI_TTS_AUDIO_ENCODING=MP3
GEMINI_LIVE_LOCATION=europe-west1
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
GEMINI_LIVE_SILENCE_MS=2000
```

Frontend `.env` values live in `crm-ui/.env`:

```env
VITE_ASSISTANT_LIVE=0
VITE_ASSISTANT_CLIENT_SILENCE_MS=1600
VITE_ASSISTANT_LIVE_RESPONSE_WATCHDOG_MS=14000
VITE_ASSISTANT_LIVE_MAX_UTTERANCE_MS=30000
VITE_ASSISTANT_LIVE_REFRESH_AFTER_TURN=1
VITE_ASSISTANT_STABLE_MAX_UTTERANCE_MS=30000
```

For production, run ASGI, not WSGI. The Docker production entrypoint uses `daphne crm_core.asgi:application`. Gemini Live WebSocket support is still available behind `VITE_ASSISTANT_LIVE=1`, but the default production voice mode is the stable backend voice endpoint.

For faster overview answers, keep CRM snapshots warm with a scheduler:

```bash
python manage.py refresh_crm_memory --force
```

Or run it continuously as a lightweight background worker:

```bash
python manage.py refresh_crm_memory --force --interval 120
```

## Testing
Backend API smoke tests:

```bash
cd backend
python manage.py test crm_app.tests
```

## Production note
The production compose file builds the frontend into the Nginx image, runs Django through Daphne ASGI, keeps PostgreSQL in Docker, and uses Caddy for automatic HTTPS. This is suitable for a first TimeWeb VPS deployment.

TimeWeb deployment guide:
- [docs/timeweb-deploy.md](docs/timeweb-deploy.md)
