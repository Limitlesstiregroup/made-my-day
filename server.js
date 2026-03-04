const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4300);
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'stories.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
function clampMaxBodyBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 16 * 1024;
  const normalized = Math.floor(parsed);
  if (normalized < 1024) return 1024;
  if (normalized > 256 * 1024) return 256 * 1024;
  return normalized;
}

const MAX_BODY_BYTES = clampMaxBodyBytes(process.env.MAX_BODY_BYTES);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX_MUTATIONS = Number(process.env.RATE_LIMIT_MAX_MUTATIONS || 45);
const RATE_LIMIT_MAX_KEYS = Number(process.env.RATE_LIMIT_MAX_KEYS || 10_000);
const MAX_STORIES = Number(process.env.MAX_STORIES || 5000);
const MAX_COMMENTS = Number(process.env.MAX_COMMENTS || 20000);
const MAX_HALL_OF_FAME = Number(process.env.MAX_HALL_OF_FAME || 520);
const MAX_GIFT_CARDS = Number(process.env.MAX_GIFT_CARDS || 520);
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim().toLowerCase() === 'true';
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
  ? Math.floor(Number(process.env.MAX_IDEMPOTENCY_KEYS))
  : 5000;
const mutationLog = new Map();
const mutationLogOrder = [];
const adminRunIdempotencyCache = new Map();
const engagementIdempotencyCache = new Map();
let lastImportRun = null;
let importRunPromise = null;
let hallOfFameRunPromise = null;

function readSecretFile(filePath) {
  if (!filePath || String(filePath).trim() === '') return '';
  try {
    return fs.readFileSync(String(filePath), 'utf8').trim();
  } catch {
    return '';
  }
}

function looksLikePlaceholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['changeme', 'change-me', 'replace-me', 'placeholder', 'example', 'sample', 'dummy', 'todo'].some((token) => normalized.includes(token));
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

function hasStrongAdminToken() {
  const configuredToken = getConfiguredAdminToken();
  return configuredToken.length >= 16 && !looksLikePlaceholderSecret(configuredToken);
}

function parseIntOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function getConfigIssues() {
  const issues = [];

  const configuredToken = getConfiguredAdminToken();
  if (configuredToken && !hasStrongAdminToken()) {
    issues.push('adminToken');
  }

  const previousToken = getPreviousAdminToken();
  if (configuredToken && previousToken && configuredToken === previousToken) {
    issues.push('adminTokenRotation');
  }

  const importTimeout = parseIntOrDefault(process.env.IMPORT_TIMEOUT_MS, 10000);
  if (importTimeout < 1000 || importTimeout > 60000) {
    issues.push('importTimeout');
  }

  const maxBodyBytesRaw = parseIntOrDefault(process.env.MAX_BODY_BYTES, 16 * 1024);
  if (maxBodyBytesRaw < 1024 || maxBodyBytesRaw > 256 * 1024) {
    issues.push('maxBodyBytes');
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

  if (!issues.includes('headersTimeout') && !issues.includes('requestTimeout') && headersTimeoutRaw > requestTimeoutRaw) {
    issues.push('headersTimeoutOrder');
  }

  if (!issues.includes('keepAliveTimeout') && !issues.includes('headersTimeout') && keepAliveTimeoutRaw > headersTimeoutRaw) {
    issues.push('keepAliveTimeoutOrder');
  }

  return issues;
}

function getReadinessStatus() {
  const issues = getConfigIssues();
  return {
    ready: issues.length === 0,
    checks: {
      adminToken: issues.includes('adminToken') ? 'fail' : (getConfiguredAdminToken() ? 'pass' : 'preview'),
      adminTokenRotation: issues.includes('adminTokenRotation') ? 'fail' : 'pass',
      importTimeoutMs: issues.includes('importTimeout') ? 'fail' : 'pass',
      maxBodyBytes: issues.includes('maxBodyBytes') ? 'fail' : 'pass',
      maxStoryChars: issues.includes('maxStoryChars') ? 'fail' : 'pass',
      maxCommentChars: issues.includes('maxCommentChars') ? 'fail' : 'pass',
      maxCommentsPerStory: issues.includes('maxCommentsPerStory') ? 'fail' : 'pass',
      maxAuthorChars: issues.includes('maxAuthorChars') ? 'fail' : 'pass',
      trustProxy: issues.includes('trustProxy') ? 'fail' : 'pass',
      requestTimeoutMs: issues.includes('requestTimeout') ? 'fail' : 'pass',
      headersTimeoutMs: issues.includes('headersTimeout') ? 'fail' : (issues.includes('headersTimeoutOrder') ? 'fail' : 'pass'),
      keepAliveTimeoutMs: issues.includes('keepAliveTimeout') ? 'fail' : (issues.includes('keepAliveTimeoutOrder') ? 'fail' : 'pass')
    }
  };
}

function getOperationalSnapshot(store) {
  const importedStories = store.stories.filter((s) => s.autoImported).length;
  const manualStories = store.stories.length - importedStories;
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

function secureTokenEquals(incomingToken, configuredToken) {
  const incomingBuffer = Buffer.from(String(incomingToken));
  const configuredBuffer = Buffer.from(String(configuredToken));
  if (incomingBuffer.length !== configuredBuffer.length) return false;
  return crypto.timingSafeEqual(incomingBuffer, configuredBuffer);
}

function hasAdminAuth(req) {
  const configuredToken = getConfiguredAdminToken();
  if (!configuredToken) return true; // preview mode
  if (!hasStrongAdminToken()) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const incoming = header.slice('Bearer '.length).trim();
  if (incoming.length === 0 || incoming.length > 1024) return false;
  const candidates = getAdminTokenCandidates().filter((token) => token.length >= 16 && !looksLikePlaceholderSecret(token));
  if (candidates.length === 0) return false;
  return candidates.some((token) => secureTokenEquals(incoming, token));
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
    // Recover from partial/corrupted writes and keep a forensics snapshot.
    const badCopy = `${STORE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(STORE_FILE, badCopy);
    } catch {
      // Ignore backup failures; continue with a safe empty store.
    }
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

function getIdempotencyKey(req) {
  const header = req.headers['idempotency-key'];
  if (typeof header !== 'string') return '';
  const key = header.trim();
  if (key.length < 8 || key.length > 128) return '';
  if (!/^[a-zA-Z0-9:_\-.]+$/.test(key)) return '';
  return key;
}

function getAdminRunIdempotent(scope, idempotencyKey) {
  if (!scope || !idempotencyKey) return null;
  const cacheKey = `${scope}:${idempotencyKey}`;
  const hit = adminRunIdempotencyCache.get(cacheKey);
  if (!hit || !Number.isFinite(hit.expiresAt) || hit.expiresAt <= Date.now()) {
    adminRunIdempotencyCache.delete(cacheKey);
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
  if (adminRunIdempotencyCache.size <= max) return;

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

function getEngagementIdempotent(scope, idempotencyKey) {
  if (!scope || !idempotencyKey) return null;
  const cacheKey = `${scope}:${idempotencyKey}`;
  const hit = engagementIdempotencyCache.get(cacheKey);
  if (!hit || !Number.isFinite(hit.expiresAt) || hit.expiresAt <= Date.now()) {
    engagementIdempotencyCache.delete(cacheKey);
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
  if (engagementIdempotencyCache.size <= max) return;

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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };
}

function json(res, status, data, { noStore = true, headers: extraHeaders } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders(),
    ...(extraHeaders || {})
  };
  if (noStore) headers['Cache-Control'] = 'no-store';
  res.writeHead(status, headers);
  res.end(JSON.stringify(data, null, 2));
}

function csvValue(value) {
  const text = String(value ?? '');
  const formulaSafe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  if (formulaSafe.includes(',') || formulaSafe.includes('"') || formulaSafe.includes('\n')) {
    return `"${formulaSafe.replace(/"/g, '""')}"`;
  }
  return formulaSafe;
}

function csv(res, status, rows, { noStore = true } = {}) {
  const headers = { 'Content-Type': 'text/csv; charset=utf-8', ...securityHeaders() };
  if (noStore) headers['Cache-Control'] = 'no-store';
  res.writeHead(status, headers);
  res.end(rows.map((row) => row.map((value) => csvValue(value)).join(',')).join('\n'));
}

