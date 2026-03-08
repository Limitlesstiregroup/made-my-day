# Made My Day

Anonymous same-day positive story platform.

## Features
- No account required
- Post same-day stories
- API mutation rate-limit + request-size guardrails for abuse hardening (oversized bodies return clean HTTP 413)
- Request-target hardening via URL length cap (oversized request URLs return HTTP 414 before routing)
- Content-Length hardening for JSON mutations: conflicting multi-value `Content-Length` headers are rejected with HTTP 400; duplicate matching values are tolerated for proxy interoperability
- Optional host-header allowlist (`ALLOWED_HOSTS`) to mitigate DNS rebinding and misrouted ingress (mismatches return HTTP 421); GA readiness rejects localhost/private-network allowlist entries
- Incoming `Host` header hardening: malformed/control-char/oversized or delimiter-smuggled host headers are rejected with HTTP 421 before routing
- JSON API hardening: story mutations (`POST /api/stories`, `/api/stories/:id/like`, `/api/stories/:id/share`, `/api/stories/:id/comments`) and admin automation triggers (`POST /api/import/run`, `POST /api/hall-of-fame/run`) require `Content-Type: application/json`; malformed JSON returns HTTP 400 and oversized payloads return HTTP 413
- Safer IP rate-limit identity: `x-forwarded-for` is only trusted when `TRUST_PROXY=true`, and only valid IPv4/IPv6 client values are accepted (malformed/oversized forwarded headers are ignored)
- Admin bearer-token protection for automation endpoints (`POST /api/import/run`, `POST /api/hall-of-fame/run`) when `MADE_MY_DAY_ADMIN_TOKEN`/`MADE_MY_DAY_ADMIN_TOKEN_FILE` is set (minimum 16 chars; placeholder/weak tokens are treated as invalid; whitespace characters are rejected to prevent copy/paste auth drift)
- Automation concurrency hardening: import and hall-of-fame manual triggers return HTTP 409 when a run is already in progress to avoid duplicate writes
- Optional idempotent automation retries via `Idempotency-Key` on `POST /api/import/run` and `POST /api/hall-of-fame/run` (returns prior successful response with `idempotent: true` during the idempotency window)
- Zero-downtime admin token rotation via `MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS` (or `MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE`) so old and new tokens can overlap during cutover (rotation fallback token must differ from the primary token)
- Authorization header hardening for admin APIs: duplicate/comma-joined or malformed Bearer headers are rejected with HTTP 400 before token comparison
- Security response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `Content-Security-Policy`, `X-Robots-Tag`, `Strict-Transport-Security`)
- Request tracing header support: responses include `X-Request-Id`, and valid incoming `x-request-id` values (8-128 chars, `[A-Za-z0-9:_-.]`) are echoed for cross-service incident triage
- Mutation rate-limit telemetry is emitted in both RFC 9333 (`RateLimit-*`) and legacy (`X-RateLimit-*`) headers for safer proxy/client interoperability during GA rollouts, including `RateLimit-Policy` (`<limit>;w=<windowSeconds>`) for explicit client backoff behavior
- Operational health details endpoint for runbook triage (`GET /api/health/details`, requires admin bearer token when admin auth is enabled; preview-open otherwise) now includes runtime guard saturation telemetry (`runtimeGuards`) for rate-limit and idempotency capacity monitoring
- Admin exports for weekly operations handoff protected by admin bearer token: paginated JSON (`GET /api/admin/hall-of-fame?limit=&offset=`, `GET /api/admin/gift-cards?limit=&offset=`) plus CSV (`GET /api/admin/hall-of-fame.csv?limit=&offset=`, `GET /api/admin/gift-cards.csv?limit=&offset=`)
- CSV exports are spreadsheet-safe (formula-injection guarded by prefixing risky leading characters)
- Sensitive admin/API responses now send stricter anti-cache headers (`Cache-Control: no-store, private, max-age=0` + `Pragma: no-cache` + `Expires: 0`) plus `Vary: Authorization` to reduce shared-proxy cache leakage risk across bearer-token contexts
- Duplicate-story protection (7-day normalized text check) + bounded store retention for GA stability
- Runtime persistence hardening: stories store writes (including first-boot and corruption recovery paths) use atomic temp-file swaps to reduce corruption risk during crashes/restarts
- Runtime log hygiene: local `*.log` files are ignored and no longer tracked to keep release branches clean between operator runs
- Optional idempotent story creation via `Idempotency-Key` header on `POST /api/stories` (safe client retries without duplicate posts; key must be 8-128 chars using letters/numbers/`:_-.`)
- Optional idempotent engagement retries via `Idempotency-Key` on `POST /api/stories/:id/like`, `/api/stories/:id/share`, and `/api/stories/:id/comments` (returns prior result with `idempotent: true` when replayed inside the idempotency window)
- Like, share, comment
- Conditional GET caching (ETag/304) for stories + hall-of-fame feeds to reduce polling load
- Stories feed pagination (`GET /api/stories?limit=&offset=`) to cap payload size and improve GA polling stability
- Paginated feeds emit RFC 8288 `Link: <...>; rel="next"` headers for safer cursorless polling clients (JSON: `/api/stories`, `/api/hall-of-fame`, `/api/admin/hall-of-fame`, `/api/admin/gift-cards`; CSV exports: `/api/admin/hall-of-fame.csv`, `/api/admin/gift-cards.csv`)
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

