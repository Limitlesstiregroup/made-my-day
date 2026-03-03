const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4300);
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'stories.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 16 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX_MUTATIONS = Number(process.env.RATE_LIMIT_MAX_MUTATIONS || 45);
const MAX_STORIES = Number(process.env.MAX_STORIES || 5000);
const MAX_COMMENTS = Number(process.env.MAX_COMMENTS || 20000);
const MAX_HALL_OF_FAME = Number(process.env.MAX_HALL_OF_FAME || 520);
const MAX_GIFT_CARDS = Number(process.env.MAX_GIFT_CARDS || 520);
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim().toLowerCase() === 'true';
const SAFE_RATE_LIMIT_WINDOW_MS = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0 ? RATE_LIMIT_WINDOW_MS : 60 * 1000;
const SAFE_RATE_LIMIT_MAX_MUTATIONS = Number.isFinite(RATE_LIMIT_MAX_MUTATIONS) && RATE_LIMIT_MAX_MUTATIONS > 0 ? RATE_LIMIT_MAX_MUTATIONS : 45;
const IMPORT_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 10000);
const SAFE_IMPORT_TIMEOUT_MS = Number.isFinite(IMPORT_TIMEOUT_MS) && IMPORT_TIMEOUT_MS >= 1000 ? Math.min(IMPORT_TIMEOUT_MS, 60000) : 10000;
const MAX_STORY_CHARS = Number.isFinite(Number(process.env.MAX_STORY_CHARS)) && Number(process.env.MAX_STORY_CHARS) >= 200
  ? Math.floor(Number(process.env.MAX_STORY_CHARS))
  : 5000;
const MAX_COMMENT_CHARS = Number.isFinite(Number(process.env.MAX_COMMENT_CHARS)) && Number(process.env.MAX_COMMENT_CHARS) >= 20
  ? Math.floor(Number(process.env.MAX_COMMENT_CHARS))
  : 300;
const MAX_AUTHOR_CHARS = Number.isFinite(Number(process.env.MAX_AUTHOR_CHARS)) && Number(process.env.MAX_AUTHOR_CHARS) >= 10
  ? Math.floor(Number(process.env.MAX_AUTHOR_CHARS))
  : 60;
const mutationLog = new Map();
let lastImportRun = null;

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

function hasStrongAdminToken() {
  const configuredToken = getConfiguredAdminToken();
  return configuredToken.length >= 16 && !looksLikePlaceholderSecret(configuredToken);
}

function getReadinessStatus() {
  const configuredToken = getConfiguredAdminToken();
  const ready = !configuredToken || hasStrongAdminToken();
  return {
    ready,
    checks: {
      adminToken: configuredToken ? (hasStrongAdminToken() ? 'pass' : 'fail') : 'preview'
    }
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
  return secureTokenEquals(incoming, configuredToken);
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(emptyStore(), null, 2));
  }
}

function emptyStore() {
  return { stories: [], comments: [], hallOfFame: [], pendingWinner: null, giftCards: [] };
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
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  }
  if (!Array.isArray(store.stories)) store.stories = [];
  if (!Array.isArray(store.comments)) store.comments = [];
  if (!Array.isArray(store.hallOfFame)) store.hallOfFame = [];
  if (!Array.isArray(store.giftCards)) store.giftCards = [];
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

function saveStore(store) {
  store.stories = trimToLimit(store.stories, clampLimit(MAX_STORIES, 5000));
  store.comments = trimToLimit(store.comments, clampLimit(MAX_COMMENTS, 20000));
  store.hallOfFame = trimToLimit(store.hallOfFame, clampLimit(MAX_HALL_OF_FAME, 520));
  store.giftCards = trimToLimit(store.giftCards, clampLimit(MAX_GIFT_CARDS, 520));
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  };
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders() });
  res.end(JSON.stringify(data, null, 2));
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
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function getRequestIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  if (req.method !== 'POST') return false;
  const ip = getRequestIp(req);
  const now = Date.now();
  const freshForIp = (mutationLog.get(ip) || []).filter((ts) => now - ts <= SAFE_RATE_LIMIT_WINDOW_MS);
  freshForIp.push(now);
  mutationLog.set(ip, freshForIp);

  // prune stale keys to avoid unbounded memory growth under spray traffic
  for (const [key, timestamps] of mutationLog.entries()) {
    const live = timestamps.filter((ts) => now - ts <= SAFE_RATE_LIMIT_WINDOW_MS);
    if (live.length === 0) mutationLog.delete(key);
    else if (live.length !== timestamps.length) mutationLog.set(key, live);
  }

  return freshForIp.length > SAFE_RATE_LIMIT_MAX_MUTATIONS;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
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
  return { ...story, comments, commentCount: comments.length, score: storyScore(story, store) };
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
        sourceUrl: `https://reddit.com${p.permalink}`,
        sourceName: 'reddit/r/MadeMeSmile',
        score: p.score || 0
      };
    })
    .filter((p) => p.text.length >= 40)
    .map((p) => ({ ...p, text: p.text.slice(0, 2500) }))
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
      sourceUrl: item.sourceUrl,
      sourceName: item.sourceName,
      autoImported: true
    });
  });

  saveStore(store);
  return { added: selected.length, source: 'reddit/r/MadeMeSmile' };
}

