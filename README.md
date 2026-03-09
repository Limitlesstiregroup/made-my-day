# Made My Day

Anonymous same-day positive story platform.

## Features
- No account required
- Post same-day stories
- API mutation rate-limit + request-size guardrails for abuse hardening (oversized bodies return clean HTTP 413)
- Request body read-time hardening via `BODY_READ_TIMEOUT_MS` (default `15000`): slow/incomplete JSON uploads are aborted with HTTP 408 to reduce slowloris-style pressure
- Request-target hardening via URL length cap (oversized request URLs return HTTP 414 before routing)
- Query-string hardening via query length cap (`MAX_QUERY_CHARS`, default `1024`): oversized query strings return HTTP 414 before route handling
- Header-flood hardening via max request-header size cap (`MAX_HEADER_BYTES`, default `16384`): oversized headers are rejected at parser level with HTTP 431 (`Request Header Fields Too Large`)
- Keep-alive socket churn hardening via per-socket request cap (`MAX_REQUESTS_PER_SOCKET`, default `100`): sockets are recycled after bounded request counts to reduce long-lived abuse risk
- Header-count hardening via max header count cap (`MAX_HEADERS_COUNT`, default `200`): connections with excessive header field counts are rejected at parser level to reduce header-flood pressure
- Request correlation hardening: `x-request-id` must be a single token (`8-128` chars, `[a-zA-Z0-9:_-.]`); malformed, duplicate, or comma-joined values are rejected with HTTP 400 (`invalid x-request-id header`) to avoid log correlation ambiguity
- Request-target form hardening: absolute-form request targets (`GET http://...`) are rejected with HTTP 400 (`origin-form request-target required`) to reduce proxy/request-routing ambiguity
- Method-override hardening: requests carrying `x-http-method-override` are rejected with HTTP 400 (`x-http-method-override header is not allowed`) to prevent proxy/client verb-tunneling bypasses
- `Expect` header hardening: requests carrying `Expect` are rejected with HTTP 417 (`expect header is not allowed`) to reduce parser/state-machine ambiguity from `100-continue` flows
- Protocol-upgrade hardening: requests carrying `Upgrade` are rejected with HTTP 400 (`upgrade header is not allowed`) to reduce unsupported protocol-switch attack surface
- Legacy proxy-tunnel hardening: requests carrying `Proxy-Connection` are rejected with HTTP 400 (`proxy-connection header is not allowed`) to reduce ambiguous intermediary behavior
- Path-override header hardening: requests carrying `X-Original-URL` or `X-Rewrite-URL` are rejected with HTTP 400 (`path override headers are not allowed`) to prevent intermediary path-rewrite header abuse
- TE header hardening: requests carrying `TE` are rejected with HTTP 400 (`te header is not allowed`) to reduce request-smuggling ambiguity from hop-by-hop transfer-coding negotiation
- Connection header hardening: requests carrying `Connection` tokens beyond `keep-alive`/`close` are rejected with HTTP 400 (`connection header contains unsupported tokens`) to prevent hop-by-hop header confusion through intermediaries
- HTTP verb hardening: `TRACE` requests are rejected with HTTP 405 + `Allow` (`GET, HEAD, POST`) to close reflective diagnostic surface area
- Static asset method hardening: `/`, `/index.html`, `/app.js`, and `/styles.css` enforce `GET|HEAD` with HTTP 405 + `Allow` for non-safe methods
- Content-Length hardening: conflicting multi-value `Content-Length` headers are rejected with HTTP 400; duplicate matching values are tolerated for proxy interoperability
- Content-Encoding hardening for JSON mutation/admin POST APIs: `Content-Encoding` must be omitted or `identity`; compressed/unsupported encodings are rejected with HTTP 415
- Request-smuggling hardening: requests carrying both `Transfer-Encoding` and `Content-Length` are rejected with HTTP 400 (`ambiguous request framing`) before route handling
- Optional host-header allowlist (`ALLOWED_HOSTS` or `ALLOWED_HOSTS_FILE`) to mitigate DNS rebinding and misrouted ingress (mismatches return HTTP 421); GA readiness rejects localhost/private-network allowlist entries and caps allowlist size at 32 entries
- Incoming `Host` header hardening: duplicate `Host` headers are rejected with HTTP 400, malformed/control-char/oversized or delimiter-smuggled host headers are rejected with HTTP 421 before routing, forwarding headers (`X-Forwarded-For`, `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port`) are rejected with HTTP 400 unless `TRUST_PROXY=true`, and multi-hop/duplicate forwarding headers are rejected with HTTP 400 when trusted proxy mode is enabled (with strict `host[:port]` validation for `X-Forwarded-Host`, strict `http|https` validation for `X-Forwarded-Proto`, and strict numeric `1-65535` validation for `X-Forwarded-Port`) to prevent ambiguous upstream attribution
- JSON API hardening: story mutations (`POST /api/stories`, `/api/stories/:id/like`, `/api/stories/:id/share`, `/api/stories/:id/comments`) and admin automation triggers (`POST /api/import/run`, `POST /api/hall-of-fame/run`) require a single strict JSON content type (`Content-Type: application/json` with optional `charset=utf-8`; duplicate/comma-joined values, malformed params, or non-UTF-8 charsets return HTTP 400/415); malformed JSON returns HTTP 400 and oversized payloads return HTTP 413
- Safer IP rate-limit identity: forwarded proxy identity is trusted only when `TRUST_PROXY=true`; parser accepts only valid IPv4/IPv6 client values from `X-Forwarded-For` (first hop) and RFC 7239 `Forwarded` (`for=`), ignoring malformed/oversized headers
- Admin bearer-token protection for automation endpoints (`POST /api/import/run`, `POST /api/hall-of-fame/run`) when `MADE_MY_DAY_ADMIN_TOKEN`/`MADE_MY_DAY_ADMIN_TOKEN_FILE` is set (minimum 16 chars; placeholder/weak tokens are treated as invalid; whitespace characters are rejected to prevent copy/paste auth drift)
- Unauthorized admin responses include `WWW-Authenticate: Bearer realm="made-my-day"` for standards-compliant client challenge handling
- Automation concurrency hardening: import and hall-of-fame manual triggers return HTTP 409 when a run is already in progress to avoid duplicate writes
- Optional idempotent automation retries via `Idempotency-Key` on `POST /api/import/run` and `POST /api/hall-of-fame/run` (returns prior successful response with `idempotent: true` during the idempotency window); malformed/ambiguous keys are rejected with HTTP 400 (`invalid idempotency-key header`)
- Zero-downtime admin token rotation via `MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS` (or `MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE`) so old and new tokens can overlap during cutover (rotation fallback token must differ from the primary token)
- Authorization header hardening for admin APIs: duplicate/comma-joined or malformed Bearer headers are rejected with HTTP 400 before token comparison
- Security response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `Content-Security-Policy`, `X-Robots-Tag`, `Strict-Transport-Security`)
- Request tracing header support: responses include `X-Request-Id`, and valid incoming `x-request-id` values (8-128 chars, `[A-Za-z0-9:_-.]`) are echoed for cross-service incident triage
- Mutation rate-limit telemetry is emitted in both RFC 9333 (`RateLimit-*`) and legacy (`X-RateLimit-*`) headers for safer proxy/client interoperability during GA rollouts, including `RateLimit-Policy` (`<limit>;w=<windowSeconds>`) for explicit client backoff behavior
- Operational health details endpoint for runbook triage (`GET /api/health/details`, requires admin bearer token when admin auth is enabled; preview-open otherwise) now includes runtime guard saturation telemetry (`runtimeGuards`) for rate-limit/idempotency capacity monitoring plus on-call/escalation snapshot (`escalation`) for pager handoff context; optional `windowHours` query adds recent activity counts for stories/comments/hall-of-fame/gift-cards
- Admin exports for weekly operations handoff protected by admin bearer token: paginated JSON (`GET /api/admin/hall-of-fame?limit=&offset=`, `GET /api/admin/gift-cards?limit=&offset=`) plus CSV (`GET /api/admin/hall-of-fame.csv?limit=&offset=`, `GET /api/admin/gift-cards.csv?limit=&offset=`)
- CSV exports are spreadsheet-safe (formula-injection guarded by prefixing risky leading characters)
- Sensitive admin/API responses now send stricter anti-cache headers (`Cache-Control: no-store, private, max-age=0` + `Pragma: no-cache` + `Expires: 0`) plus `Vary: Authorization` to reduce shared-proxy cache leakage risk across bearer-token contexts
- Duplicate-story protection (7-day normalized text check) + bounded store retention for GA stability; duplicate submissions return HTTP 409 with `Retry-After` guidance for safer client retries
- Runtime persistence hardening: stories store writes (including first-boot and corruption recovery paths) use atomic temp-file swaps to reduce corruption risk during crashes/restarts; idempotency cache writes maintain a `.bak` fallback snapshot for restart-time corruption recovery and are force-flushed during shutdown/exit hooks for safer abrupt-restart behavior
- Runtime log hygiene: local `*.log` files are ignored and no longer tracked to keep release branches clean between operator runs
- Optional idempotent story creation via `Idempotency-Key` header on `POST /api/stories` (safe client retries without duplicate posts; key must be 8-128 chars using letters/numbers/`:_-.`; malformed/ambiguous keys are rejected with HTTP 400 `invalid idempotency-key header`)
- Optional idempotent engagement retries via `Idempotency-Key` on `POST /api/stories/:id/like`, `/api/stories/:id/share`, and `/api/stories/:id/comments` (returns prior result with `idempotent: true` when replayed inside the idempotency window; malformed/ambiguous keys are rejected with HTTP 400 `invalid idempotency-key header`)
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
npm run release:check -- --json
```
(`--json` emits machine-readable `ready` + `issueCodes` output for CI/deploy gates; command exits non-zero until readiness issues are resolved.)

Fast GA bootstrap (generates secure local admin token file + `.env.ga.local`):
```bash
npm run ga:quickstart -- --oncall-primary=faisal --oncall-secondary=backup --escalation-url=https://your-runbook-url
set -a; . ./.env.ga.local; set +a
npm run ga:gate
```
Or run the same GA gate with local GA env auto-loaded:
```bash
npm run ga:gate:local
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
- `BODY_READ_TIMEOUT_MS` (default `15000`, min `1000`, max `120000`) bounds how long the server waits for POST request bodies before returning HTTP 408.
- `MAX_URL_CHARS` (default `2048`, min `256`, max `8192`) caps request URL length before routing (oversized URLs return `414`).
- `MAX_QUERY_CHARS` (default `1024`, min `128`, max `4096`) caps query-string length before route handling (oversized queries return `414`).
- `MAX_HEADER_BYTES` (default `16384`, min `4096`, max `65536`) caps HTTP request header bytes at parser level (oversized headers return `431`).
- `ALLOWED_HOSTS` / `ALLOWED_HOSTS_FILE` (optional comma-separated `host[:port]` or `[ipv6]:port` allowlist, with ports restricted to `1-65535`) rejects mismatched Host headers with `421` when set.
- `MAX_STORY_CHARS` (default `5000`, min `200`) caps accepted story text length after sanitization.
- `MAX_COMMENT_CHARS` (default `300`, min `20`) caps accepted comment text length after sanitization.
- `MAX_COMMENTS_PER_STORY` (default `500`, min `5`) caps comments accepted per story to prevent hotspot abuse from exhausting storage.
- `MAX_AUTHOR_CHARS` (default `60`, min `10`) caps accepted author/display name length after sanitization.
- `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` harden inbound HTTP connection timeouts (defaults: `30000` / `15000` / `5000`, each must stay between `1000` and `120000`; `HEADERS_TIMEOUT_MS <= REQUEST_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS <= HEADERS_TIMEOUT_MS`).
- `MAX_REQUESTS_PER_SOCKET` caps keep-alive reuse per socket (default `100`, min `1`, max `1000`).
- `MADE_MY_DAY_ONCALL_PRIMARY` (or `MADE_MY_DAY_ONCALL_PRIMARY_FILE`) required on-call owner for GA readiness (team handle/email/pager alias, >=3 chars; control characters rejected).
- `MADE_MY_DAY_ONCALL_SECONDARY` (or `MADE_MY_DAY_ONCALL_SECONDARY_FILE`) required backup on-call owner for GA readiness (must differ from primary; control characters rejected).
- `MADE_MY_DAY_ESCALATION_DOC_URL` (or `MADE_MY_DAY_ESCALATION_DOC_URL_FILE`) required escalation runbook URL for GA readiness (must be a non-placeholder `https://` URL pointing to a specific runbook path, without embedded username/password credentials, and without query parameters/fragments; `example.com`, `localhost`, and private-network hosts are rejected).
- Secret values loaded via `*_FILE` / `*_PREVIOUS_FILE` must use absolute paths, must not be symbolic links, must be owned by the runtime user (or root), and require owner-only file permissions (`chmod 600`); release readiness fails on relative paths, symlinked/wrong-owner secret files, or when group/world permission bits are set.
- Optional startup guardrail: set `MADE_MY_DAY_ENFORCE_LIVE_READY=1` to fail-fast on boot when readiness checks fail (prevents accidental non-GA config from serving traffic).
- `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_MUTATIONS` tune POST mutation throttling.
- `RATE_LIMIT_MAX_KEYS` (default `10000`, min `1000`, max `200000`) caps in-memory rate-limit IP buckets to stay bounded under spray traffic.
- `IDEMPOTENCY_TTL_MS` (default `86400000`, min `60000`, max `604800000`) keeps idempotency keys valid for safe retry windows.
- `MAX_IDEMPOTENCY_KEYS` (default `5000`, min `100`, max `200000`) bounds persisted idempotency key records.
- `IDEMPOTENCY_CACHE_FILE` (default `data/idempotency-cache.json`) stores admin-run + engagement idempotency caches so successful mutation retries remain idempotent after process restarts.

## API
- `GET|HEAD /api/health`
- `GET|HEAD /api/health/live` (always `200` + process uptime for liveness probes)
- `GET|HEAD /api/health/version` (deploy identity snapshot with app version + optional `MADE_MY_DAY_GIT_SHA`/`GIT_COMMIT_SHA` + `MADE_MY_DAY_BUILD_ID` + optional `MADE_MY_DAY_INSTANCE_ID`/`HOSTNAME`, plus runtime `nodeVersion`, process `startedAt`, and `uptimeSeconds` for GA incident triage)
- `GET|HEAD /api/health/ready` (`200` when GA-ready config checks pass, else `503`; `503` responses include `Retry-After: 30` for safer probe/client backoff; response includes `checkedAt`, `checks`, and `issueCodes` for quick runbook triage)
- `GET|HEAD /api/health/details` (operational totals + import/winner automation snapshot + on-call/escalation snapshot for GA runbooks; requires admin auth when configured)
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
