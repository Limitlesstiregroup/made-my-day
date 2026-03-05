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
- `MADE_MY_DAY_ONCALL_PRIMARY` (team handle/email/pager alias, >=3 chars)
- `MADE_MY_DAY_ESCALATION_DOC_URL` (https URL to escalation runbook)

Optional runtime settings:
- `IMPORT_TIMEOUT_MS` (default 10000)
- `TRUST_PROXY=true` when running behind a trusted reverse proxy
- `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` for HTTP timeout hardening
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