async function runIngestJob() {
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
  }
}

// run once on boot + every hour
setTimeout(() => runIngestJob().catch(() => null), 1500);
setInterval(() => runIngestJob().catch(() => null), 60 * 60 * 1000);

// winner automation checks every minute
setTimeout(() => runWeeklyWinnerAutomation(), 2000);
setInterval(() => runWeeklyWinnerAutomation(), 60 * 1000);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname.startsWith('/api/')) {
    if (isRateLimited(req)) {
      return json(res, 429, { error: 'Rate limit exceeded. Please wait and try again.' });
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
          source: String(process.env.MADE_MY_DAY_ADMIN_TOKEN || '').trim() ? 'env' : (process.env.MADE_MY_DAY_ADMIN_TOKEN_FILE ? 'file' : 'none')
        },
        imports: {
          timeoutMs: SAFE_IMPORT_TIMEOUT_MS,
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

    if (req.method === 'GET' && u.pathname === '/api/stories') {
      const activeHall = store.hallOfFame.find((h) => Date.now() - new Date(h.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000);
      const stories = store.stories
        .slice()
        .sort((a, b) => {
          if (activeHall?.storyId === a.id) return -1;
          if (activeHall?.storyId === b.id) return 1;
          return new Date(b.createdAt) - new Date(a.createdAt);
        })
        .map((s) => storyView(s, store));
      return jsonCached(req, res, 200, { stories, activeHallOfFameStoryId: activeHall?.storyId || null });
    }

    if (req.method === 'GET' && u.pathname === '/api/hall-of-fame') {
      return jsonCached(req, res, 200, { hallOfFame: store.hallOfFame, pendingWinner: store.pendingWinner });
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
      saveStore(store);
      return json(res, 201, { story: storyView(story, store) });
    }

    if (req.method === 'POST' && u.pathname.match(/^\/api\/stories\/[^/]+\/like$/)) {
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });
      story.likes += 1;
      saveStore(store);
      return json(res, 200, { likes: story.likes });
    }

    if (req.method === 'POST' && u.pathname.match(/^\/api\/stories\/[^/]+\/share$/)) {
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });
      story.shares += 1;
      saveStore(store);
      return json(res, 200, { shares: story.shares });
    }

    if (req.method === 'POST' && u.pathname.match(/^\/api\/stories\/[^/]+\/comments$/)) {
      if (!hasJsonContentType(req)) {
        return json(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const storyId = u.pathname.split('/')[3];
      const story = store.stories.find((s) => s.id === storyId);
      if (!story) return json(res, 404, { error: 'Story not found' });
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
      const comment = {
        id: id('com'),
        storyId,
        text: commentText,
        author: body.author ? sanitizeUserText(body.author, MAX_AUTHOR_CHARS) : 'Anonymous',
        createdAt: new Date().toISOString()
      };
      store.comments.push(comment);
      saveStore(store);
      return json(res, 201, { comment });
    }

    if (req.method === 'POST' && u.pathname === '/api/import/run') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const result = await runIngestJob().catch((error) => ({ added: 0, error: error?.message || String(error) }));
      return json(res, 200, result);
    }

    if (req.method === 'POST' && u.pathname === '/api/hall-of-fame/run') {
      if (!hasAdminAuth(req)) return json(res, 401, { error: 'unauthorized' });
      runWeeklyWinnerAutomation();
      const refreshed = loadStore();
      return json(res, 200, {
        ok: true,
        pendingWinner: refreshed.pendingWinner,
        latestWinner: refreshed.hallOfFame[0] || null,
        giftCardQueue: refreshed.giftCards.slice(0, 5)
      });
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
});

server.listen(PORT, () => {
  console.log(`made-my-day running on http://localhost:${PORT}`);
});
