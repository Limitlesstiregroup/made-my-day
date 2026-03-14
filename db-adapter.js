/**
 * Database Adapter for Made My Day
 * 
 * Provides optional SQLite persistence while maintaining backward compatibility
 * with JSON file storage.
 * 
 * Environment variables:
 * - MADE_MY_DAY_DB_TYPE: 'sqlite' or 'json' (default: 'json')
 * - MADE_MY_DAY_DB_PATH: SQLite database file path (default: 'data/made-my-day.db')
 */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'stories.json');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'made-my-day.db');

function getDbType() {
  const raw = process.env.MADE_MY_DAY_DB_TYPE || 'json';
  const normalized = String(raw).toLowerCase().trim();
  return normalized === 'sqlite' ? 'sqlite' : 'json';
}

function getDbPath() {
  const raw = process.env.MADE_MY_DAY_DB_PATH;
  if (raw) {
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(DATA_DIR, raw);
  }
  return DEFAULT_DB_PATH;
}

// Corruption snapshot handling
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
    // Ignore snapshot cleanup failures.
  }
}

// JSON persistence functions
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(emptyStore(), null, 2), 'utf8');
  }
}

function writeStoreFileAtomically(store) {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpFile = `${STORE_FILE}.${suffix}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpFile, STORE_FILE);
}

function emptyStore() {
  return { stories: [], comments: [], hallOfFame: [], pendingWinner: null, giftCards: [], idempotencyKeys: [] };
}

function clampLimit(value, fallback) {
  return Number.isFinite(value) && value >= 100 ? Math.floor(value) : fallback;
}

function trimToLimit(items, limit) {
  if (!Array.isArray(items)) return [];
  if (items.length <= limit) return items;
  return items.slice(0, limit);
}

// SQLite adapter
let db = null;

function initSqlite() {
  const Database = require('better-sqlite3');
  const dbPath = getDbPath();
  
  // Ensure data directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  
  db = new Database(dbPath);
  
  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  
  // Create tables if not exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      author TEXT,
      source_url TEXT,
      source_name TEXT,
      auto_imported INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      text TEXT NOT NULL,
      author TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS hall_of_fame (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS pending_winner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      story_id TEXT,
      selected_at TEXT,
      FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE SET NULL
    );
    
    CREATE TABLE IF NOT EXISTS gift_cards (
      id TEXT PRIMARY KEY,
      story_id TEXT,
      code TEXT NOT NULL,
      amount INTEGER NOT NULL,
      vendor TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE SET NULL
    );
    
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      result TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_comments_story_id ON comments(story_id);
    CREATE INDEX IF NOT EXISTS idx_hall_of_fame_story_id ON hall_of_fame(story_id);
    CREATE INDEX IF NOT EXISTS idx_hall_of_fame_published_at ON hall_of_fame(published_at);
    CREATE INDEX IF NOT EXISTS idx_stories_created_at ON stories(created_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);
  `);
  
  // Initialize pending_winner singleton row
  const pendingWinnerExists = db.prepare('SELECT 1 FROM pending_winner WHERE id = 1').get();
  if (!pendingWinnerExists) {
    db.prepare('INSERT INTO pending_winner (id, story_id, selected_at) VALUES (1, NULL, NULL)').run();
  }
  
  return db;
}

function getSqliteDb() {
  if (!db) {
    db = initSqlite();
  }
  return db;
}

function closeSqlite() {
  if (db) {
    db.close();
    db = null;
  }
}

