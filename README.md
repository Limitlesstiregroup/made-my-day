# Made My Day

Anonymous same-day positive story platform.

## Features
- No account required
- Post same-day stories
- API mutation rate-limit + request-size guardrails for abuse hardening (oversized bodies return clean HTTP 413)
- JSON API hardening: all story mutation endpoints (`POST /api/stories`, `/api/stories/:id/like`, `/api/stories/:id/share`, `/api/stories/:id/comments`) require `Content-Type: application/json` (invalid media type returns HTTP 415)
- Safer IP rate-limit identity: `x-forwarded-for` is only trusted when `TRUST_PROXY=true`
- Admin bearer-token protection for automation endpoints (`POST /api/import/run`, `POST /api/hall-of-fame/run`) when `MADE_MY_DAY_ADMIN_TOKEN`/`MADE_MY_DAY_ADMIN_TOKEN_FILE` is set (minimum 16 chars; placeholder/weak tokens are treated as invalid)
- Automation concurrency hardening: import and hall-of-fame manual triggers return HTTP 409 when a run is already in progress to avoid duplicate writes
- Zero-downtime admin token rotation via `MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS` (or `MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE`) so old and new tokens can overlap during cutover
- Security response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies`)
- Operational health details endpoint for runbook triage (`GET /api/health/details`, requires admin bearer token when admin auth is enabled; preview-open otherwise)
- Duplicate-story protection (7-day normalized text check) + bounded store retention for GA stability
- Like, share, comment
- Conditional GET caching (ETag/304) for stories + hall-of-fame feeds to reduce polling load
- React UI
- Auto-imports 5 real positive stories/hour at random times from public sources (bounded by configurable fetch timeout)
- Weekly Hall of Fame winner (likes + shares + comments)
- Sunday-night score calculation + Monday 6 AM publish
- Winner story pinned to top for 1 week
- $20 gift card queue entry auto-created for each weekly winner

## Run
```bash
cd made-my-day
npm run dev
```
Open `http://localhost:4300`.

Release readiness check:
```bash
npm run release:check
```

## Container Deployment
```bash
docker build -t made-my-day:latest .
docker run --rm -p 4300:4300 made-my-day:latest
```
Detailed runbook: `docs/DEPLOYMENT.md`

## Configuration
- `IMPORT_TIMEOUT_MS` (default `10000`, min `1000`, max `60000`) bounds external source fetch time for hourly imports.
- `MAX_STORY_CHARS` (default `5000`, min `200`) caps accepted story text length after sanitization.
- `MAX_COMMENT_CHARS` (default `300`, min `20`) caps accepted comment text length after sanitization.
- `MAX_AUTHOR_CHARS` (default `60`, min `10`) caps accepted author/display name length after sanitization.
- `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` harden inbound HTTP connection timeouts (defaults: `30000` / `15000` / `5000`).

## API
- `GET /api/health`
- `GET /api/health/ready` (`200` when GA-ready config checks pass, else `503`)
- `GET /api/health/details` (operational totals + import/winner automation snapshot for GA runbooks; requires admin auth when configured)
- `GET /api/stories`
- `POST /api/stories`
- `POST /api/stories/:id/like`
- `POST /api/stories/:id/share`
- `POST /api/stories/:id/comments`
- `POST /api/import/run` (manual trigger)
- `GET /api/hall-of-fame`
- `POST /api/hall-of-fame/run` (manual winner automation trigger)
