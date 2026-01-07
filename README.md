# CRM Commissions (local)

## Требования
- Docker + Docker Compose
- Node.js 18+ (лучше 20)

## Backend + DB
В корне:
```bash
docker compose up --build -d
docker compose exec backend python manage.py createsuperuser
```

Админка:
http://localhost:8000/admin/

## UI
```bash
cd crm-ui
cp .env.example .env
npm install
npm run dev
```

UI:
http://localhost:5173

## Логика комиссий
- Комиссия начисляется сразу при добавлении платежа type=advance (аванс)
- Период: календарный месяц
- Вариант A:
  - 1–3 продажи в месяце: 5%
  - с 4-й продажи: 8%
- "Продажа" для счётчика = первый аванс по проекту в месяце
- Комиссия начисляется на каждый аванс, но sale_number_in_month увеличивается только на первый аванс проекта в месяце

## API
JWT:
POST /api/auth/token/ {username, password}
GET /api/me/  -> данные текущего пользователя
