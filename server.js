const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { URL } = require('url');
const packageMeta = require('./package.json');

const PORT = Number(process.env.PORT || 4300);
const DATA_DIR = path.join(__dirname, 'data');
const MAX_SECRET_FILE_BYTES = 8 * 1024;
const STORE_FILE = path.join(DATA_DIR, 'stories.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function getCorruptSnapshotLimit() {
  const raw = Number(process.env.MADE_MY_DAY_CORRUPT_SNAPSHOT_LIMIT || 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(25, Math.floor(raw)));
}

function snapshotCorruptStoreFile(filePath) {
  const badCopy = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.copyFileSync(filePath, badCopy);
  } catch {
    return;
  }

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const prefix = `${baseName}.corrupt-`;

  try {
    const snapshots = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    const maxSnapshots = getCorruptSnapshotLimit();
    const excess = snapshots.length - maxSnapshots;
    if (excess > 0) {
      snapshots.slice(0, excess).forEach((name) => {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // Ignore best-effort cleanup failures.
        }
      });
    }
  } catch {
    // Ignore cleanup failures.
  }
}
function clampMaxBodyBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 16 * 1024;
  const normalized = Math.floor(parsed);
  if (normalized < 1024) return 1024;
  if (normalized > 256 * 1024) return 256 * 1024;
  return normalized;
}

const MAX_BODY_BYTES = clampMaxBodyBytes(process.env.MAX_BODY_BYTES);
const BODY_READ_TIMEOUT_MS = Number.isFinite(Number(process.env.BODY_READ_TIMEOUT_MS))
  ? Math.floor(Math.max(1_000, Math.min(Number(process.env.BODY_READ_TIMEOUT_MS), 120_000)))
  : 15_000;
const MAX_URL_CHARS = Number.isFinite(Number(process.env.MAX_URL_CHARS))
  ? Math.floor(Math.max(256, Math.min(Number(process.env.MAX_URL_CHARS), 8192)))
  : 2048;
const MAX_HEADER_BYTES = Number.isFinite(Number(process.env.MAX_HEADER_BYTES))
  ? Math.floor(Math.max(4096, Math.min(Number(process.env.MAX_HEADER_BYTES), 65536)))
  : 16 * 1024;
const MAX_QUERY_CHARS = Number.isFinite(Number(process.env.MAX_QUERY_CHARS))
  ? Math.floor(Math.max(128, Math.min(Number(process.env.MAX_QUERY_CHARS), 4096)))
  : 1024;
const MAX_REQUESTS_PER_SOCKET = Number.isFinite(Number(process.env.MAX_REQUESTS_PER_SOCKET))
  ? Math.floor(Math.max(1, Math.min(Number(process.env.MAX_REQUESTS_PER_SOCKET), 1000)))
  : 100;
const MAX_HEADERS_COUNT = Number.isFinite(Number(process.env.MAX_HEADERS_COUNT))
  ? Math.floor(Math.max(1, Math.min(Number(process.env.MAX_HEADERS_COUNT), 2000)))
  : 200;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX_MUTATIONS = Number(process.env.RATE_LIMIT_MAX_MUTATIONS || 45);
const RATE_LIMIT_MAX_KEYS = Number(process.env.RATE_LIMIT_MAX_KEYS || 10_000);
const MAX_STORIES = Number(process.env.MAX_STORIES || 5000);
const MAX_COMMENTS = Number(process.env.MAX_COMMENTS || 20000);
const MAX_HALL_OF_FAME = Number(process.env.MAX_HALL_OF_FAME || 520);
const MAX_GIFT_CARDS = Number(process.env.MAX_GIFT_CARDS || 520);
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim().toLowerCase() === 'true';
const ALLOWED_HOSTS = getAllowedHosts(process.env);

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
const SAFE_RATE_LIMIT_WINDOW_MS = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0 ? RATE_LIMIT_WINDOW_MS : 60 * 1000;
const SAFE_RATE_LIMIT_MAX_MUTATIONS = Number.isFinite(RATE_LIMIT_MAX_MUTATIONS) && RATE_LIMIT_MAX_MUTATIONS > 0 ? RATE_LIMIT_MAX_MUTATIONS : 45;
const SAFE_RATE_LIMIT_MAX_KEYS = Number.isFinite(RATE_LIMIT_MAX_KEYS) && RATE_LIMIT_MAX_KEYS >= 1000
  ? Math.floor(Math.min(RATE_LIMIT_MAX_KEYS, 200000))
  : 10_000;
const IMPORT_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 10000);
const SAFE_IMPORT_TIMEOUT_MS = Number.isFinite(IMPORT_TIMEOUT_MS) && IMPORT_TIMEOUT_MS >= 1000 ? Math.min(IMPORT_TIMEOUT_MS, 60000) : 10000;
const MAX_STORY_CHARS = Number.isFinite(Number(process.env.MAX_STORY_CHARS)) && Number(process.env.MAX_STORY_CHARS) >= 200
  ? Math.floor(Number(process.env.MAX_STORY_CHARS))
  : 5000;
const MAX_COMMENT_CHARS = Number.isFinite(Number(process.env.MAX_COMMENT_CHARS)) && Number(process.env.MAX_COMMENT_CHARS) >= 20
  ? Math.floor(Number(process.env.MAX_COMMENT_CHARS))
  : 300;
const MAX_COMMENTS_PER_STORY = Number.isFinite(Number(process.env.MAX_COMMENTS_PER_STORY)) && Number(process.env.MAX_COMMENTS_PER_STORY) >= 5
  ? Math.floor(Number(process.env.MAX_COMMENTS_PER_STORY))
  : 500;
const MAX_AUTHOR_CHARS = Number.isFinite(Number(process.env.MAX_AUTHOR_CHARS)) && Number(process.env.MAX_AUTHOR_CHARS) >= 10
  ? Math.floor(Number(process.env.MAX_AUTHOR_CHARS))
  : 60;
const IDEMPOTENCY_TTL_MS = Number.isFinite(Number(process.env.IDEMPOTENCY_TTL_MS)) && Number(process.env.IDEMPOTENCY_TTL_MS) >= 60_000
  ? Math.floor(Number(process.env.IDEMPOTENCY_TTL_MS))
  : 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_KEYS = Number.isFinite(Number(process.env.MAX_IDEMPOTENCY_KEYS)) && Number(process.env.MAX_IDEMPOTENCY_KEYS) >= 100
  ? Math.floor(Math.min(Number(process.env.MAX_IDEMPOTENCY_KEYS), 200000))
  : 5000;
const mutationLog = new Map();
const mutationLogOrder = [];
const adminRunIdempotencyCache = new Map();
const engagementIdempotencyCache = new Map();
const IDEMPOTENCY_CACHE_FILE = String(process.env.IDEMPOTENCY_CACHE_FILE || path.join(DATA_DIR, 'idempotency-cache.json'));
const IDEMPOTENCY_CACHE_BACKUP_FILE = `${IDEMPOTENCY_CACHE_FILE}.bak`;
let lastImportRun = null;
let importRunPromise = null;
let hallOfFameRunPromise = null;

function restoreIdempotencyEntries(targetMap, entries, now = Date.now()) {
  if (!Array.isArray(entries)) return false;
  let restored = false;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;
    if (typeof key !== 'string' || !key) continue;
    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || typeof value.result !== 'object') continue;
    targetMap.set(key, value);
    restored = true;
  }
  return restored;
}

function restoreIdempotencyCaches(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const now = Date.now();
  const restoredAdmin = restoreIdempotencyEntries(adminRunIdempotencyCache, parsed.adminRun, now);
  const restoredEngagement = restoreIdempotencyEntries(engagementIdempotencyCache, parsed.engagement, now);
  return restoredAdmin || restoredEngagement;
}

