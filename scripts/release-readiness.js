#!/usr/bin/env node

function placeholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['changeme', 'change-me', 'replace-me', 'placeholder', 'example', 'sample', 'dummy', 'todo'].some((t) => normalized.includes(t));
}

function parseIntOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

const issues = [];

const token = String(process.env.MADE_MY_DAY_ADMIN_TOKEN || '').trim();
if (token) {
  if (token.length < 16) issues.push('MADE_MY_DAY_ADMIN_TOKEN must be at least 16 characters when set');
  if (placeholderSecret(token)) issues.push('MADE_MY_DAY_ADMIN_TOKEN must not be a placeholder value');
}

const importTimeout = parseIntOrDefault(process.env.IMPORT_TIMEOUT_MS, 10000);
if (importTimeout < 1000 || importTimeout > 60000) {
  issues.push('IMPORT_TIMEOUT_MS must be between 1000 and 60000');
}

const maxStoryChars = parseIntOrDefault(process.env.MAX_STORY_CHARS, 5000);
if (maxStoryChars < 200) issues.push('MAX_STORY_CHARS must be >= 200');

const maxCommentChars = parseIntOrDefault(process.env.MAX_COMMENT_CHARS, 300);
if (maxCommentChars < 20) issues.push('MAX_COMMENT_CHARS must be >= 20');

const maxAuthorChars = parseIntOrDefault(process.env.MAX_AUTHOR_CHARS, 60);
if (maxAuthorChars < 10) issues.push('MAX_AUTHOR_CHARS must be >= 10');

if (issues.length) {
  console.error('made-my-day release readiness: NOT READY');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log('made-my-day release readiness: READY');
