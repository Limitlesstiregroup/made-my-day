#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateReadiness, isSecretFileSymlink, isSecretFileTooPermissive, isPrivateOrLocalEscalationHost } = require('./release-readiness');

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
  fs.chmodSync(tmpTokenFile, 0o600);
  fs.chmodSync(tmpPrevTokenFile, 0o600);

  const issuesFromFiles = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_FILE: tmpTokenFile,
    MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS_FILE: tmpPrevTokenFile,
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });

  fs.unlinkSync(tmpTokenFile);
  fs.unlinkSync(tmpPrevTokenFile);

  assert.equal(issuesFromFiles.length, 0, 'release readiness should accept admin token *_FILE fallbacks');

  const tmpAllowedHostsFile = path.join(process.cwd(), 'data', `.tmp-allowed-hosts-${Date.now()}`);
  fs.writeFileSync(tmpAllowedHostsFile, 'app.mademyday.com,api.mademyday.com:443\n');
  fs.chmodSync(tmpAllowedHostsFile, 0o600);
  const allowedHostsFileIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'primary_admin_token_1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation',
    ALLOWED_HOSTS_FILE: tmpAllowedHostsFile
  });
  fs.unlinkSync(tmpAllowedHostsFile);

  assert.equal(allowedHostsFileIssues.length, 0, 'release readiness should accept ALLOWED_HOSTS_FILE when host entries are valid');

  const unreadableSecretFileIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_FILE: '/tmp/does-not-exist-made-my-day-admin-token',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    unreadableSecretFileIssues.includes('MADE_MY_DAY_ADMIN_TOKEN_FILE could not be read'),
    'unreadable *_FILE paths should surface explicit release-readiness issues'
  );

  const relativeFilePathIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_FILE: './relative-admin-token.txt',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    relativeFilePathIssues.includes('MADE_MY_DAY_ADMIN_TOKEN_FILE must be an absolute path'),
    'relative *_FILE paths should surface absolute-path guidance'
  );

  const tmpRealTokenFile = path.join(process.cwd(), 'data', `.tmp-admin-token-real-${Date.now()}`);
  const tmpSymlinkTokenFile = path.join(process.cwd(), 'data', `.tmp-admin-token-link-${Date.now()}`);
  fs.writeFileSync(tmpRealTokenFile, 'admin_token_file_primary_1234\n');
  fs.chmodSync(tmpRealTokenFile, 0o600);
  fs.symlinkSync(tmpRealTokenFile, tmpSymlinkTokenFile);
  assert.equal(isSecretFileSymlink(tmpSymlinkTokenFile), true, 'symbolic-link secret files should be detected');
  const symlinkFileIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_FILE: tmpSymlinkTokenFile,
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    symlinkFileIssues.includes('MADE_MY_DAY_ADMIN_TOKEN_FILE must not be a symbolic link'),
    'symlink *_FILE paths should be rejected for secret loading hardening'
  );
  fs.unlinkSync(tmpSymlinkTokenFile);
  fs.unlinkSync(tmpRealTokenFile);

  const tmpPermissiveTokenFile = path.join(process.cwd(), 'data', `.tmp-admin-token-open-${Date.now()}`);
  fs.writeFileSync(tmpPermissiveTokenFile, 'admin_token_file_primary_1234\n');
  fs.chmodSync(tmpPermissiveTokenFile, 0o644);
  assert.equal(isSecretFileTooPermissive(tmpPermissiveTokenFile), true, 'group/world-readable secret files should be flagged');
  const permissiveFileIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_FILE: tmpPermissiveTokenFile,
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    permissiveFileIssues.includes('MADE_MY_DAY_ADMIN_TOKEN_FILE permissions are too open (require chmod 600 owner-only)'),
    'permissive *_FILE paths should surface chmod guidance'
  );
  fs.chmodSync(tmpPermissiveTokenFile, 0o600);
  assert.equal(isSecretFileTooPermissive(tmpPermissiveTokenFile), false, 'owner-only secret files should pass permission checks');
  fs.unlinkSync(tmpPermissiveTokenFile);

  const placeholderIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS: 'change-me-previous-token-1234'
  });
  assert.ok(
    placeholderIssues.includes('MADE_MY_DAY admin tokens must not be placeholder values'),
    'placeholder previous token should fail release readiness'
  );

  const whitespaceTokenIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'admin token with spaces 1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    whitespaceTokenIssues.includes('MADE_MY_DAY admin tokens must not contain whitespace characters'),
    'admin tokens with whitespace should fail release readiness'
  );

  const oncallPlaceholderIssues = evaluateReadiness({
    MADE_MY_DAY_ONCALL_PRIMARY: 'todo',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    oncallPlaceholderIssues.includes('MADE_MY_DAY_ONCALL_PRIMARY must not be a placeholder value'),
    'placeholder on-call owner should fail release readiness'
  );

  const oncallControlCharIssues = evaluateReadiness({
    MADE_MY_DAY_ONCALL_PRIMARY: 'community\noncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    oncallControlCharIssues.includes('MADE_MY_DAY_ONCALL_PRIMARY must not contain control characters'),
    'on-call owners with control characters should fail release readiness'
  );

  const oncallWhitespaceIssues = evaluateReadiness({
    MADE_MY_DAY_ONCALL_PRIMARY: 'community oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    oncallWhitespaceIssues.includes('MADE_MY_DAY_ONCALL_PRIMARY must not contain whitespace'),
    'on-call owners with whitespace should fail release readiness'
  );

  const missingSecondaryOncallIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    missingSecondaryOncallIssues.includes('MADE_MY_DAY_ONCALL_SECONDARY must be set and at least 3 characters (env or *_FILE)'),
    'missing backup on-call owner should fail release readiness'
  );

  const duplicateOncallOwnersIssues = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-oncall',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.test/escalation'
  });
  assert.ok(
    duplicateOncallOwnersIssues.includes('MADE_MY_DAY_ONCALL_PRIMARY and MADE_MY_DAY_ONCALL_SECONDARY must not be the same'),
    'primary and secondary on-call owners must differ for GA readiness'
  );

  const localEscalationIssue = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://localhost/escalation'
  });
  assert.ok(
    localEscalationIssue.includes('MADE_MY_DAY_ESCALATION_DOC_URL must not target localhost/private network hosts'),
    'release readiness should reject localhost/private-network escalation runbook URLs'
  );
  assert.equal(isPrivateOrLocalEscalationHost('10.1.2.3'), true, 'RFC1918 hosts should be rejected for escalation runbooks');
  assert.equal(isPrivateOrLocalEscalationHost('100.64.1.20'), true, 'carrier-grade NAT hosts should be rejected for escalation runbooks');
  assert.equal(isPrivateOrLocalEscalationHost('198.19.3.7'), true, 'benchmark-network hosts should be rejected for escalation runbooks');
  assert.equal(isPrivateOrLocalEscalationHost('runbooks.mademyday.com'), false, 'public escalation hosts should remain allowed');

  const credentialedEscalationIssue = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://user:pass@runbooks.mademyday.com/escalation'
  });
  assert.ok(
    credentialedEscalationIssue.includes('MADE_MY_DAY_ESCALATION_DOC_URL must not embed username/password credentials'),
    'release readiness should reject credentialed escalation runbook URLs'
  );

  const escalationRootPathIssue = evaluateReadiness({
    MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
    MADE_MY_DAY_ONCALL_PRIMARY: 'community-oncall',
    MADE_MY_DAY_ONCALL_SECONDARY: 'community-backup',
    MADE_MY_DAY_ESCALATION_DOC_URL: 'https://runbooks.mademyday.com/'
  });
  assert.ok(
    escalationRootPathIssue.includes('MADE_MY_DAY_ESCALATION_DOC_URL must point to a specific runbook path (not site root)'),
    'release readiness should reject escalation URLs that target only the site root'
  );

  const maxBodyIssue = evaluateReadiness({ MAX_BODY_BYTES: '512' });
  assert.ok(
    maxBodyIssue.includes('MAX_BODY_BYTES must be between 1024 and 262144'),
    'release readiness should reject too-small MAX_BODY_BYTES'
  );

  const maxQueryIssue = evaluateReadiness({ MAX_QUERY_CHARS: '99999' });
  assert.ok(
    maxQueryIssue.includes('MAX_QUERY_CHARS must be between 128 and 4096'),
    'release readiness should reject out-of-range MAX_QUERY_CHARS'
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

  const maxRequestsPerSocketIssue = evaluateReadiness({ MAX_REQUESTS_PER_SOCKET: '1001' });
  assert.ok(
    maxRequestsPerSocketIssue.includes('MAX_REQUESTS_PER_SOCKET must be between 1 and 1000'),
    'release readiness should reject out-of-range MAX_REQUESTS_PER_SOCKET values'
  );

  const bodyReadTimeoutIssue = evaluateReadiness({ BODY_READ_TIMEOUT_MS: '999999' });
  assert.ok(
    bodyReadTimeoutIssue.includes('BODY_READ_TIMEOUT_MS must be between 1000 and 120000'),
    'release readiness should reject out-of-range BODY_READ_TIMEOUT_MS values'
  );

  const maxCommentsPerStoryIssue = evaluateReadiness({ MAX_COMMENTS_PER_STORY: '4' });
  assert.ok(
    maxCommentsPerStoryIssue.includes('MAX_COMMENTS_PER_STORY must be >= 5'),
    'release readiness should reject MAX_COMMENTS_PER_STORY values below 5'
  );

  const invalidAllowedHostsIssue = evaluateReadiness({
    ALLOWED_HOSTS: 'valid.example.com:443, bad host value'
  });
  assert.ok(
    invalidAllowedHostsIssue.includes('ALLOWED_HOSTS must be a comma-separated list of hosts (`host[:port]` or `[ipv6]:port`, port 1-65535)'),
    'release readiness should reject malformed ALLOWED_HOSTS entries'
  );

  const invalidLeadingHyphenHostIssue = evaluateReadiness({
    ALLOWED_HOSTS: '-bad.example.com'
  });
  assert.ok(
    invalidLeadingHyphenHostIssue.includes('ALLOWED_HOSTS must be a comma-separated list of hosts (`host[:port]` or `[ipv6]:port`, port 1-65535)'),
    'release readiness should reject host labels that begin with hyphens'
  );

  const invalidDoubleDotHostIssue = evaluateReadiness({
    ALLOWED_HOSTS: 'bad..example.com'
  });
  assert.ok(
    invalidDoubleDotHostIssue.includes('ALLOWED_HOSTS must be a comma-separated list of hosts (`host[:port]` or `[ipv6]:port`, port 1-65535)'),
    'release readiness should reject hostnames with empty labels'
  );

  const privateAllowedHostIssue = evaluateReadiness({
    ALLOWED_HOSTS: 'app.mademyday.com,127.0.0.1'
  });
  assert.ok(
    privateAllowedHostIssue.includes('ALLOWED_HOSTS must not include localhost/private network hosts in GA mode'),
    'release readiness should reject localhost/private hosts in ALLOWED_HOSTS for GA mode'
  );

  const oversizedAllowedHostIssue = evaluateReadiness({
    ALLOWED_HOSTS: Array.from({ length: 33 }, (_, i) => `app${i + 1}.mademyday.com`).join(',')
  });
  assert.ok(
    oversizedAllowedHostIssue.includes('ALLOWED_HOSTS must include at most 32 entries'),
    'release readiness should reject oversized ALLOWED_HOSTS lists'
  );
} catch (err) {
  console.error(`smoke test failed: ${err.message}`);
  process.exit(1);
}

console.log('made-my-day smoke test passed');