function saveIdempotencyCaches() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      adminRun: [...adminRunIdempotencyCache.entries()],
      engagement: [...engagementIdempotencyCache.entries()]
    };
    const tmpSuffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const tmpFile = `${IDEMPOTENCY_CACHE_FILE}.${tmpSuffix}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpFile, IDEMPOTENCY_CACHE_FILE);
    fs.copyFileSync(IDEMPOTENCY_CACHE_FILE, IDEMPOTENCY_CACHE_BACKUP_FILE);
  } catch {
    // best-effort persistence only
  }
}

function loadIdempotencyCaches() {
  try {
    if (fs.existsSync(IDEMPOTENCY_CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(IDEMPOTENCY_CACHE_FILE, 'utf8'));
      if (restoreIdempotencyCaches(parsed)) return;
    }
    if (fs.existsSync(IDEMPOTENCY_CACHE_BACKUP_FILE)) {
      const backupParsed = JSON.parse(fs.readFileSync(IDEMPOTENCY_CACHE_BACKUP_FILE, 'utf8'));
      restoreIdempotencyCaches(backupParsed);
    }
  } catch {
    // best-effort persistence only
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

function getAllowedHosts(env = process.env) {
  const direct = String(env.ALLOWED_HOSTS || '').trim();
  const fileValue = readSecretFile(env.ALLOWED_HOSTS_FILE);
  const raw = direct || fileValue;
  if (!raw) return [];
  return [...new Set(raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
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

function isSecretFileTooLarge(filePath, maxBytes = MAX_SECRET_FILE_BYTES) {
  if (!filePath || String(filePath).trim() === '') return false;
  try {
    const stats = fs.statSync(String(filePath));
    if (!stats.isFile()) return true;
    return stats.size > maxBytes;
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

const PLACEHOLDER_TOKENS = ['changeme', 'change-me', 'replace-me', 'replace_this', 'placeholder', 'example', 'sample', 'dummy', 'todo', 'tbd', 'unknown', 'default', 'password'];

function looksLikePlaceholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return PLACEHOLDER_TOKENS.some((token) => normalized.includes(token));
}

function looksLikePlaceholderToken(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return PLACEHOLDER_TOKENS.includes(normalized);
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

function looksLikeOncallUrl(value) {
  return /:\/\//.test(String(value || ''));
}

function getConfiguredAdminToken() {
  const direct = String(process.env.MADE_MY_DAY_ADMIN_TOKEN || '').trim();
  if (direct) return direct;
  return readSecretFile(process.env.MADE_MY_DAY_ADMIN_TOKEN_FILE);
}

function getAdminTokenCandidates() {
  const values = [
    String(process.env.MADE_MY_DAY_ADMIN_TOKEN || '').trim(),
    readSecretFile(process.env.MADE_MY_DAY_ADMIN_TOKEN_FILE),
    String(process.env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS || '').trim(),
    readSecretFile(process.env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE)
  ].filter(Boolean);
  return [...new Set(values)];
}

function getPreviousAdminToken() {
  return [
    String(process.env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS || '').trim(),
    readSecretFile(process.env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE)
  ].find(Boolean) || '';
}

function getTextConfigValue(key) {
  const direct = String(process.env[key] || '').trim();
  if (direct) return direct;
  return readSecretFile(process.env[`${key}_FILE`]);
}

function hasBothDirectAndFileConfigured(key) {
  const direct = String(process.env[key] || '').trim();
  const filePath = String(process.env[`${key}_FILE`] || '').trim();
  return Boolean(direct && filePath);
}

function hasStrongAdminToken() {
  const configuredToken = getConfiguredAdminToken();
  return configuredToken.length >= 16 && !looksLikePlaceholderSecret(configuredToken);
}

function parseIntOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
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

function isIpLiteralHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  return net.isIP(normalized) !== 0;
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

function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function buildPaginationLinks(pathname, limit, offset, pageSize, total) {
  const base = `/${pathname.replace(/^\//, '')}`;
  const links = [];

  const nextOffset = offset + pageSize < total ? offset + pageSize : null;
  if (Number.isFinite(nextOffset) && nextOffset >= 0) {
    links.push(`<${base}?limit=${limit}&offset=${nextOffset}>; rel="next"`);
  }

  const previousOffset = offset > 0 ? Math.max(0, offset - limit) : null;
  if (Number.isFinite(previousOffset) && previousOffset >= 0 && offset > 0) {
    links.push(`<${base}?limit=${limit}&offset=${previousOffset}>; rel="prev"`);
  }

  return links.length ? links.join(', ') : undefined;
}

function getConfigIssues() {
  const issues = [];

  const configuredToken = getConfiguredAdminToken();
  if (!configuredToken || !hasStrongAdminToken()) {
    issues.push('adminToken');
  }

  const previousToken = getPreviousAdminToken();
  if (configuredToken && previousToken && configuredToken === previousToken) {
    issues.push('adminTokenRotation');
  }

  if (hasBothDirectAndFileConfigured('MADE_MY_DAY_ADMIN_TOKEN') || hasBothDirectAndFileConfigured('MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS')) {
    issues.push('secretSources');
  }

  const adminTokenCandidates = getAdminTokenCandidates();
  if (adminTokenCandidates.some((token) => hasUnsafeSecretWhitespace(token))) {
    issues.push('adminTokenFormat');
  }

  const oncallPrimary = getTextConfigValue('MADE_MY_DAY_ONCALL_PRIMARY');
  if (oncallPrimary.length < 3 || looksLikePlaceholderToken(oncallPrimary) || hasUnsafeOncallChars(oncallPrimary) || hasOncallWhitespace(oncallPrimary) || looksLikeOncallUrl(oncallPrimary)) {
    issues.push('oncallPrimary');
  }

  const oncallSecondary = getTextConfigValue('MADE_MY_DAY_ONCALL_SECONDARY');
  if (oncallSecondary.length < 3 || looksLikePlaceholderToken(oncallSecondary) || hasUnsafeOncallChars(oncallSecondary) || hasOncallWhitespace(oncallSecondary) || looksLikeOncallUrl(oncallSecondary) || oncallSecondary.toLowerCase() === oncallPrimary.toLowerCase()) {
    issues.push('oncallSecondary');
  }

  const escalationDocUrl = getTextConfigValue('MADE_MY_DAY_ESCALATION_DOC_URL');
  if (!looksLikeHttpsUrl(escalationDocUrl) || looksLikePlaceholderEscalationUrl(escalationDocUrl)) {
    issues.push('escalationDocUrl');
  }
  if (hasEscalationUrlRootPath(escalationDocUrl)) {
    issues.push('escalationDocUrl');
  }
  if (hasEscalationUrlParamsOrFragment(escalationDocUrl)) {
    issues.push('escalationDocUrl');
  }
  if (hasEscalationUrlCredentials(escalationDocUrl)) {
    issues.push('escalationDocUrl');
  }
  if (escalationDocUrl) {
    try {
      const parsedEscalationUrl = new URL(escalationDocUrl);
      if (isIpLiteralHost(parsedEscalationUrl.hostname)) {
        issues.push('escalationDocUrl');
      } else if (isPrivateOrLocalEscalationHost(parsedEscalationUrl.hostname)) {
        issues.push('escalationDocUrl');
      }
    } catch {
      // Ignored: invalid URL shape already handled by looksLikeHttpsUrl.
    }
  }

  const importTimeout = parseIntOrDefault(process.env.IMPORT_TIMEOUT_MS, 10000);
  if (importTimeout < 1000 || importTimeout > 60000) {
    issues.push('importTimeout');
  }

  const maxBodyBytesRaw = parseIntOrDefault(process.env.MAX_BODY_BYTES, 16 * 1024);
  if (maxBodyBytesRaw < 1024 || maxBodyBytesRaw > 256 * 1024) {
    issues.push('maxBodyBytes');
  }

  const maxUrlCharsRaw = parseIntOrDefault(process.env.MAX_URL_CHARS, 2048);
  if (maxUrlCharsRaw < 256 || maxUrlCharsRaw > 8192) {
    issues.push('maxUrlChars');
  }

  const maxHeaderBytesRaw = parseIntOrDefault(process.env.MAX_HEADER_BYTES, 16 * 1024);
  if (maxHeaderBytesRaw < 4096 || maxHeaderBytesRaw > 65536) {
    issues.push('maxHeaderBytes');
  }

  const maxQueryCharsRaw = parseIntOrDefault(process.env.MAX_QUERY_CHARS, 1024);
  if (maxQueryCharsRaw < 128 || maxQueryCharsRaw > 4096) {
    issues.push('maxQueryChars');
  }

  if (ALLOWED_HOSTS.length > 0) {
    if (ALLOWED_HOSTS.length > 32) {
      issues.push('allowedHosts');
    }
    if (ALLOWED_HOSTS.some((host) => !isValidAllowedHostEntry(host))) {
      issues.push('allowedHosts');
    }
    if (ALLOWED_HOSTS.some((host) => {
      const parsed = parseAllowedHostEntry(host);
      if (!parsed) return false;
      return isPrivateOrLocalEscalationHost(parsed.host);
    })) {
      issues.push('allowedHosts');
    }
  }

  const maxIdempotencyKeysRaw = parseIntOrDefault(process.env.MAX_IDEMPOTENCY_KEYS, 5000);
  if (maxIdempotencyKeysRaw < 100 || maxIdempotencyKeysRaw > 200000) {
    issues.push('maxIdempotencyKeys');
  }

  const maxStoryChars = parseIntOrDefault(process.env.MAX_STORY_CHARS, 5000);
  if (maxStoryChars < 200) issues.push('maxStoryChars');

  const maxCommentChars = parseIntOrDefault(process.env.MAX_COMMENT_CHARS, 300);
  if (maxCommentChars < 20) issues.push('maxCommentChars');

  const maxCommentsPerStory = parseIntOrDefault(process.env.MAX_COMMENTS_PER_STORY, 500);
  if (maxCommentsPerStory < 5) issues.push('maxCommentsPerStory');

  const maxAuthorChars = parseIntOrDefault(process.env.MAX_AUTHOR_CHARS, 60);
  if (maxAuthorChars < 10) issues.push('maxAuthorChars');

  const trustProxyRaw = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (trustProxyRaw && trustProxyRaw !== 'true' && trustProxyRaw !== 'false') {
    issues.push('trustProxy');
  }

  const requestTimeoutRaw = parseIntOrDefault(process.env.REQUEST_TIMEOUT_MS, 30_000);
  if (requestTimeoutRaw < 1_000 || requestTimeoutRaw > 120_000) {
    issues.push('requestTimeout');
  }

  const headersTimeoutRaw = parseIntOrDefault(process.env.HEADERS_TIMEOUT_MS, 15_000);
  if (headersTimeoutRaw < 1_000 || headersTimeoutRaw > 120_000) {
    issues.push('headersTimeout');
  }

  const keepAliveTimeoutRaw = parseIntOrDefault(process.env.KEEP_ALIVE_TIMEOUT_MS, 5_000);
  if (keepAliveTimeoutRaw < 1_000 || keepAliveTimeoutRaw > 120_000) {
    issues.push('keepAliveTimeout');
  }

  const maxRequestsPerSocketRaw = parseIntOrDefault(process.env.MAX_REQUESTS_PER_SOCKET, 100);
  if (maxRequestsPerSocketRaw < 1 || maxRequestsPerSocketRaw > 1000) {
    issues.push('maxRequestsPerSocket');
  }

  const maxHeadersCountRaw = parseIntOrDefault(process.env.MAX_HEADERS_COUNT, 200);
  if (maxHeadersCountRaw < 1 || maxHeadersCountRaw > 2000) {
    issues.push('maxHeadersCount');
  }

  const shutdownGraceRaw = parseIntOrDefault(process.env.SHUTDOWN_GRACE_MS, 10_000);
  if (shutdownGraceRaw < 1_000 || shutdownGraceRaw > 120_000) {
    issues.push('shutdownGraceMs');
  }

  if (!issues.includes('headersTimeout') && !issues.includes('requestTimeout') && headersTimeoutRaw > requestTimeoutRaw) {
    issues.push('headersTimeoutOrder');
  }

  if (!issues.includes('keepAliveTimeout') && !issues.includes('headersTimeout') && keepAliveTimeoutRaw > headersTimeoutRaw) {
    issues.push('keepAliveTimeoutOrder');
  }

  if (
    !issues.includes('keepAliveTimeout')
    && !issues.includes('headersTimeout')
    && (headersTimeoutRaw - keepAliveTimeoutRaw) < 1000
  ) {
    issues.push('keepAliveSafetyGap');
  }

  const secretFileKeys = [
    'MADE_MY_DAY_ADMIN_TOKEN',
    'MADE_MY_DAY_ONCALL_PRIMARY',
    'MADE_MY_DAY_ONCALL_SECONDARY',
    'MADE_MY_DAY_ESCALATION_DOC_URL',
    'ALLOWED_HOSTS'
  ];
  if (secretFileKeys.some((key) => isSecretFilePathInvalid(process.env[`${key}_FILE`]) || isSecretFilePathInvalid(process.env[`${key}_PREVIOUS_FILE`]))) {
    issues.push('secretFiles');
  }

  if (secretFileKeys.some((key) => hasSecretFileReadError(process.env[`${key}_FILE`]) || hasSecretFileReadError(process.env[`${key}_PREVIOUS_FILE`]))) {
    issues.push('secretFiles');
  }

  if (secretFileKeys.some((key) => isSecretFileSymlink(process.env[`${key}_FILE`]) || isSecretFileSymlink(process.env[`${key}_PREVIOUS_FILE`]))) {
    issues.push('secretFiles');
  }

  if (secretFileKeys.some((key) => isSecretFileTooPermissive(process.env[`${key}_FILE`]) || isSecretFileTooPermissive(process.env[`${key}_PREVIOUS_FILE`]))) {
    issues.push('secretFilePermissions');
  }

  if (secretFileKeys.some((key) => isSecretFileTooLarge(process.env[`${key}_FILE`]) || isSecretFileTooLarge(process.env[`${key}_PREVIOUS_FILE`]))) {
    issues.push('secretFileSize');
  }

  if (secretFileKeys.some((key) => isSecretFileWrongOwner(process.env[`${key}_FILE`]) || isSecretFileWrongOwner(process.env[`${key}_PREVIOUS_FILE`]))) {
    issues.push('secretFileOwnership');
  }

  return issues;
}

function getReadinessStatus() {
  const issues = getConfigIssues();
  return {
    ready: issues.length === 0,
    issueCodes: [...issues],
    checks: {
      adminToken: (issues.includes('adminToken') || issues.includes('adminTokenFormat')) ? 'fail' : 'pass',
      adminTokenRotation: issues.includes('adminTokenRotation') ? 'fail' : 'pass',
      oncallPrimary: issues.includes('oncallPrimary') ? 'fail' : 'pass',
      oncallSecondary: issues.includes('oncallSecondary') ? 'fail' : 'pass',
      escalationDocUrl: issues.includes('escalationDocUrl') ? 'fail' : 'pass',
      secretFiles: (issues.includes('secretFiles') || issues.includes('secretFilePermissions') || issues.includes('secretFileSize') || issues.includes('secretFileOwnership') || issues.includes('secretSources')) ? 'fail' : 'pass',
      importTimeoutMs: issues.includes('importTimeout') ? 'fail' : 'pass',
      maxBodyBytes: issues.includes('maxBodyBytes') ? 'fail' : 'pass',
      maxUrlChars: issues.includes('maxUrlChars') ? 'fail' : 'pass',
      maxHeaderBytes: issues.includes('maxHeaderBytes') ? 'fail' : 'pass',
      maxQueryChars: issues.includes('maxQueryChars') ? 'fail' : 'pass',
      allowedHosts: issues.includes('allowedHosts') ? 'fail' : 'pass',
      maxIdempotencyKeys: issues.includes('maxIdempotencyKeys') ? 'fail' : 'pass',
      maxStoryChars: issues.includes('maxStoryChars') ? 'fail' : 'pass',
      maxCommentChars: issues.includes('maxCommentChars') ? 'fail' : 'pass',
      maxCommentsPerStory: issues.includes('maxCommentsPerStory') ? 'fail' : 'pass',
      maxAuthorChars: issues.includes('maxAuthorChars') ? 'fail' : 'pass',
      trustProxy: issues.includes('trustProxy') ? 'fail' : 'pass',
      requestTimeoutMs: issues.includes('requestTimeout') ? 'fail' : 'pass',
      headersTimeoutMs: issues.includes('headersTimeout') ? 'fail' : ((issues.includes('headersTimeoutOrder') || issues.includes('keepAliveSafetyGap')) ? 'fail' : 'pass'),
      keepAliveTimeoutMs: issues.includes('keepAliveTimeout') ? 'fail' : ((issues.includes('keepAliveTimeoutOrder') || issues.includes('keepAliveSafetyGap')) ? 'fail' : 'pass'),
      maxRequestsPerSocket: issues.includes('maxRequestsPerSocket') ? 'fail' : 'pass',
      maxHeadersCount: issues.includes('maxHeadersCount') ? 'fail' : 'pass',
      shutdownGraceMs: issues.includes('shutdownGraceMs') ? 'fail' : 'pass'
    }
  };
}

function getOperationalSnapshot(store, { windowHours = 0 } = {}) {
  const importedStories = store.stories.filter((s) => s.autoImported).length;
  const manualStories = store.stories.length - importedStories;
  const nowMs = Date.now();
  const windowMs = windowHours > 0 ? windowHours * 60 * 60 * 1000 : null;
  const activeHall = store.hallOfFame.find((h) => Date.now() - new Date(h.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000) || null;
  const latestStory = store.stories[0] || null;
  const rateLimitKeysUsed = mutationLog.size;
  const idempotencyKeysPersisted = Array.isArray(store.idempotencyKeys) ? store.idempotencyKeys.length : 0;

  return {
    totals: {
      stories: store.stories.length,
      comments: store.comments.length,
      hallOfFame: store.hallOfFame.length,
      giftCards: store.giftCards.length
    },
    recentWindow: windowMs
      ? {
          windowHours,
          stories: store.stories.filter((story) => {
            const ts = Date.parse(story?.createdAt || '');
            return Number.isFinite(ts) && nowMs - ts <= windowMs;
          }).length,
          comments: store.comments.filter((comment) => {
            const ts = Date.parse(comment?.createdAt || '');
            return Number.isFinite(ts) && nowMs - ts <= windowMs;
          }).length,
          hallOfFame: store.hallOfFame.filter((entry) => {
            const ts = Date.parse(entry?.publishedAt || '');
            return Number.isFinite(ts) && nowMs - ts <= windowMs;
          }).length,
          giftCards: store.giftCards.filter((card) => {
            const ts = Date.parse(card?.createdAt || card?.issuedAt || '');
            return Number.isFinite(ts) && nowMs - ts <= windowMs;
          }).length
        }
      : null,
    ingestion: {
      importedStories,
      manualStories,
      lastRun: lastImportRun
    },
    winnerAutomation: {
      pendingWinner: store.pendingWinner,
      activeHallOfFameStoryId: activeHall ? activeHall.storyId : null,
      latestHallOfFameEntry: store.hallOfFame[0] || null
    },
    runtimeGuards: {
      rateLimitKeysUsed,
      rateLimitKeysCapacity: SAFE_RATE_LIMIT_MAX_KEYS,
      idempotencyKeysPersisted,
      idempotencyKeysCapacity: clampLimit(MAX_IDEMPOTENCY_KEYS, 5000)
    },
    latestStory: latestStory
      ? {
          id: latestStory.id,
          createdAt: latestStory.createdAt,
          autoImported: Boolean(latestStory.autoImported)
        }
      : null
  };
}

function getEscalationSnapshot() {
  const oncallPrimary = getTextConfigValue('MADE_MY_DAY_ONCALL_PRIMARY');
  const oncallSecondary = getTextConfigValue('MADE_MY_DAY_ONCALL_SECONDARY');
  const escalationDocUrl = getTextConfigValue('MADE_MY_DAY_ESCALATION_DOC_URL');
  return {
    oncallPrimary: oncallPrimary || null,
    oncallSecondary: oncallSecondary || null,
    escalationDocUrl: escalationDocUrl || null,
    configured: Boolean(oncallPrimary && oncallSecondary && escalationDocUrl)
  };
}

function getVersionSnapshot() {
  const gitSha = String(process.env.MADE_MY_DAY_GIT_SHA || process.env.GIT_COMMIT_SHA || '').trim() || null;
  const buildId = String(process.env.MADE_MY_DAY_BUILD_ID || '').trim() || null;
  const uptimeSeconds = Math.floor(process.uptime());
  const instanceId = String(process.env.MADE_MY_DAY_INSTANCE_ID || process.env.HOSTNAME || '').trim() || null;
  return {
    service: 'made-my-day',
    version: packageMeta.version,
    gitSha,
    buildId,
    instanceId,
    nodeVersion: process.version,
    startedAt: new Date(Date.now() - (uptimeSeconds * 1000)).toISOString(),
    uptimeSeconds
  };
}

function secureTokenEquals(incomingToken, configuredToken) {
  const incomingBuffer = Buffer.from(String(incomingToken));
  const configuredBuffer = Buffer.from(String(configuredToken));
  if (incomingBuffer.length !== configuredBuffer.length) return false;
  return crypto.timingSafeEqual(incomingBuffer, configuredBuffer);
}

function parseAuthorizationBearer(req) {
  const header = req.headers.authorization;
  if (Array.isArray(header)) return { malformed: true, token: '' };
  if (typeof header !== 'string') return { malformed: false, token: '' };
  const value = header.trim();
  if (!value) return { malformed: false, token: '' };
  if (value.includes(',')) return { malformed: true, token: '' };
  if (!value.startsWith('Bearer ')) return { malformed: false, token: '' };
  const incoming = value.slice('Bearer '.length).trim();
  if (incoming.length === 0 || incoming.length > 1024) return { malformed: true, token: '' };
  return { malformed: false, token: incoming };
}

function getAdminAuthStatus(req) {
  const configuredToken = getConfiguredAdminToken();
  if (!configuredToken) return { allowed: true, malformed: false }; // preview mode
  if (!hasStrongAdminToken()) return { allowed: false, malformed: false };

  const parsedAuth = parseAuthorizationBearer(req);
  if (parsedAuth.malformed) return { allowed: false, malformed: true };
  if (!parsedAuth.token) return { allowed: false, malformed: false };

  const candidates = getAdminTokenCandidates().filter((token) => token.length >= 16 && !looksLikePlaceholderSecret(token));
  if (candidates.length === 0) return { allowed: false, malformed: false };
  const allowed = candidates.some((token) => secureTokenEquals(parsedAuth.token, token));
  return { allowed, malformed: false };
}

function requireAdminAuth(req, res) {
  const auth = getAdminAuthStatus(req);
  if (auth.allowed) return true;
  if (auth.malformed) {
    json(res, 400, { error: 'invalid authorization header' });
    return false;
  }
  json(res, 401, { error: 'unauthorized' }, { headers: { 'WWW-Authenticate': 'Bearer realm="made-my-day"' } });
  return false;
}

function writeStoreFileAtomically(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpSuffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpFile = `${STORE_FILE}.${tmpSuffix}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    writeStoreFileAtomically(emptyStore());
  }
}

function emptyStore() {
  return { stories: [], comments: [], hallOfFame: [], pendingWinner: null, giftCards: [], idempotencyKeys: [] };
}

function loadStore() {
  ensureStore();
  let store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    // Recover from partial/corrupted writes and keep a bounded forensics snapshot set.
    snapshotCorruptStoreFile(STORE_FILE);
    store = emptyStore();
    writeStoreFileAtomically(store);
  }
  if (!Array.isArray(store.stories)) store.stories = [];
  if (!Array.isArray(store.comments)) store.comments = [];
  if (!Array.isArray(store.hallOfFame)) store.hallOfFame = [];
  if (!Array.isArray(store.giftCards)) store.giftCards = [];
  if (!Array.isArray(store.idempotencyKeys)) store.idempotencyKeys = [];
  if (!Object.prototype.hasOwnProperty.call(store, 'pendingWinner')) store.pendingWinner = null;
  return store;
}

function clampLimit(value, fallback) {
  return Number.isFinite(value) && value >= 100 ? Math.floor(value) : fallback;
}

function trimToLimit(items, limit) {
  if (!Array.isArray(items)) return [];
  if (items.length <= limit) return items;
  return items.slice(0, limit);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizeUserText(value, maxChars) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxChars);
}

function sanitizeSourceUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

function sanitizeSourceName(value) {
  if (!value) return null;
  const cleaned = sanitizeUserText(value, 120);
  return cleaned || null;
}

function parseIdempotencyKey(req) {
  const header = req.headers['idempotency-key'];
  if (Array.isArray(header)) return { malformed: true, key: '' };
  if (typeof header !== 'string') return { malformed: false, key: '' };
  const key = header.trim();
  if (!key) return { malformed: true, key: '' };
  if (key.includes(',')) return { malformed: true, key: '' };
  if (key.length < 8 || key.length > 128) return { malformed: true, key: '' };
  if (!/^[a-zA-Z0-9:_\-.]+$/.test(key)) return { malformed: true, key: '' };
  return { malformed: false, key };
}

function getIdempotencyKey(req) {
  return parseIdempotencyKey(req).key;
}

function getAdminRunIdempotent(scope, idempotencyKey) {
  if (!scope || !idempotencyKey) return null;
  const cacheKey = `${scope}:${idempotencyKey}`;
  const hit = adminRunIdempotencyCache.get(cacheKey);
  if (!hit || !Number.isFinite(hit.expiresAt) || hit.expiresAt <= Date.now()) {
    if (adminRunIdempotencyCache.delete(cacheKey)) saveIdempotencyCaches();
    return null;
  }
  return hit.result;
}

function rememberAdminRunIdempotent(scope, idempotencyKey, result) {
  if (!scope || !idempotencyKey || !result) return;
  const now = Date.now();
  const cacheKey = `${scope}:${idempotencyKey}`;
  adminRunIdempotencyCache.set(cacheKey, {
    expiresAt: now + IDEMPOTENCY_TTL_MS,
    result
  });

  const max = clampLimit(MAX_IDEMPOTENCY_KEYS, 5000);
  if (adminRunIdempotencyCache.size > max) {
    for (const [key, value] of adminRunIdempotencyCache.entries()) {
      if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
        adminRunIdempotencyCache.delete(key);
      }
      if (adminRunIdempotencyCache.size <= max) break;
    }

    while (adminRunIdempotencyCache.size > max) {
      const oldest = adminRunIdempotencyCache.keys().next();
      if (oldest.done) break;
      adminRunIdempotencyCache.delete(oldest.value);
    }
  }

  saveIdempotencyCaches();
}

function getEngagementIdempotent(scope, idempotencyKey) {
  if (!scope || !idempotencyKey) return null;
  const cacheKey = `${scope}:${idempotencyKey}`;
  const hit = engagementIdempotencyCache.get(cacheKey);
  if (!hit || !Number.isFinite(hit.expiresAt) || hit.expiresAt <= Date.now()) {
    if (engagementIdempotencyCache.delete(cacheKey)) saveIdempotencyCaches();
    return null;
  }
  return hit.result;
}

function rememberEngagementIdempotent(scope, idempotencyKey, result) {
  if (!scope || !idempotencyKey || !result) return;
  const now = Date.now();
  const cacheKey = `${scope}:${idempotencyKey}`;
  engagementIdempotencyCache.set(cacheKey, {
    expiresAt: now + IDEMPOTENCY_TTL_MS,
    result
  });

  const max = clampLimit(MAX_IDEMPOTENCY_KEYS, 5000);
  if (engagementIdempotencyCache.size > max) {
    for (const [key, value] of engagementIdempotencyCache.entries()) {
      if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
        engagementIdempotencyCache.delete(key);
      }
      if (engagementIdempotencyCache.size <= max) break;
    }

    while (engagementIdempotencyCache.size > max) {
      const oldest = engagementIdempotencyCache.keys().next();
      if (oldest.done) break;
      engagementIdempotencyCache.delete(oldest.value);
    }
  }

  saveIdempotencyCaches();
}

function findRecentIdempotentStory(store, idempotencyKey) {
  if (!idempotencyKey || !Array.isArray(store.idempotencyKeys)) return null;
  const now = Date.now();
  const hit = store.idempotencyKeys.find((entry) => {
    if (!entry || entry.key !== idempotencyKey || !entry.createdAt) return false;
    const ageMs = now - new Date(entry.createdAt).getTime();
    return Number.isFinite(ageMs) && ageMs <= IDEMPOTENCY_TTL_MS;
  });
  if (!hit?.storyId) return null;
  return store.stories.find((story) => story.id === hit.storyId) || null;
}

function rememberIdempotentStory(store, idempotencyKey, storyId) {
  if (!idempotencyKey || !storyId) return;
  if (!Array.isArray(store.idempotencyKeys)) store.idempotencyKeys = [];
  store.idempotencyKeys.unshift({ key: idempotencyKey, storyId, createdAt: new Date().toISOString() });
}

function saveStore(store) {
  store.stories = trimToLimit(store.stories, clampLimit(MAX_STORIES, 5000));
  store.comments = trimToLimit(store.comments, clampLimit(MAX_COMMENTS, 20000));
  store.hallOfFame = trimToLimit(store.hallOfFame, clampLimit(MAX_HALL_OF_FAME, 520));
  store.giftCards = trimToLimit(store.giftCards, clampLimit(MAX_GIFT_CARDS, 520));
  store.idempotencyKeys = trimToLimit(
    (Array.isArray(store.idempotencyKeys) ? store.idempotencyKeys : []).filter((entry) => {
      if (!entry || !entry.createdAt) return false;
      const ageMs = Date.now() - new Date(entry.createdAt).getTime();
      return Number.isFinite(ageMs) && ageMs <= IDEMPOTENCY_TTL_MS;
    }),
    clampLimit(MAX_IDEMPOTENCY_KEYS, 5000)
  );
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpSuffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpFile = `${STORE_FILE}.${tmpSuffix}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-DNS-Prefetch-Control': 'off',
    'X-Download-Options': 'noopen',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
  };
}

function applyNoStoreHeaders(headers) {
  headers['Cache-Control'] = 'no-store, private, max-age=0';
  headers.Pragma = 'no-cache';
  headers.Expires = '0';
  headers.Vary = headers.Vary ? `${headers.Vary}, Authorization` : 'Authorization';
}

function shouldSuppressBodyForMethod(res) {
  return res?.req?.method === 'HEAD';
}

function json(res, status, data, { noStore = true, headers: extraHeaders } = {}) {
  const body = JSON.stringify(data, null, 2);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders(),
    ...(extraHeaders || {})
  };
  if (noStore) applyNoStoreHeaders(headers);
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(shouldSuppressBodyForMethod(res) ? undefined : body);
}