// SQLite store operations
function loadStoreSqlite() {
  const database = getSqliteDb();
  
  const stories = database.prepare('SELECT * FROM stories ORDER BY created_at DESC').all();
  const comments = database.prepare('SELECT * FROM comments ORDER BY created_at ASC').all();
  const hallOfFame = database.prepare('SELECT * FROM hall_of_fame ORDER BY published_at DESC').all();
  const pendingWinnerRow = database.prepare('SELECT story_id, selected_at FROM pending_winner WHERE id = 1').get();
  const giftCards = database.prepare('SELECT * FROM gift_cards ORDER BY created_at ASC').all();
  const idempotencyKeys = database.prepare('SELECT * FROM idempotency_keys WHERE expires_at > datetime(\'now\')').all();
  
  // Transform to match JSON store format
  return {
    stories: stories.map(row => ({
      id: row.id,
      text: row.text,
      author: row.author,
      sourceUrl: row.source_url,
      sourceName: row.source_name,
      autoImported: Boolean(row.auto_imported),
      createdAt: row.created_at
    })),
    comments: comments.map(row => ({
      id: row.id,
      storyId: row.story_id,
      text: row.text,
      author: row.author,
      createdAt: row.created_at
    })),
    hallOfFame: hallOfFame.map(row => ({
      id: row.id,
      storyId: row.story_id,
      publishedAt: row.published_at,
      createdAt: row.created_at
    })),
    pendingWinner: pendingWinnerRow?.story_id ? {
      storyId: pendingWinnerRow.story_id,
      selectedAt: pendingWinnerRow.selected_at
    } : null,
    giftCards: giftCards.map(row => ({
      id: row.id,
      storyId: row.story_id,
      code: row.code,
      amount: row.amount,
      vendor: row.vendor,
      sentAt: row.sent_at,
      createdAt: row.created_at
    })),
    idempotencyKeys: idempotencyKeys.map(row => ({
      key: row.key,
      scope: row.scope,
      result: JSON.parse(row.result || '{}'),
      expiresAt: row.expires_at,
      createdAt: row.created_at
    }))
  };
}