function hasJsonContentType(req) {
  const value = String(req.headers['content-type'] || '').toLowerCase();
  return value.startsWith('application/json');
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

function jsonCached(req, res, status, data) {
  const etag = weakEtagForPayload(data);
  if (String(req.headers['if-none-match'] || '').trim() === etag) {
    res.writeHead(304, { ETag: etag, ...securityHeaders() });
    res.end();
    return;
  }

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    ETag: etag,
    ...securityHeaders()
  });
  res.end(JSON.stringify(data, null, 2));
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

function getRequestIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim() && forwarded.length <= 512) {
      const forwardedIp = normalizeIp(forwarded.split(',')[0]);
      if (forwardedIp) return forwardedIp;
    }
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let totalBytes = 0;
    let tooLarge = false;
    let settled = false;

    const failTooLarge = () => {
      if (settled) return;
      settled = true;
      const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.code = 'BODY_TOO_LARGE';
      reject(error);
    };

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        failTooLarge();
        return;
      }
      if (!tooLarge) body += chunk;
    });
    req.on('end', () => {
      if (settled || tooLarge) return;
      settled = true;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
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
  res.writeHead(200, { 'Content-Type': contentType, ...securityHeaders() });
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
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (trimmed.length >= 8 && trimmed.length <= 128 && /^[a-zA-Z0-9:_\-.]+$/.test(trimmed)) {
      return trimmed;
    }
  }
  return `req_${crypto.randomUUID()}`;
}