function methodNotAllowed(res, allowed) {
  return json(
    res,
    405,
    { error: 'method not allowed', allowed },
    { headers: { Allow: allowed.join(', ') } }
  );
}

function isGetOrHead(req) {
  return req.method === 'GET' || req.method === 'HEAD';
}

function csvValue(value) {
  const text = String(value ?? '');
  const formulaSafe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  if (formulaSafe.includes(',') || formulaSafe.includes('"') || formulaSafe.includes('\n')) {
    return `"${formulaSafe.replace(/"/g, '""')}"`;
  }
  return formulaSafe;
}

function csv(res, status, rows, { noStore = true, headers: extraHeaders } = {}) {
  const body = rows.map((row) => row.map((value) => csvValue(value)).join(',')).join('\n');
  const headers = {
    'Content-Type': 'text/csv; charset=utf-8',
    ...securityHeaders(),
    ...(extraHeaders || {})
  };
  if (noStore) applyNoStoreHeaders(headers);
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(shouldSuppressBodyForMethod(res) ? undefined : body);
}

function isStrictJsonContentType(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;

  const [mediaTypeRaw, ...paramParts] = normalized.split(';');
  if (!mediaTypeRaw || mediaTypeRaw.trim().toLowerCase() !== 'application/json') {
    return false;
  }

  let sawCharset = false;
  for (const part of paramParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0 || eqIndex === trimmed.length - 1) {
      return false;
    }
    const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
    let val = trimmed.slice(eqIndex + 1).trim().toLowerCase();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).trim();
    }
    if (!key || !val) return false;

    if (key === 'charset') {
      if (sawCharset || val !== 'utf-8') {
        return false;
      }
      sawCharset = true;
    }
  }

  return true;
}

