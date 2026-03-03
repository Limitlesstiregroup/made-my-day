#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateReadiness } = require('./release-readiness');

try {
  const storiesPath = path.join(process.cwd(), 'data/stories.json');
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
    MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE: tmpPrevTokenFile
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
} catch (err) {
  console.error(`smoke test failed: ${err.message}`);
  process.exit(1);
}

console.log('made-my-day smoke test passed');
