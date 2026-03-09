#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PLACEHOLDER_TOKENS = new Set(['changeme', 'change-me', 'replace-me', 'placeholder', 'example', 'sample', 'dummy', 'todo']);

function toIssueCode(issue) {
  return String(issue || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

function getIssueCodes(issues = []) {
  const seen = new Set();
  const codes = [];
  for (const issue of issues) {
    const code = toIssueCode(issue);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

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

function placeholderTokenLoose(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return [...PLACEHOLDER_TOKENS].some((token) => normalized.includes(token));
}

function hasUnsafeSecretWhitespace(value) {
  return /\s/.test(String(value || ''));
}

function hasUnsafeOncallChars(value) {
  return /[\r\n\t]/.test(String(value || ''));
}

function hasOncallWhitespace(value) {
  return /\s/.test(String(value || ''));
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

function isSecretFilePathInvalid(filePath) {
  if (!filePath || String(filePath).trim() === '') return false;
  return !path.isAbsolute(String(filePath).trim());
}

function isSecretFileSymlink(filePath) {
  if (!filePath || String(filePath).trim() === '') return false;
  try {
    return fs.lstatSync(String(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSecretFileTooPermissive(filePath) {
  if (!filePath || String(filePath).trim() === '') return false;
  try {
    const stats = fs.statSync(String(filePath));
    if (!stats.isFile()) return true;
    const mode = stats.mode & 0o777;
    return (mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function isSecretFileWrongOwner(filePath) {
  if (!filePath || String(filePath).trim() === '') return false;
  if (typeof process.getuid !== 'function') return false;
  try {
    const stats = fs.statSync(String(filePath));
    if (!stats.isFile()) return true;
    const currentUid = process.getuid();
    return stats.uid !== currentUid && stats.uid !== 0;
  } catch {
    return false;
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

function hasBothDirectAndFileConfigured(key, env = process.env) {
  const direct = String(env[key] || '').trim();
  const filePath = String(env[`${key}_FILE`] || '').trim();
  return direct !== '' && filePath !== '';
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

function looksLikePlaceholderEscalationUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    return host === 'example.com' || host.endsWith('.example.com');
  } catch {
    return false;
  }
}

function hasEscalationUrlCredentials(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function hasEscalationUrlRootPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.pathname === '/' || parsed.pathname.trim() === '';
  } catch {
    return false;
  }
}

function hasEscalationUrlParamsOrFragment(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return Boolean(parsed.search || parsed.hash);
  } catch {
    return false;
  }
}

function isPrivateOrLocalEscalationHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '0.0.0.0') return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const [a, b] = normalized.split('.').map((segment) => Number(segment));
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 224 || a >= 240) return true;
    return false;
  }

  if (ipVersion === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    return false;
  }

  return false;
}

function isValidDnsHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('..')) return false;
  if (normalized.startsWith('.') || normalized.endsWith('.')) return false;
  const labels = normalized.split('.');
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    return true;
  });
}

function parseAllowedHostEntry(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (!normalized) return null;

  const bracketedIpv6Match = normalized.match(/^\[([a-f0-9:]+)](?::(\d{1,5}))?$/i);
  if (bracketedIpv6Match) {
    const hostPart = bracketedIpv6Match[1];
    const portPart = bracketedIpv6Match[2] || '';
    if (net.isIP(hostPart) !== 6) return null;
    if (portPart) {
      const port = Number(portPart);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    }
    return { host: hostPart, isIp: true, version: 6 };
  }

  const hostPortMatch = normalized.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!hostPortMatch) return null;
  const hostPart = hostPortMatch[1];
  const portPart = hostPortMatch[2] || '';
  if (!hostPart) return null;

  const ipVersion = net.isIP(hostPart);
  if (ipVersion === 0 && !isValidDnsHostname(hostPart)) return null;

  if (portPart) {
    const port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }

  return { host: hostPart, isIp: ipVersion !== 0, version: ipVersion || null };
}

function isValidAllowedHostEntry(host) {
  return parseAllowedHostEntry(host) !== null;
}

function getAllowedHosts(env = process.env) {
  const direct = String(env.ALLOWED_HOSTS || '').trim();
  const fileValue = readSecretFile(env.ALLOWED_HOSTS_FILE);
  const raw = direct || fileValue;
  if (!raw) return [];
  return [...new Set(raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

function evaluateReadiness(env = process.env) {
  const issues = [];

  const configuredToken = getConfiguredAdminToken(env);
  const previousToken = getPreviousAdminToken(env);
  const adminTokenCandidates = getAdminTokenCandidates(env);

  const mutuallyExclusiveEnvFileKeys = [
    'MADE_MY_DAY_ADMIN_TOKEN',
    'MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS',
    'MADE_MY_DAY_ONCALL_PRIMARY',
    'MADE_MY_DAY_ONCALL_SECONDARY',
    'MADE_MY_DAY_ESCALATION_DOC_URL',
    'ALLOWED_HOSTS'
  ];
  mutuallyExclusiveEnvFileKeys.forEach((key) => {
    if (hasBothDirectAndFileConfigured(key, env)) {
      issues.push(`${key} and ${key}_FILE must not both be set`);
    }
  });

  if (!configuredToken) {
    issues.push('MADE_MY_DAY_ADMIN_TOKEN must be set via env or MADE_MY_DAY_ADMIN_TOKEN_FILE for GA readiness');
  }

  for (const token of adminTokenCandidates) {
    if (token.length < 16) {
      issues.push('MADE_MY_DAY admin tokens must be at least 16 characters when set (env or *_FILE)');
      break;
    }
  }

  for (const token of adminTokenCandidates) {
    if (hasUnsafeSecretWhitespace(token)) {
      issues.push('MADE_MY_DAY admin tokens must not contain whitespace characters');
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
  if (placeholderToken(oncallPrimary) || placeholderTokenLoose(oncallPrimary)) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY must not be a placeholder value');
  }
  if (hasUnsafeOncallChars(oncallPrimary)) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY must not contain control characters');
  }
  if (hasOncallWhitespace(oncallPrimary)) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY must not contain whitespace');
  }
  if (oncallPrimary.length > 128) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY must be <= 128 characters');
  }

  const oncallSecondary = getTextConfigValue('MADE_MY_DAY_ONCALL_SECONDARY', env);
  if (oncallSecondary.length < 3) {
    issues.push('MADE_MY_DAY_ONCALL_SECONDARY must be set and at least 3 characters (env or *_FILE)');
  }
  if (placeholderToken(oncallSecondary) || placeholderTokenLoose(oncallSecondary)) {
    issues.push('MADE_MY_DAY_ONCALL_SECONDARY must not be a placeholder value');
  }
  if (hasUnsafeOncallChars(oncallSecondary)) {
    issues.push('MADE_MY_DAY_ONCALL_SECONDARY must not contain control characters');
  }
  if (hasOncallWhitespace(oncallSecondary)) {
    issues.push('MADE_MY_DAY_ONCALL_SECONDARY must not contain whitespace');
  }
  if (oncallSecondary.length > 128) {
    issues.push('MADE_MY_DAY_ONCALL_SECONDARY must be <= 128 characters');
  }
  if (oncallPrimary && oncallSecondary && oncallPrimary.toLowerCase() === oncallSecondary.toLowerCase()) {
    issues.push('MADE_MY_DAY_ONCALL_PRIMARY and MADE_MY_DAY_ONCALL_SECONDARY must not be the same');
  }

  const escalationDocUrl = getTextConfigValue('MADE_MY_DAY_ESCALATION_DOC_URL', env);
  if (!looksLikeHttpsUrl(escalationDocUrl) || looksLikePlaceholderEscalationUrl(escalationDocUrl)) {
    issues.push('MADE_MY_DAY_ESCALATION_DOC_URL must be set to a valid non-placeholder https URL (env or *_FILE)');
  }
  if (hasEscalationUrlCredentials(escalationDocUrl)) {
    issues.push('MADE_MY_DAY_ESCALATION_DOC_URL must not embed username/password credentials');
  }
  if (hasEscalationUrlRootPath(escalationDocUrl)) {
    issues.push('MADE_MY_DAY_ESCALATION_DOC_URL must point to a specific runbook path (not site root)');
  }
  if (hasEscalationUrlParamsOrFragment(escalationDocUrl)) {
    issues.push('MADE_MY_DAY_ESCALATION_DOC_URL must not include query parameters or fragments');
  }
  if (escalationDocUrl) {
    try {
      const parsedEscalationUrl = new URL(escalationDocUrl);
      if (isPrivateOrLocalEscalationHost(parsedEscalationUrl.hostname)) {
        issues.push('MADE_MY_DAY_ESCALATION_DOC_URL must not target localhost/private network hosts');
      }
    } catch {
      // Ignored: invalid URL shape already handled by looksLikeHttpsUrl.
    }
  }

  const allowedHosts = getAllowedHosts(env);
  if (allowedHosts.length > 0) {
    if (allowedHosts.length > 32) {
      issues.push('ALLOWED_HOSTS must include at most 32 entries');
    }

    const invalidAllowedHost = allowedHosts.find((host) => !isValidAllowedHostEntry(host));
    if (invalidAllowedHost) {
      issues.push('ALLOWED_HOSTS must be a comma-separated list of hosts (`host[:port]` or `[ipv6]:port`, port 1-65535)');
    }

    const privateAllowedHost = allowedHosts.find((host) => {
      const parsed = parseAllowedHostEntry(host);
      if (!parsed) return false;
      return isPrivateOrLocalEscalationHost(parsed.host);
    });
    if (privateAllowedHost) {
      issues.push('ALLOWED_HOSTS must not include localhost/private network hosts in GA mode');
    }
  }

  const secretFileKeys = ['MADE_MY_DAY_ADMIN_TOKEN', 'MADE_MY_DAY_ONCALL_PRIMARY', 'MADE_MY_DAY_ONCALL_SECONDARY', 'MADE_MY_DAY_ESCALATION_DOC_URL', 'ALLOWED_HOSTS'];
  secretFileKeys.forEach((key) => {
    const currentFile = env[`${key}_FILE`];
    if (isSecretFilePathInvalid(currentFile)) {
      issues.push(`${key}_FILE must be an absolute path`);
    } else if (hasSecretFileReadError(currentFile)) {
      issues.push(`${key}_FILE could not be read`);
    } else if (isSecretFileSymlink(currentFile)) {
      issues.push(`${key}_FILE must not be a symbolic link`);
    } else if (isSecretFileTooPermissive(currentFile)) {
      issues.push(`${key}_FILE permissions are too open (require chmod 600 owner-only)`);
    } else if (isSecretFileWrongOwner(currentFile)) {
      issues.push(`${key}_FILE must be owned by current runtime user (or root)`);
    }
    const previousFile = env[`${key}_PREVIOUS_FILE`];
    if (isSecretFilePathInvalid(previousFile)) {
      issues.push(`${key}_PREVIOUS_FILE must be an absolute path`);
    } else if (hasSecretFileReadError(previousFile)) {
      issues.push(`${key}_PREVIOUS_FILE could not be read`);
    } else if (isSecretFileSymlink(previousFile)) {
      issues.push(`${key}_PREVIOUS_FILE must not be a symbolic link`);
    } else if (isSecretFileTooPermissive(previousFile)) {
      issues.push(`${key}_PREVIOUS_FILE permissions are too open (require chmod 600 owner-only)`);
    } else if (isSecretFileWrongOwner(previousFile)) {
      issues.push(`${key}_PREVIOUS_FILE must be owned by current runtime user (or root)`);
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
  validateIntegerEnv(env.MAX_QUERY_CHARS, 'MAX_QUERY_CHARS', issues);
  validateIntegerEnv(env.RATE_LIMIT_WINDOW_MS, 'RATE_LIMIT_WINDOW_MS', issues);
  validateIntegerEnv(env.RATE_LIMIT_MAX_MUTATIONS, 'RATE_LIMIT_MAX_MUTATIONS', issues);
  validateIntegerEnv(env.RATE_LIMIT_MAX_KEYS, 'RATE_LIMIT_MAX_KEYS', issues);
  validateIntegerEnv(env.IDEMPOTENCY_TTL_MS, 'IDEMPOTENCY_TTL_MS', issues);
  validateIntegerEnv(env.MAX_IDEMPOTENCY_KEYS, 'MAX_IDEMPOTENCY_KEYS', issues);
  validateIntegerEnv(env.MAX_STORY_CHARS, 'MAX_STORY_CHARS', issues);
  validateIntegerEnv(env.MAX_COMMENT_CHARS, 'MAX_COMMENT_CHARS', issues);
  validateIntegerEnv(env.MAX_COMMENTS_PER_STORY, 'MAX_COMMENTS_PER_STORY', issues);
  validateIntegerEnv(env.MAX_AUTHOR_CHARS, 'MAX_AUTHOR_CHARS', issues);
  validateIntegerEnv(env.REQUEST_TIMEOUT_MS, 'REQUEST_TIMEOUT_MS', issues);
  validateIntegerEnv(env.HEADERS_TIMEOUT_MS, 'HEADERS_TIMEOUT_MS', issues);
  validateIntegerEnv(env.KEEP_ALIVE_TIMEOUT_MS, 'KEEP_ALIVE_TIMEOUT_MS', issues);
  validateIntegerEnv(env.MAX_REQUESTS_PER_SOCKET, 'MAX_REQUESTS_PER_SOCKET', issues);
  validateIntegerEnv(env.MAX_HEADER_BYTES, 'MAX_HEADER_BYTES', issues);
  validateIntegerEnv(env.MAX_HEADERS_COUNT, 'MAX_HEADERS_COUNT', issues);
  validateIntegerEnv(env.BODY_READ_TIMEOUT_MS, 'BODY_READ_TIMEOUT_MS', issues);

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

  const maxQueryChars = parseIntOrDefault(env.MAX_QUERY_CHARS, 1024);
  if (maxQueryChars < 128 || maxQueryChars > 4096) {
    issues.push('MAX_QUERY_CHARS must be between 128 and 4096');
  }

  const maxHeaderBytes = parseIntOrDefault(env.MAX_HEADER_BYTES, 16 * 1024);
  if (maxHeaderBytes < 4096 || maxHeaderBytes > 65536) {
    issues.push('MAX_HEADER_BYTES must be between 4096 and 65536');
  }

  const maxHeadersCount = parseIntOrDefault(env.MAX_HEADERS_COUNT, 200);
  if (maxHeadersCount < 1 || maxHeadersCount > 2000) {
    issues.push('MAX_HEADERS_COUNT must be between 1 and 2000');
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

  const maxCommentsPerStory = parseIntOrDefault(env.MAX_COMMENTS_PER_STORY, 500);
  if (maxCommentsPerStory < 5) issues.push('MAX_COMMENTS_PER_STORY must be >= 5');

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

  const maxRequestsPerSocket = parseIntOrDefault(env.MAX_REQUESTS_PER_SOCKET, 100);
  if (maxRequestsPerSocket < 1 || maxRequestsPerSocket > 1000) {
    issues.push('MAX_REQUESTS_PER_SOCKET must be between 1 and 1000');
  }

  const bodyReadTimeoutMs = parseIntOrDefault(env.BODY_READ_TIMEOUT_MS, 15_000);
  if (bodyReadTimeoutMs < 1_000 || bodyReadTimeoutMs > 120_000) {
    issues.push('BODY_READ_TIMEOUT_MS must be between 1000 and 120000');
  }

  if (headersTimeoutMs > requestTimeoutMs) {
    issues.push('HEADERS_TIMEOUT_MS must be less than or equal to REQUEST_TIMEOUT_MS');
  }

  if (keepAliveTimeoutMs > headersTimeoutMs) {
    issues.push('KEEP_ALIVE_TIMEOUT_MS must be less than or equal to HEADERS_TIMEOUT_MS');
  }

  if ((headersTimeoutMs - keepAliveTimeoutMs) < 1000) {
    issues.push('HEADERS_TIMEOUT_MS must be at least 1000ms greater than KEEP_ALIVE_TIMEOUT_MS');
  }

  return issues;
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const jsonMode = args.has('--json');
  const issues = evaluateReadiness(process.env);

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ready: issues.length === 0,
      issues,
      issueCodes: getIssueCodes(issues),
      checkedAt: new Date().toISOString()
    })}\n`);
  }

  if (issues.length) {
    if (!jsonMode) {
      console.error('made-my-day release readiness: NOT READY');
      for (const issue of issues) {
        console.error(`- ${issue}`);
      }
    }
    process.exit(1);
  }

  if (!jsonMode) {
    console.log('made-my-day release readiness: READY');
  }
}

module.exports = {
  toIssueCode,
  getIssueCodes,
  placeholderSecret,
  parseIntOrDefault,
  readSecretFile,
  hasSecretFileReadError,
  isSecretFileSymlink,
  isSecretFileTooPermissive,
  isSecretFileWrongOwner,
  isSecretFilePathInvalid,
  getConfiguredAdminToken,
  getPreviousAdminToken,
  getAdminTokenCandidates,
  looksLikeHttpsUrl,
  looksLikePlaceholderEscalationUrl,
  isPrivateOrLocalEscalationHost,
  isValidAllowedHostEntry,
  getAllowedHosts,
  evaluateReadiness
};