function getJsonContentTypeStatus(req) {
  const rawHeader = req.headers['content-type'];
  if (Array.isArray(rawHeader)) {
    const normalized = rawHeader.map((value) => String(value).trim()).filter(Boolean);
    if (normalized.length !== 1) {
      return { ok: false, malformed: normalized.length > 1 };
    }
    return { ok: isStrictJsonContentType(normalized[0]), malformed: false };
  }

  if (typeof rawHeader !== 'string') {
    return { ok: false, malformed: false };
  }

  const normalized = rawHeader.trim();
  if (!normalized) {
    return { ok: false, malformed: false };
  }

  const values = normalized.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length !== 1) {
    return { ok: false, malformed: values.length > 1 };
  }

  return { ok: isStrictJsonContentType(values[0]), malformed: false };
}

function acceptsJsonResponse(req) {
  if (hasDuplicateRawHeader(req, 'accept')) return { ok: false, malformed: true };
  const rawHeader = req.headers.accept;
  if (rawHeader == null) return { ok: true, malformed: false };
  if (Array.isArray(rawHeader)) {
    const normalized = rawHeader.map((value) => String(value).trim()).filter(Boolean);
    if (normalized.length !== 1) return { ok: false, malformed: normalized.length > 1 };
    return acceptsJsonResponseValue(normalized[0]);
  }
  const normalized = String(rawHeader).trim();
  if (!normalized) return { ok: true, malformed: false };
  return acceptsJsonResponseValue(normalized);
}

function acceptsJsonResponseValue(value) {
  const ranges = String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(';')[0].trim().toLowerCase())
    .filter(Boolean);
  if (ranges.length === 0) return { ok: true, malformed: false };
  const allowsJson = ranges.some((range) => range === '*/*' || range === 'application/*' || range === 'application/json');
  return { ok: allowsJson, malformed: false };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function weakEtagForPayload(payload) {
  const hash = crypto.createHash('sha1').update(stableStringify(payload)).digest('hex');
  return `W/"${hash}"`;
}

function ifNoneMatchMatches(req, etag) {
  const header = req.headers['if-none-match'];
  if (Array.isArray(header)) return false;
  if (typeof header !== 'string') return false;
  const normalized = header.trim();
  if (!normalized) return false;
  if (normalized === '*') return true;
  const candidates = normalized.split(',').map((value) => value.trim()).filter(Boolean);
  return candidates.includes(etag);
}

function jsonCached(req, res, status, data, { headers: extraHeaders } = {}) {
  const etag = weakEtagForPayload(data);
  const body = JSON.stringify(data, null, 2);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    ETag: etag,
    ...securityHeaders(),
    ...(extraHeaders || {})
  };
  headers.Vary = headers.Vary ? `${headers.Vary}, Authorization` : 'Authorization';

  if (ifNoneMatchMatches(req, etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(shouldSuppressBodyForMethod(res) ? undefined : body);
}

function id(prefix) {
  const value = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : crypto.randomBytes(8).toString('hex');
  return `${prefix}_${value}`;
}

function normalizeIp(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > 64) return null;
  const unwrapped = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!unwrapped || net.isIP(unwrapped) === 0) return null;
  return unwrapped.toLowerCase();
}

function parseForwardedHeaderIp(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim() || headerValue.length > 1024) return null;
  const firstElement = headerValue.split(',')[0];
  if (!firstElement) return null;
  const directives = firstElement.split(';');
  for (const directive of directives) {
    const [rawKey, ...rawRest] = directive.split('=');
    if (!rawKey || rawRest.length === 0) continue;
    if (rawKey.trim().toLowerCase() !== 'for') continue;
    const rawValue = rawRest.join('=').trim();
    if (!rawValue) continue;
    const unquoted = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    const strippedPort = unquoted.startsWith('[')
      ? unquoted.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
      : unquoted.replace(/:\d+$/, '');
    const parsed = normalizeIp(strippedPort);
    if (parsed) return parsed;
  }
  return null;
}

function hasValidSingleForwardedForHeader(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(',') || trimmed.length > 512) return false;
  return Boolean(normalizeIp(trimmed));
}

function hasValidSingleForwardedHeader(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(',') || trimmed.length > 1024) return false;
  return Boolean(parseForwardedHeaderIp(trimmed));
}

function getRequestIp(req) {
  if (TRUST_PROXY) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim() && forwardedFor.length <= 512) {
      const forwardedIp = normalizeIp(forwardedFor.split(',')[0]);
      if (forwardedIp) return forwardedIp;
    }
    const forwarded = parseForwardedHeaderIp(req.headers.forwarded);
    if (forwarded) return forwarded;
  }
  return normalizeIp(req.socket?.remoteAddress) || 'unknown';
}

function getRateLimitState(req) {
  if (req.method !== 'POST') {
    return {
      enforced: false,
      limited: false,
      limit: SAFE_RATE_LIMIT_MAX_MUTATIONS,
      remaining: SAFE_RATE_LIMIT_MAX_MUTATIONS,
      resetSeconds: Math.ceil(SAFE_RATE_LIMIT_WINDOW_MS / 1000),
      windowSeconds: Math.ceil(SAFE_RATE_LIMIT_WINDOW_MS / 1000)
    };
  }

  const ip = getRequestIp(req);
  const now = Date.now();
  const hadIp = mutationLog.has(ip);
  const freshForIp = (mutationLog.get(ip) || []).filter((ts) => now - ts <= SAFE_RATE_LIMIT_WINDOW_MS);
  freshForIp.push(now);
  mutationLog.set(ip, freshForIp);
  if (!hadIp) mutationLogOrder.push(ip);

  // prune stale keys to avoid unbounded memory growth under spray traffic
  for (const [key, timestamps] of mutationLog.entries()) {
    const live = timestamps.filter((ts) => now - ts <= SAFE_RATE_LIMIT_WINDOW_MS);
    if (live.length === 0) mutationLog.delete(key);
    else if (live.length !== timestamps.length) mutationLog.set(key, live);
  }

  while (mutationLog.size > SAFE_RATE_LIMIT_MAX_KEYS && mutationLogOrder.length) {
    const oldest = mutationLogOrder.shift();
    if (!oldest) continue;
    mutationLog.delete(oldest);
  }

  const oldestTimestamp = freshForIp[0] || now;
  const elapsedMs = now - oldestTimestamp;
  const resetSeconds = Math.max(1, Math.ceil((SAFE_RATE_LIMIT_WINDOW_MS - elapsedMs) / 1000));

  return {
    enforced: true,
    limited: freshForIp.length > SAFE_RATE_LIMIT_MAX_MUTATIONS,
    limit: SAFE_RATE_LIMIT_MAX_MUTATIONS,
    remaining: Math.max(0, SAFE_RATE_LIMIT_MAX_MUTATIONS - freshForIp.length),
    resetSeconds,
    windowSeconds: Math.ceil(SAFE_RATE_LIMIT_WINDOW_MS / 1000)
  };
}

function parseDeclaredContentLength(rawHeader) {
  if (rawHeader == null) return null;

  if (Array.isArray(rawHeader)) {
    if (rawHeader.length === 0) return null;
    const normalizedValues = rawHeader.map((value) => String(value).trim()).filter(Boolean);
    if (normalizedValues.length === 0) return null;
    const [firstValue, ...restValues] = normalizedValues;
    if (!/^\d+$/.test(firstValue)) return { invalid: true, value: null };
    if (restValues.some((value) => value !== firstValue)) return { invalid: true, value: null };
    const numericValue = Number(firstValue);
    if (!Number.isSafeInteger(numericValue) || numericValue < 0) return { invalid: true, value: null };
    return { invalid: false, value: numericValue };
  }

  const normalized = String(rawHeader).trim();
  if (!normalized) return null;

  const candidateValues = normalized.split(',').map((value) => value.trim()).filter(Boolean);
  if (candidateValues.length === 0) return null;
  const [firstValue, ...restValues] = candidateValues;
  if (!/^\d+$/.test(firstValue)) return { invalid: true, value: null };
  if (restValues.some((value) => value !== firstValue)) return { invalid: true, value: null };

  const value = Number(firstValue);
  if (!Number.isSafeInteger(value) || value < 0) return { invalid: true, value: null };
  return { invalid: false, value };
}

