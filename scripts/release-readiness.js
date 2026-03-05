#!/usr/bin/env node
const fs = require('node:fs');

const PLACEHOLDER_TOKENS = new Set(['changeme', 'change-me', 'replace-me', 'placeholder', 'example', 'sample', 'dummy', 'todo']);

function placeholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return [...PLACEHOLDER_TOKENS].some((t) => normalized.includes(t));
}

function placeholderToken(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return PLACEHOLDER_TOKENS.has(normalized);
}

function parseIntOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function isUnset(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function validateIntegerEnv(value, label, issues) {
  if (isUnset(value)) return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    issues.push(`${label} must be an integer`);
  }
}

function readSecretFile(filePath) {
  if (!filePath || String(filePath).trim() === '') return '';
  try {
    return fs.readFileSync(String(filePath), 'utf8').trim();
  } catch {
    return '';
  }
}

function hasSecretFileReadError(filePath) {
  if (!filePath || String(filePath).trim() === '') return false;
  try {
    fs.readFileSync(String(filePath), 'utf8');
    return false;
  } catch {
    return true;
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

function getTextConfigValue(key, env = process.env) {
  return [
    String(env[key] || '').trim(),
    readSecretFile(env[`${key}_FILE`])
  ].find(Boolean) || '';
}

function looksLikeHttpsUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
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

  const oncallPrimary = getTextConfigValue('MADE_MY_DAY_ONCALL_PRIMARY', env);
  if (oncallPrimary.length < 3) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY must be set and at least 3 characters (env or *_FILE)');
  }
  if (placeholderToken(oncallPrimary)) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY must not be a placeholder value');
  }

  const escalationDocUrl = getTextConfigValue('MADE_MY_DAY_ESCALATION_DOC_URL', env);
  if (!looksLikeHttpsUrl(escalationDocUrl)) {
    issues.push('MADE_MY_DAY_ESCALATION_DOC_URL must be set to a valid https URL (env or *_FILE)');
  }

  const secretFileKeys = ['MADE_MY_DAY_ADMIN_TOKEN', 'MADE_MY_DAY_ONCALL_PRIMARY', 'MADE_MY_DAY_ESCALATION_DOC_URL'];
  secretFileKeys.forEach((key) => {
    if (hasSecretFileReadError(env[`${key}_FILE`])) {
      issues.push(`${key}_FILE could not be read`);
    }
    if (hasSecretFileReadError(env[`${key}_PREVIOUS_FILE`])) {
      issues.push(`${key}_PREVIOUS_FILE could not be read`);
    }
  });

  for (const token of adminTokenCandidates) {
    if (placeholderSecret(token)) {
      issues.push('MADE_MY_DAY admin tokens must not be placeholder values');
      break;
    }
  }

  validateIntegerEnv(env.IMPORT_TIMEOUT_MS, 'IMPORT_TIMEOUT_MS', issues);
  validateIntegerEnv(env.MAX_BODY_BYTES, 'MAX_BODY_BYTES', issues);
  validateIntegerEnv(env.MAX_URL_CHARS, 'MAX_URL_CHARS', issues);
  validateIntegerEnv(env.RATE_LIMIT_WINDOW_MS, 'RATE_LIMIT_WINDOW_MS', issues);
  validateIntegerEnv(env.RATE_LIMIT_MAX_MUTATIONS, 'RATE_LIMIT_MAX_MUTATIONS', issues);
  validateIntegerEnv(env.RATE_LIMIT_MAX_KEYS, 'RATE_LIMIT_MAX_KEYS', issues);
  validateIntegerEnv(env.IDEMPOTENCY_TTL_MS, 'IDEMPOTENCY_TTL_MS', issues);
  validateIntegerEnv(env.MAX_IDEMPOTENCY_KEYS, 'MAX_IDEMPOTENCY_KEYS', issues);
  validateIntegerEnv(env.MAX_STORY_CHARS, 'MAX_STORY_CHARS', issues);
  validateIntegerEnv(env.MAX_COMMENT_CHARS, 'MAX_COMMENT_CHARS', issues);
  validateIntegerEnv(env.MAX_AUTHOR_CHARS, 'MAX_AUTHOR_CHARS', issues);
  validateIntegerEnv(env.REQUEST_TIMEOUT_MS, 'REQUEST_TIMEOUT_MS', issues);
  validateIntegerEnv(env.HEADERS_TIMEOUT_MS, 'HEADERS_TIMEOUT_MS', issues);
  validateIntegerEnv(env.KEEP_ALIVE_TIMEOUT_MS, 'KEEP_ALIVE_TIMEOUT_MS', issues);

  const importTimeout = parseIntOrDefault(env.IMPORT_TIMEOUT_MS, 10000);
  if (importTimeout < 1000 || importTimeout > 60000) {
    issues.push('IMPORT_TIMEOUT_MS must be between 1000 and 60000');
  }

  const maxBodyBytes = parseIntOrDefault(env.MAX_BODY_BYTES, 16 * 1024);
  if (maxBodyBytes < 1024 || maxBodyBytes > 256 * 1024) {
    issues.push('MAX_BODY_BYTES must be between 1024 and 262144');
  }

  const maxUrlChars = parseIntOrDefault(env.MAX_URL_CHARS, 2048);
  if (maxUrlChars < 256 || maxUrlChars > 8192) {
    issues.push('MAX_URL_CHARS must be between 256 and 8192');
  }

  const rateLimitWindowMs = parseIntOrDefault(env.RATE_LIMIT_WINDOW_MS, 60_000);
  if (rateLimitWindowMs < 1_000 || rateLimitWindowMs > 3_600_000) {
    issues.push('RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000');
  }

  const rateLimitMaxMutations = parseIntOrDefault(env.RATE_LIMIT_MAX_MUTATIONS, 120);
  if (rateLimitMaxMutations < 10 || rateLimitMaxMutations > 10000) {
    issues.push('RATE_LIMIT_MAX_MUTATIONS must be between 10 and 10000');
  }

  const rateLimitMaxKeys = parseIntOrDefault(env.RATE_LIMIT_MAX_KEYS, 10000);
  if (rateLimitMaxKeys < 1000 || rateLimitMaxKeys > 200000) {
    issues.push('RATE_LIMIT_MAX_KEYS must be between 1000 and 200000');
  }

  const idempotencyTtlMs = parseIntOrDefault(env.IDEMPOTENCY_TTL_MS, 86_400_000);
  if (idempotencyTtlMs < 60_000 || idempotencyTtlMs > 604_800_000) {
    issues.push('IDEMPOTENCY_TTL_MS must be between 60000 and 604800000');
  }

  const maxIdempotencyKeys = parseIntOrDefault(env.MAX_IDEMPOTENCY_KEYS, 5000);
  if (maxIdempotencyKeys < 100 || maxIdempotencyKeys > 200000) {
    issues.push('MAX_IDEMPOTENCY_KEYS must be between 100 and 200000');
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
  hasSecretFileReadError,
  getConfiguredAdminToken,
  getPreviousAdminToken,
  getAdminTokenCandidates,
  looksLikeHttpsUrl,
  evaluateReadiness
};
