#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateReadiness } = require('./release-readiness');

try {
  const storiesPath = path.join(process.cwd(), 'data/stories.json');
  if (!fs.existsSync(storiesPath)) {
    fs.mkdirSync(path.dirname(storiesPath), { recursive: true });
    fs.writeFileSync(
      storiesPath,
      JSON.stringify({ stories: [], comments: [], hallOfFame: [], pendingWinner: null, giftCards: [], idempotencyKeys: [] }, null, 2)
    );
  }
  const raw = fs.readFileSync(storiesPath, 'utf8');
  const parsed = JSON.parse(raw);
  const stories = Array.isArray(parsed) ? parsed : parsed.stories;
  if (!Array.isArray(stories)) {
    throw new Error('stories.json must be an array or an object with a stories array');
  }

  const tmpTokenFile = path.join(process.cwd(), 'data', `.tmp-admin-token-${Date.now()}`);
  const tmpPrevTokenFile = path.join(process.cwd(), 'data', `.tmp-admin-token-prev-${Date.now()}`);
  fs.writeFileSync(tmpTokenFile, 'admin_token_file_primary_1234\n');
  fs.writeFileSync(tmpPrevTokenFile, 'admin_token_file_previous_5678\n');

  const issuesFromFiles = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_FILE: tmpTokenFile,
    MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE: tmpPrevTokenFile,
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });

  fs.unlinkSync(tmpTokenFile);
  fs.unlinkSync(tmpPrevTokenFile);

  assert.equal(issuesFromFiles.length, 0, 'release readiness should accept admin token *_FILE fallbacks');

  const placeholderIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS: 'change-me-previous-token-1234'
  });
  assert.ok(
    placeholderIssues.includes('MADE_MY_DAY admin tokens must not be placeholder values'),
    'placeholder previous token should fail release readiness'
  );

  const oncallPlaceholderIssues = evaluateReadiness({
    MADE_MY_DAY_ONCALL_PRIMARY: 'todo',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    oncallPlaceholderIssues.includes('MADE_MY_DAY_ONCALL_PRIMARY must not be a placeholder value'),
    'placeholder on-call owner should fail release readiness'
  );

  const maxBodyIssue = evaluateReadiness({ MAX_BODY_BYTES: '512' });
  assert.ok(
    maxBodyIssue.includes('MAX_BODY_BYTES must be between 1024 and 262144'),
    'release readiness should reject too-small MAX_BODY_BYTES'
  );

  const timeoutOrderIssue = evaluateReadiness({ REQUEST_TIMEOUT_MS: '10000', HEADERS_TIMEOUT_MS: '15000' });
  assert.ok(
    timeoutOrderIssue.includes('HEADERS_TIMEOUT_MS must be less than or equal to REQUEST_TIMEOUT_MS'),
    'release readiness should reject headers timeout values above request timeout'
  );

  const keepAliveOrderIssue = evaluateReadiness({ HEADERS_TIMEOUT_MS: '10000', KEEP_ALIVE_TIMEOUT_MS: '15000' });
  assert.ok(
    keepAliveOrderIssue.includes('KEEP_ALIVE_TIMEOUT_MS must be less than or equal to HEADERS_TIMEOUT_MS'),
    'release readiness should reject keep-alive timeout values above headers timeout'
  );

  const idempotencyKeysIssue = evaluateReadiness({ MAX_IDEMPOTENCY_KEYS: '999999' });
  assert.ok(
    idempotencyKeysIssue.includes('MAX_IDEMPOTENCY_KEYS must be between 100 and 200000'),
    'release readiness should reject out-of-range MAX_IDEMPOTENCY_KEYS'
  );

  const nonIntegerIssue = evaluateReadiness({ HEADERS_TIMEOUT_MS: '15000.75' });
  assert.ok(
    nonIntegerIssue.includes('HEADERS_TIMEOUT_MS must be an integer'),
    'release readiness should reject non-integer timeout values'
  );
} catch (err) {
  console.error(`smoke test failed: ${err.message}`);
  process.exit(1);
}

console.log('made-my-day smoke test passed');