function hasTransferEncodingHeader(rawHeader) {
  if (rawHeader == null) return false;
  if (Array.isArray(rawHeader)) return rawHeader.some((value) => String(value).trim().length > 0);
  return String(rawHeader).trim().length > 0;
}

function hasUnsupportedContentEncoding(rawHeader) {
  if (rawHeader == null) return false;
  const values = Array.isArray(rawHeader)
    ? rawHeader.map((value) => String(value).trim()).filter(Boolean)
    : String(rawHeader).split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return false;
  return values.some((value) => value.toLowerCase() !== 'identity');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const clearBodyReadTimeout = () => {
      if (typeof req.setTimeout === 'function') {
        req.setTimeout(0);
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearBodyReadTimeout();
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearBodyReadTimeout();
      resolve(value);
    };

    const declaredContentLength = parseDeclaredContentLength(req.headers['content-length']);
    if (declaredContentLength?.invalid) {
      const error = new Error('invalid content-length header');
      error.code = 'INVALID_CONTENT_LENGTH';
      fail(error);
      return;
    }
    if (hasTransferEncodingHeader(req.headers['transfer-encoding']) && Number.isFinite(declaredContentLength?.value)) {
      const error = new Error('ambiguous request framing');
      error.code = 'AMBIGUOUS_REQUEST_FRAMING';
      fail(error);
      return;
    }
    if (hasUnsupportedContentEncoding(req.headers['content-encoding'])) {
      const error = new Error('content-encoding not supported');
      error.code = 'UNSUPPORTED_CONTENT_ENCODING';
      fail(error);
      return;
    }
    if (Number.isFinite(declaredContentLength?.value) && declaredContentLength.value > MAX_BODY_BYTES) {
      const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.code = 'BODY_TOO_LARGE';
      fail(error);
      return;
    }

    let body = '';
    let totalBytes = 0;

    if (typeof req.setTimeout === 'function') {
      req.setTimeout(BODY_READ_TIMEOUT_MS, () => {
        const error = new Error('request body read timeout');
        error.code = 'BODY_READ_TIMEOUT';
        fail(error);
        req.destroy();
      });
    }

    req.on('aborted', () => {
      const error = new Error('request aborted');
      error.code = 'REQUEST_ABORTED';
      fail(error);
    });

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (Number.isFinite(declaredContentLength?.value) && declaredContentLength.value !== totalBytes) {
        const error = new Error('content-length mismatch');
        error.code = 'CONTENT_LENGTH_MISMATCH';
        fail(error);
        return;
      }
      if (!body) {
        succeed({});
        return;
      }
      try {
        succeed(JSON.parse(body));
      } catch (error) {
        fail(error);
      }
    });

    req.on('error', (error) => {
      fail(error);
    });
  });
}

function handleBodyReadError(res, error) {
  if (error?.code === 'BODY_TOO_LARGE') {
    json(res, 413, { error: `Request body too large. Max ${MAX_BODY_BYTES} bytes.` });
    return;
  }
  if (error?.code === 'BODY_READ_TIMEOUT') {
    json(res, 408, { error: 'Request body read timeout.' });
    return;
  }
  if (error?.code === 'UNSUPPORTED_CONTENT_ENCODING') {
    json(res, 415, { error: 'Content-Encoding must be identity when provided.' });
    return;
  }
  json(res, 400, { error: 'Invalid JSON body.' });
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };
  const contentType = types[ext] || 'application/octet-stream';
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const headers = { 'Content-Type': contentType, ...securityHeaders() };
  if (ext === '.html') {
    applyNoStoreHeaders(headers);
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function storyScore(story, store) {
  const commentCount = store.comments.filter((c) => c.storyId === story.id).length;
  return (story.likes || 0) + (story.shares || 0) + commentCount;
}

function storyView(story, store) {
  const comments = store.comments.filter((c) => c.storyId === story.id);
  return {
    ...story,
    sourceUrl: sanitizeSourceUrl(story.sourceUrl),
    sourceName: sanitizeSourceName(story.sourceName),
    comments,
    commentCount: comments.length,
    score: storyScore(story, store)
  };
}

function startOfWeekMonday(d) {
  const date = new Date(d);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function weekKeyFromDate(d) {
  const monday = startOfWeekMonday(d);
  return monday.toISOString().slice(0, 10);
}

function computeWeeklyWinner(store, now = new Date()) {
  const thisWeekMonday = startOfWeekMonday(now);
  const lastWeekStart = new Date(thisWeekMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekEnd = new Date(thisWeekMonday.getTime() - 1);
  const weekKey = weekKeyFromDate(lastWeekStart);

  const candidates = store.stories.filter((s) => {
    const created = new Date(s.createdAt);
    return created >= lastWeekStart && created <= lastWeekEnd;
  });

  if (!candidates.length) return null;

  const ranked = candidates
    .map((s) => ({ storyId: s.id, score: storyScore(s, store), createdAt: s.createdAt }))
    .sort((a, b) => b.score - a.score || new Date(a.createdAt) - new Date(b.createdAt));

  return { weekKey, ...ranked[0], computedAt: now.toISOString() };
}

function runWeeklyWinnerAutomation() {
  const store = loadStore();
  const now = new Date();
  const day = now.getUTCDay(); // 0 Sunday, 1 Monday
  const hour = now.getUTCHours();

  // Sunday night: compute winner for the week that just ended.
  if (day === 0 && hour >= 23) {
    const winner = computeWeeklyWinner(store, now);
    if (winner && (!store.pendingWinner || store.pendingWinner.weekKey !== winner.weekKey)) {
      store.pendingWinner = winner;
      saveStore(store);
    }
  }

  // Monday 6:00 UTC: publish winner to hall of fame + gift card queue.
  if (day === 1 && hour >= 6 && store.pendingWinner) {
    const alreadyPublished = store.hallOfFame.some((h) => h.weekKey === store.pendingWinner.weekKey);
    if (!alreadyPublished) {
      const story = store.stories.find((s) => s.id === store.pendingWinner.storyId);
      if (story) {
        const entry = {
          id: id('hof'),
          weekKey: store.pendingWinner.weekKey,
          storyId: story.id,
          author: story.author || 'Anonymous',
          text: story.text,
          score: store.pendingWinner.score,
          publishedAt: now.toISOString(),
          prize: '$20 gift card',
          status: 'published'
        };
        store.hallOfFame.unshift(entry);
        store.giftCards.unshift({
          id: id('gift'),
          hallOfFameId: entry.id,
          storyId: story.id,
          amount: 20,
          currency: 'USD',
          status: 'pending',
          createdAt: now.toISOString()
        });
      }
    }
    store.pendingWinner = null;
    saveStore(store);
  }
}

function runWeeklyWinnerAutomationLocked() {
  if (hallOfFameRunPromise) return hallOfFameRunPromise;
  hallOfFameRunPromise = Promise.resolve()
    .then(() => runWeeklyWinnerAutomation())
    .finally(() => {
      hallOfFameRunPromise = null;
    });
  return hallOfFameRunPromise;
}

async function ingestPositiveStories() {
  const url = 'https://www.reddit.com/r/MadeMeSmile/top.json?limit=60&t=day';
  const response = await fetch(url, {
    headers: { 'User-Agent': 'made-my-day-bot/1.0' },
    signal: AbortSignal.timeout(SAFE_IMPORT_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`source fetch failed: ${response.status}`);
  const data = await response.json();
  const posts = data?.data?.children?.map((c) => c.data) || [];

  const store = loadStore();
  const existingLinks = new Set(store.stories.map((s) => s.sourceUrl).filter(Boolean));
  const existingTitles = new Set(store.stories.map((s) => s.text.trim().toLowerCase()));

  const candidates = posts
    .filter((p) => !p.over_18)
    .map((p) => {
      const title = (p.title || '').trim();
      const body = (p.selftext || '').trim();
      const combined = body ? `${title}\n\n${body}` : title;
      return {
        text: combined,
        sourceUrl: sanitizeSourceUrl(`https://reddit.com${p.permalink}`),
        sourceName: sanitizeSourceName('reddit/r/MadeMeSmile'),
        score: p.score || 0
      };
    })
    .filter((p) => p.text.length >= 40)
    .map((p) => ({ ...p, text: p.text.slice(0, 2500) }))
    .filter((p) => Boolean(p.sourceUrl))
    .filter((p) => !existingLinks.has(p.sourceUrl) && !existingTitles.has(p.text.toLowerCase()))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (!candidates.length) return { added: 0, source: 'reddit/r/MadeMeSmile' };

  // 5 per hour at random times inside the hour window.
  const selected = candidates.slice(0, 5);
  const now = Date.now();
  const hourEnd = new Date();
  hourEnd.setMinutes(59, 59, 999);
  const windowMs = Math.max(5 * 60 * 1000, hourEnd.getTime() - now);

  const offsets = selected
    .map(() => Math.floor(Math.random() * windowMs))
    .sort((a, b) => a - b);

  selected.forEach((item, index) => {
    const publishAt = new Date(now + offsets[index]).toISOString();
    store.stories.unshift({
      id: id('story'),
      text: item.text,
      author: 'Community highlight',
      createdAt: publishAt,
      likes: 0,
      shares: 0,
      sourceUrl: sanitizeSourceUrl(item.sourceUrl),
      sourceName: sanitizeSourceName(item.sourceName),
      autoImported: true
    });
  });

  saveStore(store);
  return { added: selected.length, source: 'reddit/r/MadeMeSmile' };
}

async function runIngestJob() {
  if (importRunPromise) return importRunPromise;

  importRunPromise = (async () => {
    const startedAt = new Date().toISOString();
    try {
      const result = await ingestPositiveStories();
      lastImportRun = {
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        added: result.added || 0,
        source: result.source || 'reddit/r/MadeMeSmile'
      };
      return result;
    } catch (error) {
      lastImportRun = {
        ok: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        added: 0,
        error: error?.name === 'TimeoutError' ? `source fetch timed out after ${SAFE_IMPORT_TIMEOUT_MS}ms` : String(error?.message || error),
        source: 'reddit/r/MadeMeSmile'
      };
      throw error;
    } finally {
      importRunPromise = null;
    }
  })();

  return importRunPromise;
}

// run once on boot + every hour
const importBootTimeout = setTimeout(() => runIngestJob().catch(() => null), 1500);
const importInterval = setInterval(() => runIngestJob().catch(() => null), 60 * 60 * 1000);

// winner automation checks every minute
const winnerBootTimeout = setTimeout(() => runWeeklyWinnerAutomationLocked().catch(() => null), 2000);
const winnerInterval = setInterval(() => runWeeklyWinnerAutomationLocked().catch(() => null), 60 * 1000);

function getRequestId(req) {
  const incoming = req.headers['x-request-id'];
  if (Array.isArray(incoming)) {
    return { requestId: `req_${crypto.randomUUID()}`, malformed: true };
  }
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (trimmed.includes(',')) {
      return { requestId: `req_${crypto.randomUUID()}`, malformed: true };
    }
    if (trimmed.length >= 8 && trimmed.length <= 128 && /^[a-zA-Z0-9:_\-.]+$/.test(trimmed)) {
      return { requestId: trimmed, malformed: false };
    }
    if (trimmed.length > 0) {
      return { requestId: `req_${crypto.randomUUID()}`, malformed: true };
    }
  }
  return { requestId: `req_${crypto.randomUUID()}`, malformed: false };
}

function hasDuplicateHostHeader(req) {
  if (!Array.isArray(req.rawHeaders)) return false;
  let hostHeaderCount = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i] || '').toLowerCase() === 'host') {
      hostHeaderCount += 1;
      if (hostHeaderCount > 1) return true;
    }
  }
  return false;
}

