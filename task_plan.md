# Task Plan (2026-03-01)

## Goals
- Docker deploy on **port 13000**.
- Model registry/config stored **server-side (SQLite)**, not localStorage.
- **No built-in providers/models**; default empty.
- Remove commercial/promotional content.
- Run build + docker build + compose up checks.

## Approach
1. Add `config-api` Node service:
   - SQLite at `/data/config.db` (docker volume).
   - Endpoints:
     - `GET /healthz`
     - `GET /api/config/model-registry`
     - `PUT /api/config/model-registry`
     - `POST /api/config/model-registry/reset`
   - No auth (behind user's reverse proxy basic auth).
   - Request size limit + no logging of secrets.

2. Nginx:
   - Proxy `/api/config/` to `config-api`.
   - Keep existing `/api/media-proxy` proxy to `media-proxy`.

3. Frontend:
   - Make `services/modelRegistry.ts` default state empty.
   - Add remote load/save to config-api.
   - Add `initModelRegistry()` and call it before React render.
   - Ensure UX for empty providers/models.

4. Docker:
   - `docker-compose.yaml`: expose `13000:80`, add `config-api`, mount `./data:/data`.

5. De-commercialize:
   - Remove promotional card from `components/ModelManagerTab.tsx`.
   - Clean README/docs/metadata/index.html links and sales text.

6. Verification:
   - `npm ci && npm run build`
   - `docker compose build && docker compose up -d`
   - Check `http://localhost:13000`.