function saveStoreSqlite(store) {
  const database = getSqliteDb();
  
  // Use transaction for atomicity
  const transaction = database.transaction(() => {
    // Clear existing data
    database.prepare('DELETE FROM idempotency_keys').run();
    database.prepare('DELETE FROM gift_cards').run();
    database.prepare('UPDATE pending_winner SET story_id = NULL, selected_at = NULL WHERE id = 1').run();
    database.prepare('DELETE FROM hall_of_fame').run();
    database.prepare('DELETE FROM comments').run();
    database.prepare('DELETE FROM stories').run();
    
    // Insert stories
    const insertStory = database.prepare(`
      INSERT INTO stories (id, text, author, source_url, source_name, auto_imported, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const story of store.stories || []) {
      insertStory.run(
        story.id || crypto.randomUUID(),
        story.text || '',
        story.author || null,
        story.sourceUrl || null,
        story.sourceName || null,
        story.autoImported ? 1 : 0,
        story.createdAt || new Date().toISOString()
      );
    }
    
    // Insert comments
    const insertComment = database.prepare(`
      INSERT INTO comments (id, story_id, text, author, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const comment of store.comments || []) {
      insertComment.run(
        comment.id || crypto.randomUUID(),
        comment.storyId,
        comment.text || '',
        comment.author || null,
        comment.createdAt || new Date().toISOString()
      );
    }
    
    // Insert hall of fame
    const insertHallOfFame = database.prepare(`
      INSERT INTO hall_of_fame (id, story_id, published_at, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const entry of store.hallOfFame || []) {
      insertHallOfFame.run(
        entry.id || crypto.randomUUID(),
        entry.storyId,
        entry.publishedAt || new Date().toISOString(),
        entry.createdAt || new Date().toISOString()
      );
    }
    
    // Update pending winner
    if (store.pendingWinner) {
      database.prepare('UPDATE pending_winner SET story_id = ?, selected_at = ? WHERE id = 1').run(
        store.pendingWinner.storyId,
        store.pendingWinner.selectedAt
      );
    }
    
    // Insert gift cards
    const insertGiftCard = database.prepare(`
      INSERT INTO gift_cards (id, story_id, code, amount, vendor, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const card of store.giftCards || []) {
      insertGiftCard.run(
        card.id || crypto.randomUUID(),
        card.storyId || null,
        card.code,
        card.amount || 0,
        card.vendor || null,
        card.sentAt || null,
        card.createdAt || new Date().toISOString()
      );
    }
    
    // Insert idempotency keys
    const insertIdempotencyKey = database.prepare(`
      INSERT INTO idempotency_keys (key, scope, result, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const key of store.idempotencyKeys || []) {
      insertIdempotencyKey.run(
        key.key,
        key.scope || 'default',
        JSON.stringify(key.result || {}),
        key.expiresAt,
        key.createdAt || new Date().toISOString()
      );
    }
  });
  
  transaction();
}

// Unified interface
function loadStore() {
  const dbType = getDbType();
  
  if (dbType === 'sqlite') {
    try {
      const store = loadStoreSqlite();
      if (!Array.isArray(store.stories)) store.stories = [];
      if (!Array.isArray(store.comments)) store.comments = [];
      if (!Array.isArray(store.hallOfFame)) store.hallOfFame = [];
      if (!Array.isArray(store.giftCards)) store.giftCards = [];
      if (!Array.isArray(store.idempotencyKeys)) store.idempotencyKeys = [];
      if (!Object.prototype.hasOwnProperty.call(store, 'pendingWinner')) store.pendingWinner = null;
      return store;
    } catch (err) {
      console.error('SQLite load error, falling back to JSON:', err.message);
      // Fall through to JSON fallback
    }
  }
  
  // JSON persistence (default and fallback)
  ensureStore();
  let store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
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

function saveStore(store) {
  const dbType = getDbType();
  
  if (dbType === 'sqlite') {
    try {
      saveStoreSqlite(store);
      return;
    } catch (err) {
      console.error('SQLite save error, falling back to JSON:', err.message);
      // Fall through to JSON fallback
    }
  }
  
  // JSON persistence (default and fallback)
  writeStoreFileAtomically(store);
}

// Migration helper: convert JSON to SQLite
function migrateJsonToSqlite() {
  if (getDbType() !== 'sqlite') {
    throw new Error('DB_TYPE must be set to sqlite for migration');
  }
  
  if (!fs.existsSync(STORE_FILE)) {
    console.log('No JSON store to migrate');
    return { migrated: false };
  }
  
  const jsonData = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  
  saveStoreSqlite(jsonData);
  
  // Backup original JSON file
  const backupPath = `${STORE_FILE}.pre-sqlite-migration-${Date.now()}`;
  fs.copyFileSync(STORE_FILE, backupPath);
  
  console.log(`Migrated ${jsonData.stories?.length || 0} stories, ${jsonData.comments?.length || 0} comments, ${jsonData.hallOfFame?.length || 0} hall of fame entries, ${jsonData.giftCards?.length || 0} gift cards to SQLite`);
  console.log(`Original JSON backed up to ${backupPath}`);
  
  return { 
    migrated: true, 
    counts: { 
      stories: jsonData.stories?.length || 0, 
      comments: jsonData.comments?.length || 0, 
      hallOfFame: jsonData.hallOfFame?.length || 0, 
      giftCards: jsonData.giftCards?.length || 0 
    } 
  };
}

// Health check for database
function getDbHealth() {
  const dbType = getDbType();
  const result = { type: dbType, healthy: true };
  
  if (dbType === 'sqlite') {
    try {
      const database = getSqliteDb();
      const stats = database.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM stories) as stories,
          (SELECT COUNT(*) FROM comments) as comments,
          (SELECT COUNT(*) FROM hall_of_fame) as hallOfFame,
          (SELECT COUNT(*) FROM gift_cards) as giftCards
      `).get();
      result.counts = stats;
      result.path = getDbPath();
    } catch (err) {
      result.healthy = false;
      result.error = err.message;
    }
  } else {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const stats = fs.statSync(STORE_FILE);
        result.fileSize = stats.size;
        result.path = STORE_FILE;
      }
    } catch (err) {
      result.healthy = false;
      result.error = err.message;
    }
  }
  
  return result;
}

// Graceful shutdown
function shutdown() {
  closeSqlite();
}

// Export interface
module.exports = {
  loadStore,
  saveStore,
  emptyStore,
  getDbType,
  getDbPath,
  migrateJsonToSqlite,
  getDbHealth,
  shutdown,
  STORE_FILE,
  closeSqlite,
  clampLimit,
  trimToLimit
};