function hasDuplicateRawHeader(req, targetName) {
  if (!Array.isArray(req.rawHeaders)) return false;
  const normalizedTarget = String(targetName || '').toLowerCase();
  if (!normalizedTarget) return false;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i] || '').toLowerCase() === normalizedTarget) {
      count += 1;
      if (count > 1) return true;
    }
  }
  return false;
}

function hasMethodOverrideHeader(req) {
  const value = req.headers['x-http-method-override'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasLegacyMethodOverrideHeader(req) {
  const legacyHeaderNames = ['x-method-override', 'x-http-method', 'x-method'];
  return legacyHeaderNames.some((headerName) => {
    const value = req.headers[headerName];
    if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
    return typeof value === 'string' && value.trim() !== '';
  });
}

function hasExpectHeader(req) {
  const value = req.headers.expect;
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasUpgradeHeader(req) {
  const value = req.headers.upgrade;
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasProxyConnectionHeader(req) {
  const value = req.headers['proxy-connection'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasViaHeader(req) {
  const value = req.headers.via;
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasProxyAuthorizationHeader(req) {
  const value = req.headers['proxy-authorization'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasEarlyDataHeader(req) {
  const value = req.headers['early-data'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasAltUsedHeader(req) {
  const value = req.headers['alt-used'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasPathOverrideHeader(req) {
  const originalUrl = req.headers['x-original-url'];
  const rewriteUrl = req.headers['x-rewrite-url'];
  const hasValue = (value) => {
    if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
    return typeof value === 'string' && value.trim() !== '';
  };
  return hasValue(originalUrl) || hasValue(rewriteUrl);
}

function hasAnyForwardingHeader(req) {
  return [
    'x-forwarded-for',
    'forwarded',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-forwarded-prefix',
    'x-forwarded-server'
  ].some((headerName) => typeof req.headers[headerName] !== 'undefined');
}

function hasValidForwardedPrefixHeader(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized.includes(',')) return false;
  if (/[^\x20-\x7E]/.test(normalized)) return false;
  if (!normalized.startsWith('/')) return false;
  if (normalized.includes('//')) return false;
  return true;
}

function hasTeHeader(req) {
  const value = req.headers.te;
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasTrailerHeader(req) {
  const value = req.headers.trailer;
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasContentRangeHeader(req) {
  const value = req.headers['content-range'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasKeepAliveHeader(req) {
  const value = req.headers['keep-alive'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim() !== '');
  return typeof value === 'string' && value.trim() !== '';
}

function hasUnsupportedConnectionHeader(req) {
  const value = req.headers.connection;
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const allowedTokens = new Set(['keep-alive', 'close']);
  const tokens = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return tokens.some((token) => !allowedTokens.has(token));
}

function hasTraceMethod(req) {
  return String(req.method || '').toUpperCase() === 'TRACE';
}

function hasConnectMethod(req) {
  return String(req.method || '').toUpperCase() === 'CONNECT';
}

function getNormalizedHostHeader(req) {
  return String(req.headers.host || '').trim().toLowerCase();
}

function isValidIncomingHostHeader(hostHeader) {
  if (!hostHeader) return false;
  if (hostHeader.length > 255) return false;
  if (/[\u0000-\u001F\u007F\s]/.test(hostHeader)) return false;
  if (/[,\\/]/.test(hostHeader)) return false;
  return parseAllowedHostEntry(hostHeader) !== null;
}

function isAllowedHost(req) {
  const incomingHost = getNormalizedHostHeader(req);
  if (!isValidIncomingHostHeader(incomingHost)) return false;
  if (ALLOWED_HOSTS.length === 0) return true;
  return ALLOWED_HOSTS.includes(incomingHost);
}

let shuttingDown = false;

const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (req, res) => {
  const { requestId, malformed: malformedRequestId } = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  try {
    if (shuttingDown) {
      return json(
        res,
        503,
        { error: 'server is shutting down' },
        {
          headers: {
            'Retry-After': '5',
            Connection: 'close'
          }
        }
      );
    }
    if (malformedRequestId) {
      return json(res, 400, { error: 'invalid x-request-id header' });
    }
    if (hasDuplicateHostHeader(req)) {
      return json(res, 400, { error: 'Duplicate Host headers are not allowed' });
    }
    if (hasMethodOverrideHeader(req)) {
      return json(res, 400, { error: 'x-http-method-override header is not allowed' });
    }
    if (hasLegacyMethodOverrideHeader(req)) {
      return json(res, 400, { error: 'legacy method override headers are not allowed' });
    }
    if (hasExpectHeader(req)) {
      return json(res, 417, { error: 'expect header is not allowed' });
    }
    if (hasUpgradeHeader(req)) {
      return json(res, 400, { error: 'upgrade header is not allowed' });
    }
    if (hasProxyConnectionHeader(req)) {
      return json(res, 400, { error: 'proxy-connection header is not allowed' });
    }
    if (hasViaHeader(req)) {
      return json(res, 400, { error: 'via header is not allowed' });
    }
    if (hasProxyAuthorizationHeader(req)) {
      return json(res, 400, { error: 'proxy-authorization header is not allowed' });
    }
    if (hasEarlyDataHeader(req)) {
      return json(res, 400, { error: 'early-data header is not allowed' });
    }
    if (hasAltUsedHeader(req)) {
      return json(res, 400, { error: 'alt-used header is not allowed' });
    }
    if (hasPathOverrideHeader(req)) {
      return json(res, 400, { error: 'path override headers are not allowed' });
    }
    if (hasTeHeader(req)) {
      return json(res, 400, { error: 'te header is not allowed' });
    }
    if (hasTrailerHeader(req)) {
      return json(res, 400, { error: 'trailer header is not allowed' });
    }
    if (hasContentRangeHeader(req)) {
      return json(res, 400, { error: 'content-range header is not allowed' });
    }
    if (hasKeepAliveHeader(req)) {
      return json(res, 400, { error: 'keep-alive header is not allowed' });
    }
    if (hasUnsupportedConnectionHeader(req)) {
      return json(res, 400, { error: 'connection header contains unsupported tokens' });
    }
    if (hasTraceMethod(req) || hasConnectMethod(req)) {
      return json(res, 405, { error: 'TRACE/CONNECT methods are not allowed' }, { headers: { Allow: 'GET, HEAD, POST' } });
    }
    if (!TRUST_PROXY && hasAnyForwardingHeader(req)) {
      return json(res, 400, { error: 'forwarding headers require trusted proxy mode' });
    }
    if (TRUST_PROXY && (hasDuplicateRawHeader(req, 'x-forwarded-for') || hasDuplicateRawHeader(req, 'forwarded') || hasDuplicateRawHeader(req, 'x-forwarded-host') || hasDuplicateRawHeader(req, 'x-forwarded-proto') || hasDuplicateRawHeader(req, 'x-forwarded-port') || hasDuplicateRawHeader(req, 'x-forwarded-prefix') || hasDuplicateRawHeader(req, 'x-forwarded-server'))) {
      return json(res, 400, { error: 'Duplicate forwarding headers are not allowed' });
    }
    if (TRUST_PROXY) {
      const forwardedFor = req.headers['x-forwarded-for'];
      const forwarded = req.headers.forwarded;
      const forwardedHost = req.headers['x-forwarded-host'];
      const forwardedProto = req.headers['x-forwarded-proto'];
      const forwardedPort = req.headers['x-forwarded-port'];
      const forwardedPrefix = req.headers['x-forwarded-prefix'];
      const forwardedServer = req.headers['x-forwarded-server'];
      if (
        (typeof forwardedFor === 'string' && forwardedFor.includes(',')) ||
        (typeof forwarded === 'string' && forwarded.includes(',')) ||
        (typeof forwardedHost === 'string' && forwardedHost.includes(',')) ||
        (typeof forwardedProto === 'string' && forwardedProto.includes(',')) ||
        (typeof forwardedPort === 'string' && forwardedPort.includes(',')) ||
        (typeof forwardedPrefix === 'string' && forwardedPrefix.includes(',')) ||
        (typeof forwardedServer === 'string' && forwardedServer.includes(','))
      ) {
        return json(res, 400, { error: 'Multi-hop forwarding headers are not allowed' });
      }
      if (typeof forwardedFor === 'string' && forwardedFor.trim() !== '' && !hasValidSingleForwardedForHeader(forwardedFor)) {
        return json(res, 400, { error: 'invalid x-forwarded-for header' });
      }
      if (typeof forwarded === 'string' && forwarded.trim() !== '' && !hasValidSingleForwardedHeader(forwarded)) {
        return json(res, 400, { error: 'invalid forwarded header' });
      }
      if (typeof forwardedHost === 'string' && forwardedHost.trim() !== '' && !isValidIncomingHostHeader(forwardedHost.trim().toLowerCase())) {
        return json(res, 400, { error: 'invalid x-forwarded-host header' });
      }
      if (typeof forwardedProto === 'string' && forwardedProto.trim() !== '' && !/^https?$/i.test(forwardedProto.trim())) {
        return json(res, 400, { error: 'invalid x-forwarded-proto header' });
      }
      if (typeof forwardedPort === 'string' && forwardedPort.trim() !== '' && !/^\d{1,5}$/.test(forwardedPort.trim())) {
        return json(res, 400, { error: 'invalid x-forwarded-port header' });
      }
      if (typeof forwardedPort === 'string' && forwardedPort.trim() !== '') {
        const port = Number(forwardedPort.trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return json(res, 400, { error: 'invalid x-forwarded-port header' });
        }
      }
      if (typeof forwardedPrefix === 'string' && forwardedPrefix.trim() !== '' && !hasValidForwardedPrefixHeader(forwardedPrefix)) {
        return json(res, 400, { error: 'invalid x-forwarded-prefix header' });
      }
      if (typeof forwardedServer === 'string' && forwardedServer.trim() !== '') {
        const normalizedForwardedServer = forwardedServer.trim();
        if (
          normalizedForwardedServer.length > 255 ||
          /[\u0000-\u001F\u007F\s,\/]/.test(normalizedForwardedServer) ||
          !/^[a-z0-9._:-]+$/i.test(normalizedForwardedServer)
        ) {
          return json(res, 400, { error: 'invalid x-forwarded-server header' });
        }
      }
    }
    const rawUrl = typeof req.url === 'string' ? req.url : '';
    if (!rawUrl.startsWith('/')) {
      return json(res, 400, { error: 'origin-form request-target required' });
    }
    if (rawUrl.length > MAX_URL_CHARS) {
      return json(res, 414, {
        error: 'Request URL too long',
        maxUrlChars: MAX_URL_CHARS
      });
    }

    const declaredContentLength = parseDeclaredContentLength(req.headers['content-length']);
    if (declaredContentLength?.invalid) {
      return json(res, 400, { error: 'invalid content-length header' });
    }
    if (hasTransferEncodingHeader(req.headers['transfer-encoding']) && Number.isFinite(declaredContentLength?.value)) {
      return json(res, 400, { error: 'ambiguous request framing' });
    }

    if (!isAllowedHost(req)) {
      return json(res, 421, { error: 'Request host not allowed' });
    }

    const normalizedHost = getNormalizedHostHeader(req);
    const urlBaseHost = isValidIncomingHostHeader(normalizedHost) ? normalizedHost : `localhost:${PORT}`;
    const u = new URL(rawUrl, `http://${urlBaseHost}`);
    if (u.search.length > MAX_QUERY_CHARS + 1) {
      return json(res, 414, {
        error: 'Request query too long',
        maxQueryChars: MAX_QUERY_CHARS
      });
    }

  if (u.pathname.startsWith('/api/')) {
    const rateLimit = getRateLimitState(req);
    if (rateLimit.enforced) {
      res.setHeader('RateLimit-Limit', String(rateLimit.limit));
      res.setHeader('RateLimit-Remaining', String(rateLimit.remaining));
      res.setHeader('RateLimit-Reset', String(rateLimit.resetSeconds));
      res.setHeader('RateLimit-Policy', `${rateLimit.limit};w=${rateLimit.windowSeconds}`);
      // Legacy compatibility for clients/proxies that still rely on pre-RFC header names.
      res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
      res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
      res.setHeader('X-RateLimit-Reset', String(rateLimit.resetSeconds));
    }
    if (rateLimit.limited) {
      res.setHeader('Retry-After', String(rateLimit.resetSeconds));
      return json(res, 429, {
        error: 'Rate limit exceeded. Please wait and try again.',
        retryAfterSeconds: rateLimit.resetSeconds
      });
    }

    const store = loadStore();

    if (u.pathname === '/api/health/live' && !isGetOrHead(req)) {
      return methodNotAllowed(res, ['GET', 'HEAD']);
    }

    if (u.pathname === '/api/health/live') {
      return json(res, 200, {
        ok: true,
        service: 'made-my-day',
        uptimeSeconds: Math.floor(process.uptime())
      });
    }

    if (u.pathname === '/api/health/version' && !isGetOrHead(req)) {
      return methodNotAllowed(res, ['GET', 'HEAD']);
    }

    if (isGetOrHead(req) && u.pathname === '/api/health/version') {
      return json(res, 200, { ok: true, ...getVersionSnapshot() });
    }

    if (u.pathname === '/api/health' && !isGetOrHead(req)) {
      return methodNotAllowed(res, ['GET', 'HEAD']);
    }

    if (isGetOrHead(req) && u.pathname === '/api/health') {
      const configuredToken = getConfiguredAdminToken();
      return json(res, 200, {
        ok: true,
        service: 'made-my-day',
        stories: store.stories.length,
        adminAuth: {
          mode: configuredToken ? 'enabled' : 'preview',
          strongToken: configuredToken ? hasStrongAdminToken() : true,
          source: String(process.env.MADE_MY_DAY_ADMIN_TOKEN || '').trim() ? 'env' : (process.env.MADE_MY_DAY_ADMIN_TOKEN_FILE ? 'file' : 'none'),
          rotationFallbackEnabled: Boolean(String(process.env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS || '').trim() || process.env.MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE)
        },
        imports: {
          timeoutMs: SAFE_IMPORT_TIMEOUT_MS,
          maxBodyBytes: MAX_BODY_BYTES,
          maxUrlChars: MAX_URL_CHARS,
          maxHeaderBytes: MAX_HEADER_BYTES,
          maxCommentsPerStory: MAX_COMMENTS_PER_STORY,
          lastRun: lastImportRun
        }
      });
    }

    if (u.pathname === '/api/health/ready' && !isGetOrHead(req)) {
      return methodNotAllowed(res, ['GET', 'HEAD']);
    }

    if (isGetOrHead(req) && u.pathname === '/api/health/ready') {
      const readiness = getReadinessStatus();
      const headers = readiness.ready ? undefined : { 'Retry-After': '30' };
      return json(res, readiness.ready ? 200 : 503, {
        ok: readiness.ready,
        service: 'made-my-day',
        checkedAt: new Date().toISOString(),
        checks: readiness.checks,
        issueCodes: readiness.issueCodes
      }, { headers });
    }

    if (u.pathname === '/api/health/details' && !isGetOrHead(req)) {
      return methodNotAllowed(res, ['GET', 'HEAD']);
    }

    if (isGetOrHead(req) && u.pathname === '/api/health/details') {
      if (!requireAdminAuth(req, res)) return;
      const readiness = getReadinessStatus();
      const windowHours = parseBoundedInt(u.searchParams.get('windowHours'), 0, { min: 0, max: 24 * 90 });
      return json(res, 200, {
        ok: true,
        service: 'made-my-day',
        readiness,
        operations: getOperationalSnapshot(store, { windowHours }),
        escalation: getEscalationSnapshot()
      });
    }


    const readOnlyApiPaths = new Set([
      '/api/admin/hall-of-fame.csv',
      '/api/admin/gift-cards.csv',
      '/api/admin/hall-of-fame',
      '/api/admin/gift-cards',
      '/api/hall-of-fame'
    ]);
    if (readOnlyApiPaths.has(u.pathname) && !isGetOrHead(req)) {
      return methodNotAllowed(res, ['GET', 'HEAD']);
    }

    if (isGetOrHead(req) && u.pathname === '/api/admin/hall-of-fame.csv') {
      if (!requireAdminAuth(req, res)) return;
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const records = store.hallOfFame.slice(offset, offset + limit);
      const total = store.hallOfFame.length;
      const linkHeader = buildPaginationLinks('api/admin/hall-of-fame.csv', limit, offset, records.length, total);
      const rows = [['storyId', 'publishedAt', 'score', 'giftCardCode', 'notifiedAt']].concat(
        records.map((entry) => [entry.storyId, entry.publishedAt, entry.score, entry.giftCardCode, entry.notifiedAt])
      );
      return csv(res, 200, rows, { headers: linkHeader ? { Link: linkHeader } : undefined });
    }

    if (isGetOrHead(req) && u.pathname === '/api/admin/gift-cards.csv') {
      if (!requireAdminAuth(req, res)) return;
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const records = store.giftCards.slice(offset, offset + limit);
      const total = store.giftCards.length;
      const linkHeader = buildPaginationLinks('api/admin/gift-cards.csv', limit, offset, records.length, total);
      const rows = [['storyId', 'code', 'status', 'amountUsd', 'queuedAt', 'issuedAt']].concat(
        records.map((entry) => [entry.storyId, entry.code, entry.status, entry.amountUsd, entry.queuedAt, entry.issuedAt])
      );
      return csv(res, 200, rows, { headers: linkHeader ? { Link: linkHeader } : undefined });
    }

    if (isGetOrHead(req) && u.pathname === '/api/admin/hall-of-fame') {
      if (!requireAdminAuth(req, res)) return;
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const total = store.hallOfFame.length;
      const records = store.hallOfFame.slice(offset, offset + limit);
      const nextOffset = offset + records.length < total ? offset + records.length : null;
      const linkHeader = buildPaginationLinks('api/admin/hall-of-fame', limit, offset, records.length, total);
      return json(res, 200, {
        records,
        pagination: {
          total,
          limit,
          offset,
          hasMore: nextOffset !== null,
          nextOffset
        }
      }, {
        headers: linkHeader ? { Link: linkHeader } : undefined
      });
    }

    if (isGetOrHead(req) && u.pathname === '/api/admin/gift-cards') {
      if (!requireAdminAuth(req, res)) return;
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const total = store.giftCards.length;
      const records = store.giftCards.slice(offset, offset + limit);
      const nextOffset = offset + records.length < total ? offset + records.length : null;
      const linkHeader = buildPaginationLinks('api/admin/gift-cards', limit, offset, records.length, total);
      return json(res, 200, {
        records,
        pagination: {
          total,
          limit,
          offset,
          hasMore: nextOffset !== null,
          nextOffset
        }
      }, {
        headers: linkHeader ? { Link: linkHeader } : undefined
      });
    }

    if (isGetOrHead(req) && u.pathname === '/api/stories') {
      const activeHall = store.hallOfFame.find((h) => Date.now() - new Date(h.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000);
      const limitRaw = Number(u.searchParams.get('limit') || 100);
      const offsetRaw = Number(u.searchParams.get('offset') || 0);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

      const orderedStories = store.stories
        .slice()
        .sort((a, b) => {
          if (activeHall?.storyId === a.id) return -1;
          if (activeHall?.storyId === b.id) return 1;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });

      const totalStories = orderedStories.length;
      const pagedStories = orderedStories
        .slice(offset, offset + limit)
        .map((s) => storyView(s, store));

      const nextOffset = offset + pagedStories.length < totalStories ? offset + pagedStories.length : null;
      const linkHeader = buildPaginationLinks('api/stories', limit, offset, pagedStories.length, totalStories);
      return jsonCached(req, res, 200, {
        stories: pagedStories,
        pagination: {
          total: totalStories,
          limit,
          offset,
          hasMore: nextOffset !== null,
          nextOffset
        },
        activeHallOfFameStoryId: activeHall?.storyId || null
      }, {
        headers: linkHeader ? { Link: linkHeader } : undefined
      });
    }

    if (isGetOrHead(req) && u.pathname === '/api/hall-of-fame') {
      const limitRaw = Number(u.searchParams.get('limit') || 100);
      const offsetRaw = Number(u.searchParams.get('offset') || 0);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
      const total = store.hallOfFame.length;
      const hallSlice = store.hallOfFame.slice(offset, offset + limit);
      const nextOffset = offset + hallSlice.length < total ? offset + hallSlice.length : null;
      const linkHeader = buildPaginationLinks('api/hall-of-fame', limit, offset, hallSlice.length, total);
      return jsonCached(req, res, 200, {
        hallOfFame: hallSlice,
        pagination: {
          total,
          limit,
          offset,
          hasMore: nextOffset !== null,
          nextOffset
        },
        pendingWinner: store.pendingWinner
      }, {
        headers: linkHeader ? { Link: linkHeader } : undefined
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/stories') {
      const jsonContentType = getJsonContentTypeStatus(req);
      if (jsonContentType.malformed) {
        return json(res, 400, { error: 'invalid content-type header' });
      }
      if (!jsonContentType.ok) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const acceptStatus = acceptsJsonResponse(req);
      if (acceptStatus.malformed) return json(res, 400, { error: 'invalid accept header' });
      if (!acceptStatus.ok) return json(res, 406, { error: 'Accept must allow application/json.' });
      const body = await readBody(req).catch((error) => {
        handleBodyReadError(res, error);
        return null;
      });
      if (!body) return;
      const incomingText = sanitizeUserText(body?.text, MAX_STORY_CHARS);
      if (!incomingText || incomingText.length < 40) {
        return json(res, 400, { error: 'Story must be at least 40 characters.' });
      }
      const parsedIdempotency = parseIdempotencyKey(req);
      if (parsedIdempotency.malformed) {
        return json(res, 400, { error: 'invalid idempotency-key header' });
      }
      const idempotencyKey = parsedIdempotency.key;
      const existingByIdempotency = findRecentIdempotentStory(store, idempotencyKey);
      if (existingByIdempotency) {
        return json(res, 200, { story: storyView(existingByIdempotency, store), idempotent: true });
      }
      const duplicate = store.stories.some((s) => {
        if (!s?.createdAt) return false;
        const ageMs = Date.now() - new Date(s.createdAt).getTime();
        if (!Number.isFinite(ageMs) || ageMs > 7 * 24 * 60 * 60 * 1000) return false;
        return normalizeText(s.text) === normalizeText(incomingText);
      });
      if (duplicate) {
        return json(
          res,
          409,
          {
            error: 'A very similar story was already posted recently.',
            retryAfterSeconds: 3600,
            duplicateWindowDays: 7
          },
          { headers: { 'Retry-After': '3600' } }
        );
      }
      const story = {
        id: id('story'),
        text: incomingText,
        author: body.author ? sanitizeUserText(body.author, MAX_AUTHOR_CHARS) : 'Anonymous',
        createdAt: new Date().toISOString(),
        likes: 0,
        shares: 0,
        sourceUrl: null,
        sourceName: null,
        autoImported: false
      };
      store.stories.unshift(story);
      rememberIdempotentStory(store, idempotencyKey, story.id);
      saveStore(store);
      return json(res, 201, { story: storyView(story, store) });
    }

    if (req.method === 'POST' && u.pathname.match(/^\/api\/stories\/[^/]+\/like$/)) {
      const jsonContentType = getJsonContentTypeStatus(req);
      if (jsonContentType.malformed) {
        return json(res, 400, { error: 'invalid content-type header' });
      }
      if (!jsonContentType.ok) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const acceptStatus = acceptsJsonResponse(req);
      if (acceptStatus.malformed) return json(res, 400, { error: 'invalid accept header' });
      if (!acceptStatus.ok) return json(res, 406, { error: 'Accept must allow application/json.' });
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });

      const parsedIdempotency = parseIdempotencyKey(req);
      if (parsedIdempotency.malformed) {
        return json(res, 400, { error: 'invalid idempotency-key header' });
      }
      const idempotencyKey = parsedIdempotency.key;
      const idempotentScope = `story-like:${storyId}`;
      const prior = getEngagementIdempotent(idempotentScope, idempotencyKey);
      if (prior) return json(res, 200, { ...prior, idempotent: true });

      story.likes += 1;
      saveStore(store);
      const result = { likes: story.likes };
      rememberEngagementIdempotent(idempotentScope, idempotencyKey, result);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && u.pathname.match(/^\/api\/stories\/[^/]+\/share$/)) {
      const jsonContentType = getJsonContentTypeStatus(req);
      if (jsonContentType.malformed) {
        return json(res, 400, { error: 'invalid content-type header' });
      }
      if (!jsonContentType.ok) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const acceptStatus = acceptsJsonResponse(req);
      if (acceptStatus.malformed) return json(res, 400, { error: 'invalid accept header' });
      if (!acceptStatus.ok) return json(res, 406, { error: 'Accept must allow application/json.' });
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });

      const parsedIdempotency = parseIdempotencyKey(req);
      if (parsedIdempotency.malformed) {
        return json(res, 400, { error: 'invalid idempotency-key header' });
      }
      const idempotencyKey = parsedIdempotency.key;
      const idempotentScope = `story-share:${storyId}`;
      const prior = getEngagementIdempotent(idempotentScope, idempotencyKey);
      if (prior) return json(res, 200, { ...prior, idempotent: true });

      story.shares += 1;
      saveStore(store);
      const result = { shares: story.shares };
      rememberEngagementIdempotent(idempotentScope, idempotencyKey, result);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && u.pathname.match(/^\/api\/stories\/[^/]+\/comments$/)) {
      const jsonContentType = getJsonContentTypeStatus(req);
      if (jsonContentType.malformed) {
        return json(res, 400, { error: 'invalid content-type header' });
      }
      if (!jsonContentType.ok) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const acceptStatus = acceptsJsonResponse(req);
      if (acceptStatus.malformed) return json(res, 400, { error: 'invalid accept header' });
      if (!acceptStatus.ok) return json(res, 406, { error: 'Accept must allow application/json.' });
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });

      const parsedIdempotency = parseIdempotencyKey(req);
      if (parsedIdempotency.malformed) {
        return json(res, 400, { error: 'invalid idempotency-key header' });
      }
      const idempotencyKey = parsedIdempotency.key;
      const idempotentScope = `story-comment:${storyId}`;
      const prior = getEngagementIdempotent(idempotentScope, idempotencyKey);
      if (prior) return json(res, 200, { ...prior, idempotent: true });

      const body = await readBody(req).catch((error) => {
        handleBodyReadError(res, error);
        return null;
      });
      if (!body) return;
      const commentText = sanitizeUserText(body?.text, MAX_COMMENT_CHARS);
      if (!commentText || commentText.length < 2) {
        return json(res, 400, { error: 'Comment is too short.' });
      }
      const existingCommentCount = store.comments.filter((entry) => entry.storyId === storyId).length;
      if (existingCommentCount >= MAX_COMMENTS_PER_STORY) {
        return json(res, 409, {
          error: 'Comment limit reached for this story.',
          maxCommentsPerStory: MAX_COMMENTS_PER_STORY
        });
      }

      const normalizedAuthor = body.author ? sanitizeUserText(body.author, MAX_AUTHOR_CHARS) : '';
      const comment = {
        id: id('com'),
        storyId,
        text: commentText,
        author: normalizedAuthor || 'Anonymous',
        createdAt: new Date().toISOString()
      };
      store.comments.push(comment);
      saveStore(store);
      const result = { comment };
      rememberEngagementIdempotent(idempotentScope, idempotencyKey, result);
      return json(res, 201, result);
    }

    if (req.method === 'POST' && u.pathname === '/api/import/run') {
      const jsonContentType = getJsonContentTypeStatus(req);
      if (jsonContentType.malformed) {
        return json(res, 400, { error: 'invalid content-type header' });
      }
      if (!jsonContentType.ok) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const acceptStatus = acceptsJsonResponse(req);
      if (acceptStatus.malformed) return json(res, 400, { error: 'invalid accept header' });
      if (!acceptStatus.ok) return json(res, 406, { error: 'Accept must allow application/json.' });
      if (!requireAdminAuth(req, res)) return;
      try {
        await readBody(req);
      } catch (error) {
        handleBodyReadError(res, error);
        return;
      }
      const idempotency = parseIdempotencyKey(req);
      if (idempotency.malformed) {
        return json(res, 400, { error: 'invalid idempotency-key header' });
      }
      const idempotencyKey = idempotency.key;
      const priorResult = getAdminRunIdempotent('import-run', idempotencyKey);
      if (priorResult) return json(res, 200, { ...priorResult, idempotent: true });
      if (importRunPromise) {
        return json(
          res,
          409,
          { error: 'import run already in progress', retryAfterSeconds: 5 },
          { headers: { 'Retry-After': '5' } }
        );
      }
      const result = await runIngestJob().catch((error) => ({ added: 0, error: error?.message || String(error) }));
      if (idempotencyKey) {
        const cacheable = { ...result, idempotent: false };
        rememberAdminRunIdempotent('import-run', idempotencyKey, cacheable);
        return json(res, 200, cacheable);
      }
      return json(res, 200, result);
    }

    if (req.method === 'POST' && u.pathname === '/api/hall-of-fame/run') {
      const jsonContentType = getJsonContentTypeStatus(req);
      if (jsonContentType.malformed) {
        return json(res, 400, { error: 'invalid content-type header' });
      }
      if (!jsonContentType.ok) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const acceptStatus = acceptsJsonResponse(req);
      if (acceptStatus.malformed) return json(res, 400, { error: 'invalid accept header' });
      if (!acceptStatus.ok) return json(res, 406, { error: 'Accept must allow application/json.' });
      if (!requireAdminAuth(req, res)) return;
      try {
        await readBody(req);
      } catch (error) {
        handleBodyReadError(res, error);
        return;
      }
      const idempotency = parseIdempotencyKey(req);
      if (idempotency.malformed) {
        return json(res, 400, { error: 'invalid idempotency-key header' });
      }
      const idempotencyKey = idempotency.key;
      const priorResult = getAdminRunIdempotent('hall-of-fame-run', idempotencyKey);
      if (priorResult) return json(res, 200, { ...priorResult, idempotent: true });
      if (hallOfFameRunPromise) {
        return json(
          res,
          409,
          { error: 'hall-of-fame run already in progress', retryAfterSeconds: 5 },
          { headers: { 'Retry-After': '5' } }
        );
      }
      await runWeeklyWinnerAutomationLocked();
      const refreshed = loadStore();
      const result = {
        ok: true,
        pendingWinner: refreshed.pendingWinner,
        latestWinner: refreshed.hallOfFame[0] || null,
        giftCardQueue: refreshed.giftCards.slice(0, 5)
      };
      if (idempotencyKey) {
        const cacheable = { ...result, idempotent: false };
        rememberAdminRunIdempotent('hall-of-fame-run', idempotencyKey, cacheable);
        return json(res, 200, cacheable);
      }
      return json(res, 200, result);
    }

    return json(res, 404, { error: 'not found' });
  }

  if (u.pathname === '/' || u.pathname === '/index.html') {
    if (!isGetOrHead(req)) return methodNotAllowed(res, ['GET', 'HEAD']);
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (u.pathname === '/app.js') {
    if (!isGetOrHead(req)) return methodNotAllowed(res, ['GET', 'HEAD']);
    return sendFile(res, path.join(PUBLIC_DIR, 'app.js'));
  }
  if (u.pathname === '/styles.css') {
    if (!isGetOrHead(req)) return methodNotAllowed(res, ['GET', 'HEAD']);
    return sendFile(res, path.join(PUBLIC_DIR, 'styles.css'));
  }

  res.writeHead(404);
  res.end('Not found');
  } catch (error) {
    console.error(`[${requestId}] unhandled request error`, error);
    if (!res.headersSent) {
      json(res, 500, { error: 'internal server error', requestId });
      return;
    }
    res.end();
  }
});

function resolveServerTimeouts(env = process.env) {
  const requestTimeoutRaw = Number(env.REQUEST_TIMEOUT_MS || 30_000);
  const headersTimeoutRaw = Number(env.HEADERS_TIMEOUT_MS || 15_000);
  const keepAliveTimeoutRaw = Number(env.KEEP_ALIVE_TIMEOUT_MS || 5_000);

  const requestTimeout = Number.isFinite(requestTimeoutRaw) && requestTimeoutRaw >= 1_000
    ? Math.floor(requestTimeoutRaw)
    : 30_000;
  const headersTimeoutCandidate = Number.isFinite(headersTimeoutRaw) && headersTimeoutRaw >= 1_000
    ? Math.floor(headersTimeoutRaw)
    : 15_000;
  const keepAliveTimeoutCandidate = Number.isFinite(keepAliveTimeoutRaw) && keepAliveTimeoutRaw >= 1_000
    ? Math.floor(keepAliveTimeoutRaw)
    : 5_000;

  let headersTimeout = Math.min(headersTimeoutCandidate, requestTimeout);
  let keepAliveTimeout = Math.min(keepAliveTimeoutCandidate, headersTimeout);

  if ((headersTimeout - keepAliveTimeout) < 1000) {
    if ((requestTimeout - keepAliveTimeout) >= 1000) {
      headersTimeout = keepAliveTimeout + 1000;
    } else {
      keepAliveTimeout = Math.max(1000, headersTimeout - 1000);
    }
  }

  return {
    requestTimeout,
    headersTimeout,
    keepAliveTimeout,
    maxRequestsPerSocket: MAX_REQUESTS_PER_SOCKET,
    maxHeadersCount: MAX_HEADERS_COUNT
  };
}

const resolvedTimeouts = resolveServerTimeouts(process.env);
server.requestTimeout = resolvedTimeouts.requestTimeout;
server.headersTimeout = resolvedTimeouts.headersTimeout;
server.keepAliveTimeout = resolvedTimeouts.keepAliveTimeout;
server.maxRequestsPerSocket = resolvedTimeouts.maxRequestsPerSocket;
server.maxHeadersCount = resolvedTimeouts.maxHeadersCount;

server.on('clientError', (error, socket) => {
  if (!socket || !socket.writable) return;
  const statusCode = error?.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  const statusText = statusCode === 431 ? 'Request Header Fields Too Large' : 'Bad Request';
  const response = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store, private, max-age=0',
    'Pragma: no-cache',
    'Expires: 0',
    'X-Content-Type-Options: nosniff',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n');
  socket.end(response);
});

server.on('connect', (_req, socket) => {
  if (!socket || !socket.writable) return;
  const response = [
    'HTTP/1.1 405 Method Not Allowed',
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store, private, max-age=0',
    'Pragma: no-cache',
    'Expires: 0',
    'X-Content-Type-Options: nosniff',
    'Allow: GET, HEAD, POST',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n');
  socket.end(response);
});

function shouldEnforceLiveReadiness(env = process.env) {
  const value = String(env.MADE_MY_DAY_ENFORCE_LIVE_READY || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

const startupReadiness = getReadinessStatus();
if (shouldEnforceLiveReadiness(process.env) && !startupReadiness.ready) {
  console.error('made-my-day startup blocked: live-readiness enforcement failed');
  if (startupReadiness.issueCodes.length) {
    console.error('Config issues:', startupReadiness.issueCodes.join(', '));
  }
  process.exit(1);
}

loadIdempotencyCaches();

server.listen(PORT, () => {
  console.log(`made-my-day running on http://localhost:${PORT}`);
});

const SHUTDOWN_GRACE_MS = Number.isFinite(Number(process.env.SHUTDOWN_GRACE_MS))
  ? Math.floor(Math.max(1_000, Math.min(Number(process.env.SHUTDOWN_GRACE_MS), 120_000)))
  : 10_000;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`made-my-day shutting down (${signal})`);
  clearTimeout(importBootTimeout);
  clearInterval(importInterval);
  clearTimeout(winnerBootTimeout);
  clearInterval(winnerInterval);
  saveIdempotencyCaches();

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  server.close(() => {
    process.exit(exitCode);
  });

  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}

function handleFatalError(type, error) {
  console.error(`made-my-day ${type}`, error);
  shutdown(type, 1);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('beforeExit', () => saveIdempotencyCaches());
process.on('exit', () => saveIdempotencyCaches());
process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (error) => handleFatalError('uncaughtException', error));
