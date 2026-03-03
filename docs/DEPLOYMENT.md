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

Optional runtime settings:
- `IMPORT_TIMEOUT_MS` (default 10000)
- `TRUST_PROXY=true` when running behind a trusted reverse proxy
- `MADE_MY_DAY_ADMIN_TOKEN_FILE` to load admin token from a mounted secret file

## Verify

```bash
curl -s http://localhost:4300/api/health | jq
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4300/api/health/ready
```

`/api/health/ready` returns:
- `200` when config hardening checks pass
- `503` when required GA config is missing/invalid
