#!/usr/bin/env node
const { spawn } = require('child_process');
const net = require('node:net');

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(deadlineMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await wait(150);
  }
  throw new Error('server did not become ready in time');
}

async function sendRawHttp(requestText) {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
      socket.write(requestText);
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('RAW_HTTP_TIMEOUT')));
  });
}

async function run() {
  const server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
      MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS: 'admin_token_live_previous_5678',
      MADE_MY_DAY_ONCALL_PRIMARY: '',
      MADE_MY_DAY_ONCALL_PRIMARY_FILE: '',
      MADE_MY_DAY_ONCALL_SECONDARY: '',
      MADE_MY_DAY_ONCALL_SECONDARY_FILE: '',
      MADE_MY_DAY_ESCALATION_DOC_URL: '',
      MADE_MY_DAY_ESCALATION_DOC_URL_FILE: '',
      MAX_COMMENTS_PER_STORY: '5',
      RATE_LIMIT_MAX_MUTATIONS: '1000',
      RATE_LIMIT_WINDOW_MS: '60000',
      TRUST_PROXY: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForServer();

    const healthLive = await fetch(`${BASE}/api/health/live`);
    if (healthLive.status !== 200) {
      throw new Error(`expected 200 for liveness health endpoint, got ${healthLive.status}`);
    }
    const healthLiveJson = await healthLive.json();
    if (healthLiveJson?.ok !== true || typeof healthLiveJson?.uptimeSeconds !== 'number') {
      throw new Error('liveness health endpoint missing ok/uptimeSeconds payload');
    }

    const healthVersion = await fetch(`${BASE}/api/health/version`);
    if (healthVersion.status !== 200) {
      throw new Error(`expected 200 for health version endpoint, got ${healthVersion.status}`);
    }
    const healthVersionJson = await healthVersion.json();
    if (healthVersionJson?.ok !== true || typeof healthVersionJson?.version !== 'string') {
      throw new Error('health version endpoint missing ok/version payload');
    }
    if (typeof healthVersionJson?.nodeVersion !== 'string' || typeof healthVersionJson?.startedAt !== 'string') {
      throw new Error('health version endpoint missing nodeVersion/startedAt payload');
    }

    const healthWrongMethod = await fetch(`${BASE}/api/health`, { method: 'POST' });
    if (healthWrongMethod.status !== 405) {
      throw new Error(`expected 405 for non-GET/HEAD health endpoint access, got ${healthWrongMethod.status}`);
    }
    if (healthWrongMethod.headers.get('allow') !== 'GET, HEAD') {
      throw new Error('expected Allow: GET, HEAD for non-GET/HEAD health endpoint access');
    }

    const healthHead = await fetch(`${BASE}/api/health`, { method: 'HEAD' });
    if (healthHead.status !== 200) {
      throw new Error(`expected 200 for HEAD health endpoint access, got ${healthHead.status}`);
    }

    const healthHeadRaw = await sendRawHttp([
      'HEAD /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    const [, healthHeadBody = ''] = healthHeadRaw.split('\r\n\r\n');
    if (healthHeadBody !== '') {
      throw new Error('expected no payload body for HEAD /api/health');
    }

    const malformedHostResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: good.example,bad.example',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 421 /.test(malformedHostResponse)) {
      throw new Error('expected 421 when host header contains comma-separated values');
    }

    const malformedUserInfoHostResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: good.example:443@evil.example',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 421 /.test(malformedUserInfoHostResponse)) {
      throw new Error('expected 421 when host header contains invalid userinfo delimiters');
    }

    const duplicateHostHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Host: 127.0.0.1:4399',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateHostHeaderResponse)) {
      throw new Error('expected 400 when duplicate Host headers are sent');
    }

    const multiHopForwardingHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-For: 203.0.113.10, 198.51.100.11',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(multiHopForwardingHeaderResponse)) {
      throw new Error('expected 400 when multi-hop forwarding headers are sent while TRUST_PROXY=true');
    }

    const multiHopForwardedHostHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Host: edge.mademyday.app, origin.mademyday.app',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(multiHopForwardedHostHeaderResponse)) {
      throw new Error('expected 400 when multi-hop x-forwarded-host headers are sent while TRUST_PROXY=true');
    }

    const duplicateForwardedHostHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Host: edge.mademyday.app',
      'X-Forwarded-Host: origin.mademyday.app',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateForwardedHostHeaderResponse)) {
      throw new Error('expected 400 when duplicate x-forwarded-host headers are sent while TRUST_PROXY=true');
    }

    const methodOverrideHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-HTTP-Method-Override: DELETE',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(methodOverrideHeaderResponse)) {
      throw new Error('expected 400 when x-http-method-override header is present');
    }

    const expectHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Expect: 100-continue',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/HTTP\/1\.1 417 /.test(expectHeaderResponse)) {
      throw new Error('expected 417 when expect header is present');
    }

    const upgradeHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Upgrade: websocket',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(upgradeHeaderResponse)) {
      throw new Error('expected 400 when upgrade header is present');
    }

    const traceMethodResponse = await sendRawHttp([
      'TRACE /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 405 /.test(traceMethodResponse)) {
      throw new Error('expected 405 when TRACE method is sent');
    }

    const proxyConnectionHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Proxy-Connection: keep-alive',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(proxyConnectionHeaderResponse)) {
      throw new Error('expected 400 when proxy-connection header is present');
    }

    const pathOverrideHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Original-URL: /api/admin/gift-cards',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(pathOverrideHeaderResponse)) {
      throw new Error('expected 400 when x-original-url header is present');
    }

    const teHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'TE: trailers',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(teHeaderResponse)) {
      throw new Error('expected 400 when te header is present');
    }

    const multiHopForwardedProtoHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Proto: https,http',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(multiHopForwardedProtoHeaderResponse)) {
      throw new Error('expected 400 when multi-hop x-forwarded-proto headers are sent while TRUST_PROXY=true');
    }

    const invalidForwardedProtoHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Proto: websocket',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedProtoHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-proto is not http/https while TRUST_PROXY=true');
    }

    const multiHopForwardedPortHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Port: 443,80',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(multiHopForwardedPortHeaderResponse)) {
      throw new Error('expected 400 when multi-hop x-forwarded-port headers are sent while TRUST_PROXY=true');
    }

    const duplicateForwardedPortHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Port: 443',
      'X-Forwarded-Port: 80',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateForwardedPortHeaderResponse)) {
      throw new Error('expected 400 when duplicate x-forwarded-port headers are sent while TRUST_PROXY=true');
    }

    const invalidForwardedPortHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Port: 70000',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedPortHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-port is out of range while TRUST_PROXY=true');
    }

    const invalidForwardedHostHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-Host: bad host',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedHostHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-host is malformed while TRUST_PROXY=true');
    }

    const invalidForwardedForHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'X-Forwarded-For: not-an-ip',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedForHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-for is malformed while TRUST_PROXY=true');
    }

    const invalidForwardedHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Forwarded: for=_hidden',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedHeaderResponse)) {
      throw new Error('expected 400 when forwarded is malformed while TRUST_PROXY=true');
    }

    const absoluteTargetResponse = await sendRawHttp([
      'GET http://127.0.0.1:4399/api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(absoluteTargetResponse)) {
      throw new Error('expected 400 when request-target is absolute-form instead of origin-form');
    }

    const conflictingContentLengthResponse = await sendRawHttp([
      'POST /api/stories HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Content-Type: application/json',
      'Content-Length: 2',
      'Content-Length: 3',
      'Connection: close',
      '',
      '{}'
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(conflictingContentLengthResponse)) {
      throw new Error('expected 400 when content-length headers conflict');
    }

    const ambiguousFramingResponse = await sendRawHttp([
      'POST /api/stories HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Content-Length: 4',
      'Connection: close',
      '',
      '0',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(ambiguousFramingResponse)) {
      throw new Error('expected 400 when transfer-encoding and content-length are both present');
    }

    const invalidContentLengthOnGetResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Host: 127.0.0.1:4399',
      'Content-Length: two',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidContentLengthOnGetResponse)) {
      throw new Error('expected 400 when content-length header is malformed before route handling');
    }

    const oversizedHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `X-Oversized: ${'x'.repeat(20000)}`,
      'Host: 127.0.0.1:4399',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 431 /.test(oversizedHeaderResponse)) {
      throw new Error('expected 431 when request headers exceed parser limits');
    }

    const readiness = await fetch(`${BASE}/api/health/ready`);
    if (readiness.status !== 503) {
      throw new Error(`expected 503 for readiness with missing GA config, got ${readiness.status}`);
    }
    const readinessJson = await readiness.json();
    if (!Array.isArray(readinessJson?.issueCodes) || readinessJson.issueCodes.length === 0) {
      throw new Error('readiness endpoint should return issueCodes array for GA triage');
    }

    const oversizedUrl = await fetch(`${BASE}/api/health?pad=${'x'.repeat(2200)}`);
    if (oversizedUrl.status !== 414) {
      throw new Error(`expected 414 for oversized request URL, got ${oversizedUrl.status}`);
    }

    const oversizedQuery = await fetch(`${BASE}/api/health?${'x'.repeat(1200)}`);
    if (oversizedQuery.status !== 414) {
      throw new Error(`expected 414 for oversized query string, got ${oversizedQuery.status}`);
    }

    const unauthorizedHealthDetails = await fetch(`${BASE}/api/health/details`);
    if (unauthorizedHealthDetails.status !== 401) {
      throw new Error(`expected 401 for health details without admin token, got ${unauthorizedHealthDetails.status}`);
    }
    if (unauthorizedHealthDetails.headers.get('vary') !== 'Authorization') {
      throw new Error('expected Vary: Authorization on unauthorized health details');
    }

    const malformedHealthDetails = await fetch(`${BASE}/api/health/details`, {
      headers: { Authorization: 'Bearer admin_token_live_primary_1234, Bearer injected' }
    });
    if (malformedHealthDetails.status !== 400) {
      throw new Error(`expected 400 for malformed authorization header, got ${malformedHealthDetails.status}`);
    }

    const healthDetails = await fetch(`${BASE}/api/health/details`, {
      headers: { Authorization: 'Bearer admin_token_live_primary_1234' }
    });
    if (healthDetails.status !== 200) {
      throw new Error(`expected 200 for health details with admin token, got ${healthDetails.status}`);
    }
    const healthDetailsJson = await healthDetails.json();
    if (!healthDetailsJson?.operations?.totals || typeof healthDetailsJson.operations.totals.stories !== 'number') {
      throw new Error('health details missing operational totals');
    }
    if (!healthDetailsJson?.operations?.runtimeGuards || typeof healthDetailsJson.operations.runtimeGuards.rateLimitKeysCapacity !== 'number') {
      throw new Error('health details missing runtime guard telemetry');
    }

    const unauthorizedGiftCardCsv = await fetch(`${BASE}/api/admin/gift-cards.csv`);
    if (unauthorizedGiftCardCsv.status !== 401) {
      throw new Error(`expected 401 for gift-card csv without admin token, got ${unauthorizedGiftCardCsv.status}`);
    }

    const authorizedHallCsv = await fetch(`${BASE}/api/admin/hall-of-fame.csv`, {
      headers: { Authorization: 'Bearer admin_token_live_primary_1234' }
    });
    if (authorizedHallCsv.status !== 200) {
      throw new Error(`expected 200 for hall-of-fame csv export, got ${authorizedHallCsv.status}`);
    }
    if (authorizedHallCsv.headers.get('vary') !== 'Authorization') {
      throw new Error('expected Vary: Authorization on admin csv export');
    }
    const hallCsvText = await authorizedHallCsv.text();
    if (!hallCsvText.includes('storyId,publishedAt,score,giftCardCode,notifiedAt')) {
      throw new Error('hall-of-fame csv export missing expected headers');
    }

    const badContentType = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ text: 'This is a validly long story body that should not be accepted with wrong content type.' })
    });
    if (badContentType.status !== 415) {
      throw new Error(`expected 415 for invalid content-type, got ${badContentType.status}`);
    }

    const badContentEncoding = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip'
      },
      body: JSON.stringify({ text: 'This encoded payload should be rejected for unsupported content encoding.' })
    });
    if (badContentEncoding.status !== 415) {
      throw new Error(`expected 415 for unsupported content-encoding, got ${badContentEncoding.status}`);
    }

    const uniqueSuffix = Date.now();
    const idempotencyKey = `create-story-${uniqueSuffix}`;
    const createStory = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        text: `Today I helped a stranger with their groceries and they smiled all the way home. ${uniqueSuffix}`,
        author: 'smoke-test'
      })
    });
    if (createStory.status !== 201) {
      throw new Error(`expected 201 for story create, got ${createStory.status}`);
    }

    const created = await createStory.json();
    const storyId = created?.story?.id;
    if (!storyId) {
      throw new Error('create story response missing story id');
    }

    const idempotentRetry = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        text: `Today I helped a stranger with their groceries and they smiled all the way home. ${uniqueSuffix}`,
        author: 'smoke-test'
      })
    });
    if (idempotentRetry.status !== 200) {
      throw new Error(`expected 200 for idempotent retry, got ${idempotentRetry.status}`);
    }
    const idempotentRetryJson = await idempotentRetry.json();
    if (idempotentRetryJson?.story?.id !== storyId || idempotentRetryJson?.idempotent !== true) {
      throw new Error('idempotent retry did not return original story payload');
    }

    const invalidIdempotencyKey = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Idempotency-Key': 'bad key with spaces'
      },
      body: JSON.stringify({
        text: `Today I brought coffee to my neighbor and it made their morning brighter. ${uniqueSuffix}`,
        author: 'smoke-test'
      })
    });
    if (invalidIdempotencyKey.status !== 400) {
      throw new Error(`expected 400 for create with malformed idempotency key, got ${invalidIdempotencyKey.status}`);
    }
    const invalidIdempotencyJson = await invalidIdempotencyKey.json();
    if (invalidIdempotencyJson?.error !== 'invalid idempotency-key header') {
      throw new Error('malformed idempotency key should return explicit validation error');
    }

    const badLikeType = await fetch(`${BASE}/api/stories/${storyId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}'
    });
    if (badLikeType.status !== 415) {
      throw new Error(`expected 415 for invalid like content-type, got ${badLikeType.status}`);
    }

    const goodLike = await fetch(`${BASE}/api/stories/${storyId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (goodLike.status !== 200) {
      throw new Error(`expected 200 for like mutation, got ${goodLike.status}`);
    }

    const badShareType = await fetch(`${BASE}/api/stories/${storyId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}'
    });
    if (badShareType.status !== 415) {
      throw new Error(`expected 415 for invalid share content-type, got ${badShareType.status}`);
    }

    const goodShare = await fetch(`${BASE}/api/stories/${storyId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (goodShare.status !== 200) {
      throw new Error(`expected 200 for share mutation, got ${goodShare.status}`);
    }

    const badCommentType = await fetch(`${BASE}/api/stories/${storyId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ text: 'Nice!' })
    });
    if (badCommentType.status !== 415) {
      throw new Error(`expected 415 for invalid comment content-type, got ${badCommentType.status}`);
    }

    const goodComment = await fetch(`${BASE}/api/stories/${storyId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Love this positive moment.' })
    });
    if (goodComment.status !== 201) {
      throw new Error(`expected 201 for comment create, got ${goodComment.status}`);
    }
    const goodCommentBody = await goodComment.json();
    if (goodCommentBody?.comment?.author !== 'Anonymous') {
      throw new Error(`expected default Anonymous author, got ${goodCommentBody?.comment?.author}`);
    }

    for (let i = 0; i < 4; i += 1) {
      const extraComment = await fetch(`${BASE}/api/stories/${storyId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Extra comment ${i + 1} to fill per-story cap.` })
      });
      if (extraComment.status !== 201) {
        throw new Error(`expected 201 while filling comment cap, got ${extraComment.status}`);
      }
    }

    const maxedComment = await fetch(`${BASE}/api/stories/${storyId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'This comment should exceed the per-story cap.' })
    });
    if (maxedComment.status !== 409) {
      throw new Error(`expected 409 when max comments per story reached, got ${maxedComment.status}`);
    }

    const badImportType = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}'
    });
    if (badImportType.status !== 415) {
      throw new Error(`expected 415 for invalid import content-type, got ${badImportType.status}`);
    }

    const unauthorizedImportRun = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (unauthorizedImportRun.status !== 401) {
      throw new Error(`expected 401 for missing admin token, got ${unauthorizedImportRun.status}`);
    }

    const authorizedWithPreviousToken = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin_token_live_previous_5678'
      },
      body: JSON.stringify({})
    });
    if (authorizedWithPreviousToken.status !== 200) {
      throw new Error(`expected 200 for previous admin token during rotation, got ${authorizedWithPreviousToken.status}`);
    }

    const malformedImportIdempotency = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Idempotency-Key': 'bad,key'
      },
      body: JSON.stringify({})
    });
    if (malformedImportIdempotency.status !== 400) {
      throw new Error(`expected 400 for malformed import idempotency header, got ${malformedImportIdempotency.status}`);
    }

    const importIdempotencyKey = `import-run-${uniqueSuffix}`;
    const importRunFirst = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Idempotency-Key': importIdempotencyKey
      },
      body: JSON.stringify({})
    });
    if (importRunFirst.status !== 200) {
      throw new Error(`expected 200 for first import run with idempotency key, got ${importRunFirst.status}`);
    }
    const importRunFirstJson = await importRunFirst.json();
    if (importRunFirstJson?.idempotent !== false) {
      throw new Error('expected first idempotent import run to return idempotent=false');
    }

    const importRunRetry = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Idempotency-Key': importIdempotencyKey
      },
      body: JSON.stringify({})
    });
    if (importRunRetry.status !== 200) {
      throw new Error(`expected 200 for idempotent import retry, got ${importRunRetry.status}`);
    }
    const importRunRetryJson = await importRunRetry.json();
    if (importRunRetryJson?.idempotent !== true) {
      throw new Error('expected idempotent import retry to return idempotent=true');
    }

    const badHallType = await fetch(`${BASE}/api/hall-of-fame/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Content-Type': 'text/plain'
      },
      body: '{}'
    });
    if (badHallType.status !== 415) {
      throw new Error(`expected 415 for invalid hall-of-fame content-type, got ${badHallType.status}`);
    }

    const goodHallRun = await fetch(`${BASE}/api/hall-of-fame/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    if (goodHallRun.status !== 200) {
      throw new Error(`expected 200 for hall-of-fame run, got ${goodHallRun.status}`);
    }

    const hallFeed = await fetch(`${BASE}/api/hall-of-fame?limit=1&offset=0`);
    if (hallFeed.status !== 200) {
      throw new Error(`expected 200 for hall-of-fame feed, got ${hallFeed.status}`);
    }
    const hallFeedJson = await hallFeed.json();
    if (!hallFeedJson?.pagination || hallFeedJson.pagination.limit !== 1 || hallFeedJson.pagination.offset !== 0) {
      throw new Error('hall-of-fame feed should include pagination metadata');
    }

    const malformedHallIdempotency = await fetch(`${BASE}/api/hall-of-fame/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'bad,key'
      },
      body: JSON.stringify({})
    });
    if (malformedHallIdempotency.status !== 400) {
      throw new Error(`expected 400 for malformed hall-of-fame idempotency header, got ${malformedHallIdempotency.status}`);
    }

    const hallIdempotencyKey = `hall-run-${uniqueSuffix}`;
    const hallRunFirst = await fetch(`${BASE}/api/hall-of-fame/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Content-Type': 'application/json',
        'Idempotency-Key': hallIdempotencyKey
      },
      body: JSON.stringify({})
    });
    if (hallRunFirst.status !== 200) {
      throw new Error(`expected 200 for first hall-of-fame run with idempotency key, got ${hallRunFirst.status}`);
    }
    const hallRunFirstJson = await hallRunFirst.json();
    if (hallRunFirstJson?.idempotent !== false) {
      throw new Error('expected first idempotent hall-of-fame run to return idempotent=false');
    }

    const hallRunRetry = await fetch(`${BASE}/api/hall-of-fame/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin_token_live_primary_1234',
        'Content-Type': 'application/json',
        'Idempotency-Key': hallIdempotencyKey
      },
      body: JSON.stringify({})
    });
    if (hallRunRetry.status !== 200) {
      throw new Error(`expected 200 for hall-of-fame idempotent retry, got ${hallRunRetry.status}`);
    }
    const hallRunRetryJson = await hallRunRetry.json();
    if (hallRunRetryJson?.idempotent !== true) {
      throw new Error('expected hall-of-fame idempotent retry to return idempotent=true');
    }

    console.log('made-my-day e2e api test passed');
  } finally {
    server.kill('SIGTERM');
    await wait(100);
    if (!server.killed) server.kill('SIGKILL');
    if (stderr.trim()) {
      // keep stderr available for debugging if needed
    }
  }
}

run().catch((error) => {
  console.error(`e2e api test failed: ${error.message}`);
  process.exit(1);
});
