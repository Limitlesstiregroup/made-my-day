# Made My Day

Anonymous same-day positive story platform.

## Features
- No account required
- Post same-day stories
- API mutation rate-limit + request-size guardrails for abuse hardening (oversized bodies return clean HTTP 413)
- Safer IP rate-limit identity: `x-forwarded-for` is only trusted when `TRUST_PROXY=true`
- Admin bearer-token protection for automation endpoints (`POST /api/import/run`, `POST /api/hall-of-fame/run`) when `MADE_MY_DAY_ADMIN_TOKEN` is set (minimum 16 chars; weak tokens are treated as invalid)
- Security response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`)
- Duplicate-story protection (7-day normalized text check) + bounded store retention for GA stability
- Like, share, comment
- Conditional GET caching (ETag/304) for stories + hall-of-fame feeds to reduce polling load
- React UI
- Auto-imports 5 real positive stories/hour at random times from public sources
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

## API
- `GET /api/health`
- `GET /api/stories`
- `POST /api/stories`
- `POST /api/stories/:id/like`
- `POST /api/stories/:id/share`
- `POST /api/stories/:id/comments`
- `POST /api/import/run` (manual trigger)
- `GET /api/hall-of-fame`
- `POST /api/hall-of-fame/run` (manual winner automation trigger)
