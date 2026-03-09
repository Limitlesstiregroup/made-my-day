# Deployment Runbook (Container)

## Build

```bash
docker build -t made-my-day:latest .
```

## Run

```bash
docker run --rm -p 4300:4300 \
  -e MADE_MY_DAY_ADMIN_TOKEN=replace-with-16+chars \
  made-my-day:latest
```

Runtime settings required for GA readiness:
- `MADE_MY_DAY_ADMIN_TOKEN` (or `MADE_MY_DAY_ADMIN_TOKEN_FILE`) (strong token, >=16 chars)
- `MADE_MY_DAY_ONCALL_PRIMARY` (or `MADE_MY_DAY_ONCALL_PRIMARY_FILE`) (team handle/email/pager alias, >=3 chars)
- `MADE_MY_DAY_ONCALL_SECONDARY` (or `MADE_MY_DAY_ONCALL_SECONDARY_FILE`) (backup on-call owner, must differ from primary)
- `MADE_MY_DAY_ESCALATION_DOC_URL` (or `MADE_MY_DAY_ESCALATION_DOC_URL_FILE`) (https URL to escalation runbook)

Optional runtime settings:
- `IMPORT_TIMEOUT_MS` (default 10000)
- `TRUST_PROXY=true` when running behind a trusted reverse proxy
- `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` for HTTP timeout hardening
- `SHUTDOWN_GRACE_MS` (default `10000`, range `1000..120000`) to bound graceful drain time before forced connection close/exit during rollouts
- `BODY_READ_TIMEOUT_MS` (default `15000`, range `1000..120000`) to abort slow/incomplete POST bodies with HTTP 408
- `MAX_REQUESTS_PER_SOCKET` (default `100`, range `1..1000`) to recycle long-lived keep-alive sockets predictably
- `MAX_HEADER_BYTES` (default `16384`) to cap inbound request header size and fail oversized headers with HTTP 431
- `MADE_MY_DAY_ADMIN_TOKEN_FILE` to load admin token from a mounted secret file

## Release Readiness

```bash
npm run release:check
```

## Verify

```bash
curl -s http://localhost:4300/api/health | jq
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4300/api/health/ready
curl -s -H "Authorization: Bearer $MADE_MY_DAY_ADMIN_TOKEN" http://localhost:4300/api/health/details | jq
```

`/api/health/ready` returns:
- `200` when config hardening checks pass
- `503` when required GA config is missing/invalid