const server = http.createServer(async (req, res) => {
  const requestId = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  try {
    const u = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

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

    if (req.method === 'GET' && u.pathname === '/api/health') {
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
          maxCommentsPerStory: MAX_COMMENTS_PER_STORY,
          lastRun: lastImportRun
        }
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/health/ready') {
      const readiness = getReadinessStatus();
      return json(res, readiness.ready ? 200 : 503, {
        ok: readiness.ready,
        service: 'made-my-day',
        checks: readiness.checks
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/health/details') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const readiness = getReadinessStatus();
      return json(res, 200, {
        ok: true,
        service: 'made-my-day',
        readiness,
        operations: getOperationalSnapshot(store)
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/admin/hall-of-fame.csv') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const rows = [['storyId', 'publishedAt', 'score', 'giftCardCode', 'notifiedAt']].concat(
        store.hallOfFame
          .slice(offset, offset + limit)
          .map((entry) => [entry.storyId, entry.publishedAt, entry.score, entry.giftCardCode, entry.notifiedAt])
      );
      return csv(res, 200, rows);
    }

    if (req.method === 'GET' && u.pathname === '/api/admin/gift-cards.csv') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const rows = [['storyId', 'code', 'status', 'amountUsd', 'queuedAt', 'issuedAt']].concat(
        store.giftCards
          .slice(offset, offset + limit)
          .map((entry) => [entry.storyId, entry.code, entry.status, entry.amountUsd, entry.queuedAt, entry.issuedAt])
      );
      return csv(res, 200, rows);
    }

    if (req.method === 'GET' && u.pathname === '/api/admin/hall-of-fame') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const total = store.hallOfFame.length;
      const records = store.hallOfFame.slice(offset, offset + limit);
      return json(res, 200, {
        records,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + records.length < total,
          nextOffset: offset + records.length < total ? offset + records.length : null
        }
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/admin/gift-cards') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const limit = parseBoundedInt(u.searchParams.get('limit'), 250, { min: 1, max: 5000 });
      const offset = parseBoundedInt(u.searchParams.get('offset'), 0, { min: 0, max: 1000000 });
      const total = store.giftCards.length;
      const records = store.giftCards.slice(offset, offset + limit);
      return json(res, 200, {
        records,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + records.length < total,
          nextOffset: offset + records.length < total ? offset + records.length : null
        }
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/stories') {
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

      return jsonCached(req, res, 200, {
        stories: pagedStories,
        pagination: {
          total: totalStories,
          limit,
          offset,
          hasMore: offset + pagedStories.length < totalStories,
          nextOffset: offset + pagedStories.length < totalStories ? offset + pagedStories.length : null
        },
        activeHallOfFameStoryId: activeHall?.storyId || null
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/hall-of-fame') {
      const limitRaw = Number(u.searchParams.get('limit') || 100);
      const offsetRaw = Number(u.searchParams.get('offset') || 0);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
      const total = store.hallOfFame.length;
      const hallSlice = store.hallOfFame.slice(offset, offset + limit);
      return jsonCached(req, res, 200, {
        hallOfFame: hallSlice,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + hallSlice.length < total,
          nextOffset: offset + hallSlice.length < total ? offset + hallSlice.length : null
        },
        pendingWinner: store.pendingWinner
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/stories') {
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const body = await readBody(req).catch((error) => {
        if (error?.code === 'BODY_TOO_LARGE') {
          json(res, 413, { error: `Request body too large. Max ${MAX_BODY_BYTES} bytes.` });
          return null;
        }
        json(res, 400, { error: 'Invalid JSON body.' });
        return null;
      });
      if (!body) return;
      const incomingText = sanitizeUserText(body?.text, MAX_STORY_CHARS);
      if (!incomingText || incomingText.length < 40) {
        return json(res, 400, { error: 'Story must be at least 40 characters.' });
      }
      const idempotencyKey = getIdempotencyKey(req);
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
        return json(res, 409, { error: 'A very similar story was already posted recently.' });
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
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });

      const idempotencyKey = getIdempotencyKey(req);
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
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });

      const idempotencyKey = getIdempotencyKey(req);
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
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });

      const idempotencyKey = getIdempotencyKey(req);
      const idempotentScope = `story-comment:${storyId}`;
      const prior = getEngagementIdempotent(idempotentScope, idempotencyKey);
      if (prior) return json(res, 200, { ...prior, idempotent: true });

      const body = await readBody(req).catch((error) => {
        if (error?.code === 'BODY_TOO_LARGE') {
          json(res, 413, { error: `Request body too large. Max ${MAX_BODY_BYTES} bytes.` });
          return null;
        }
        json(res, 400, { error: 'Invalid JSON body.' });
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

      const comment = {
        id: id('com'),
        storyId,
        text: commentText,
        author: body.author ? sanitizeUserText(body.author, MAX_AUTHOR_CHARS) : 'Anonymous',
        createdAt: new Date().toISOString()
      };
      store.comments.push(comment);
      saveStore(store);
      const result = { comment };
      rememberEngagementIdempotent(idempotentScope, idempotencyKey, result);
      return json(res, 201, result);
    }

    if (req.method === 'POST' && u.pathname === '/api/import/run') {
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      try {
        await readBody(req);
      } catch (error) {
        if (error?.code === 'BODY_TOO_LARGE') {
          return json(res, 413, { error: `Request body too large. Max ${MAX_BODY_BYTES} bytes.` });
        }
        return json(res, 400, { error: 'Invalid JSON body.' });
      }
      const idempotencyKey = getIdempotencyKey(req);
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
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      try {
        await readBody(req);
      } catch (error) {
        if (error?.code === 'BODY_TOO_LARGE') {
          return json(res, 413, { error: `Request body too large. Max ${MAX_BODY_BYTES} bytes.` });
        }
        return json(res, 400, { error: 'Invalid JSON body.' });
      }
      const idempotencyKey = getIdempotencyKey(req);
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
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (u.pathname === '/app.js') return sendFile(res, path.join(PUBLIC_DIR, 'app.js'));
  if (u.pathname === '/styles.css') return sendFile(res, path.join(PUBLIC_DIR, 'styles.css'));

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

  const headersTimeout = Math.min(headersTimeoutCandidate, requestTimeout);
  const keepAliveTimeout = Math.min(keepAliveTimeoutCandidate, headersTimeout);

  return {
    requestTimeout,
    headersTimeout,
    keepAliveTimeout
  };
}

const resolvedTimeouts = resolveServerTimeouts(process.env);
server.requestTimeout = resolvedTimeouts.requestTimeout;
server.headersTimeout = resolvedTimeouts.headersTimeout;
server.keepAliveTimeout = resolvedTimeouts.keepAliveTimeout;

server.listen(PORT, () => {
  console.log(`made-my-day running on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`made-my-day shutting down (${signal})`);
  clearTimeout(importBootTimeout);
  clearInterval(importInterval);
  clearTimeout(winnerBootTimeout);
  clearInterval(winnerInterval);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
