#!/usr/bin/env node
const fs = require('node:fs');

function placeholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['changeme', 'change-me', 'replace-me', 'placeholder', 'example', 'sample', 'dummy', 'todo'].some((t) => normalized.includes(t));
}

function parseIntOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function readSecretFile(filePath) {
  if (!filePath || String(filePath).trim() === '') return '';
  try {
    return fs.readFileSync(String(filePath), 'utf8').trim();
  } catch {
    return '';
  }
}

function getConfiguredAdminToken(env = process.env) {
  return [
    String(env.MADE_MY_DAY_ADMIN_TOKEN || '').trim(),
    readSecretFile(env.MADE_MY_DAY_ADMIN_TOKEN_FILE)
  ].find(Boolean) || '';
}

function getPreviousAdminToken(env = process.env) {
  return [
    String(env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS || '').trim(),
    readSecretFile(env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE)
  ].find(Boolean) || '';
}

function getAdminTokenCandidates(env = process.env) {
  const values = [
    getConfiguredAdminToken(env),
    getPreviousAdminToken(env)
  ].filter(Boolean);
  return [...new Set(values)];
}

function evaluateReadiness(env = process.env) {
  const issues = [];

  const configuredToken = getConfiguredAdminToken(env);
  const previousToken = getPreviousAdminToken(env);
  const adminTokenCandidates = getAdminTokenCandidates(env);
  for (const token of adminTokenCandidates) {
    if (token.length < 16) {
      issues.push('MADE_MY_DAY admin tokens must be at least 16 characters when set (env or *_FILE)');
      break;
    }
  }

  if (configuredToken && previousToken && configuredToken === previousToken) {
    issues.push('MADE_MY_DAY rotation fallback token must differ from primary admin token');
  }

  for (const token of adminTokenCandidates) {
    if (placeholderSecret(token)) {
      issues.push('MADE_MY_DAY admin tokens must not be placeholder values');
      break;
    }
  }

  const importTimeout = parseIntOrDefault(env.IMPORT_TIMEOUT_MS, 10000);
  if (importTimeout < 1000 || importTimeout > 60000) {
    issues.push('IMPORT_TIMEOUT_MS must be between 1000 and 60000');
  }

  const maxBodyBytes = parseIntOrDefault(env.MAX_BODY_BYTES, 16 * 1024);
  if (maxBodyBytes < 1024 || maxBodyBytes > 256 * 1024) {
    issues.push('MAX_BODY_BYTES must be between 1024 and 262144');
  }

  const maxStoryChars = parseIntOrDefault(env.MAX_STORY_CHARS, 5000);
  if (maxStoryChars < 200) issues.push('MAX_STORY_CHARS must be >= 200');

  const maxCommentChars = parseIntOrDefault(env.MAX_COMMENT_CHARS, 300);
  if (maxCommentChars < 20) issues.push('MAX_COMMENT_CHARS must be >= 20');

  const maxAuthorChars = parseIntOrDefault(env.MAX_AUTHOR_CHARS, 60);
  if (maxAuthorChars < 10) issues.push('MAX_AUTHOR_CHARS must be >= 10');

  const trustProxyRaw = String(env.TRUST_PROXY || '').trim().toLowerCase();
  if (trustProxyRaw && trustProxyRaw !== 'true' && trustProxyRaw !== 'false') {
    issues.push('TRUST_PROXY must be either true or false when set');
  }

  const requestTimeoutMs = parseIntOrDefault(env.REQUEST_TIMEOUT_MS, 30_000);
  if (requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    issues.push('REQUEST_TIMEOUT_MS must be between 1000 and 120000');
  }

  const headersTimeoutMs = parseIntOrDefault(env.HEADERS_TIMEOUT_MS, 15_000);
  if (headersTimeoutMs < 1_000 || headersTimeoutMs > 120_000) {
    issues.push('HEADERS_TIMEOUT_MS must be between 1000 and 120000');
  }

  const keepAliveTimeoutMs = parseIntOrDefault(env.KEEP_ALIVE_TIMEOUT_MS, 5_000);
  if (keepAliveTimeoutMs < 1_000 || keepAliveTimeoutMs > 120_000) {
    issues.push('KEEP_ALIVE_TIMEOUT_MS must be between 1000 and 120000');
  }

  if (headersTimeoutMs > requestTimeoutMs) {
    issues.push('HEADERS_TIMEOUT_MS must be less than or equal to REQUEST_TIMEOUT_MS');
  }

  if (keepAliveTimeoutMs > headersTimeoutMs) {
    issues.push('KEEP_ALIVE_TIMEOUT_MS must be less than or equal to HEADERS_TIMEOUT_MS');
  }

  return issues;
}

if (require.main === module) {
  const issues = evaluateReadiness(process.env);

  if (issues.length) {
    console.error('made-my-day release readiness: NOT READY');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  console.log('made-my-day release readiness: READY');
}

module.exports = {
  placeholderSecret,
  parseIntOrDefault,
  readSecretFile,
  getConfiguredAdminToken,
  getPreviousAdminToken,
  getAdminTokenCandidates,
  evaluateReadiness
};