Seed local/live config:
```bash
cp .env.example .env
```

Release readiness check:
```bash
npm run release:check
```

Fast GA bootstrap (generates secure local admin token file + `.env.ga.local`):
```bash
npm run ga:quickstart -- --oncall=faisal --escalation-url=https://your-runbook-url
set -a; . ./.env.ga.local; set +a
npm run ga:gate
```

## Container Deployment
```bash
docker build -t made-my-day:latest .
docker run --rm -p 4300:4300 made-my-day:latest
```
Detailed runbook: `docs/DEPLOYMENT.md`

## Configuration
- `IMPORT_TIMEOUT_MS` (default `10000`, min `1000`, max `60000`) bounds external source fetch time for hourly imports.
- `MAX_BODY_BYTES` (default `16384`, min `1024`, max `262144`) caps JSON payload size for mutation/admin POST routes.
- `MAX_URL_CHARS` (default `2048`, min `256`, max `8192`) caps request URL length before routing (oversized URLs return `414`).
- `ALLOWED_HOSTS` (optional comma-separated `host[:port]` or `[ipv6]:port` allowlist, with ports restricted to `1-65535`) rejects mismatched Host headers with `421` when set.
- `MAX_STORY_CHARS` (default `5000`, min `200`) caps accepted story text length after sanitization.
- `MAX_COMMENT_CHARS` (default `300`, min `20`) caps accepted comment text length after sanitization.
- `MAX_COMMENTS_PER_STORY` (default `500`, min `5`) caps comments accepted per story to prevent hotspot abuse from exhausting storage.
- `MAX_AUTHOR_CHARS` (default `60`, min `10`) caps accepted author/display name length after sanitization.
- `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` harden inbound HTTP connection timeouts (defaults: `30000` / `15000` / `5000`, each must stay between `1000` and `120000`; `HEADERS_TIMEOUT_MS <= REQUEST_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS <= HEADERS_TIMEOUT_MS`).
- `MADE_MY_DAY_ONCALL_PRIMARY` (or `MADE_MY_DAY_ONCALL_PRIMARY_FILE`) required on-call owner for GA readiness (team handle/email/pager alias, >=3 chars).
- `MADE_MY_DAY_ESCALATION_DOC_URL` (or `MADE_MY_DAY_ESCALATION_DOC_URL_FILE`) required escalation runbook URL for GA readiness (must be a non-placeholder `https://` URL; `example.com`, `localhost`, and private-network hosts are rejected).
- Secret values loaded via `*_FILE` / `*_PREVIOUS_FILE` must use absolute paths, must not be symbolic links, must be owned by the runtime user (or root), and require owner-only file permissions (`chmod 600`); release readiness fails on relative paths, symlinked/wrong-owner secret files, or when group/world permission bits are set.
- Optional startup guardrail: set `MADE_MY_DAY_ENFORCE_LIVE_READY=1` to fail-fast on boot when readiness checks fail (prevents accidental non-GA config from serving traffic).
- `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_MUTATIONS` tune POST mutation throttling.
- `RATE_LIMIT_MAX_KEYS` (default `10000`, min `1000`, max `200000`) caps in-memory rate-limit IP buckets to stay bounded under spray traffic.
- `IDEMPOTENCY_TTL_MS` (default `86400000`, min `60000`, max `604800000`) keeps idempotency keys valid for safe retry windows.
- `MAX_IDEMPOTENCY_KEYS` (default `5000`, min `100`, max `200000`) bounds persisted idempotency key records.

## API
- `GET|HEAD /api/health`
- `GET|HEAD /api/health/live` (always `200` + process uptime for liveness probes)
- `GET|HEAD /api/health/ready` (`200` when GA-ready config checks pass, else `503`; response includes `checks` and `issueCodes` for quick runbook triage)
- `GET|HEAD /api/health/details` (operational totals + import/winner automation snapshot for GA runbooks; requires admin auth when configured)
- `GET /api/admin/hall-of-fame` (admin-only paginated JSON export)
- `GET /api/admin/hall-of-fame.csv` (admin-only CSV export)
- `GET /api/admin/gift-cards` (admin-only paginated JSON export)
- `GET /api/admin/gift-cards.csv` (admin-only CSV export)
- `GET /api/stories` (`limit` default `100`, max `200`; `offset` default `0`)
- `POST /api/stories`
- `POST /api/stories/:id/like`
- `POST /api/stories/:id/share`
- `POST /api/stories/:id/comments`
- `POST /api/import/run` (manual trigger)
- `GET /api/hall-of-fame` (`limit` default `100`, max `200`; `offset` default `0`)
- `POST /api/hall-of-fame/run` (manual winner automation trigger)
