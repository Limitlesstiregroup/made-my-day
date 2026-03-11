#!/usr/bin/env node
const { spawn } = require('child_process');
const net = require('node:net');

const PORT = Number(process.env.MADE_MY_DAY_E2E_PORT || (4300 + Math.floor(Math.random() * 1000)));
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
    if (typeof healthVersionJson?.memoryRssBytes !== 'number' || typeof healthVersionJson?.heapUsedBytes !== 'number') {
      throw new Error('health version endpoint missing memoryRssBytes/heapUsedBytes payload');
    }
    if (typeof healthVersionJson?.cpuUserMicros !== 'number' || typeof healthVersionJson?.cpuSystemMicros !== 'number') {
      throw new Error('health version endpoint missing cpuUserMicros/cpuSystemMicros payload');
    }
    if (
      typeof healthVersionJson?.fsReadBytes !== 'number'
      || typeof healthVersionJson?.fsWriteBytes !== 'number'
      || typeof healthVersionJson?.voluntaryContextSwitches !== 'number'
      || typeof healthVersionJson?.involuntaryContextSwitches !== 'number'
    ) {
      throw new Error('health version endpoint missing fs/context-switch telemetry payload');
    }
    if (
      typeof healthVersionJson?.eventLoopUtilization !== 'number'
      || typeof healthVersionJson?.eventLoopActiveMillis !== 'number'
      || typeof healthVersionJson?.eventLoopIdleMillis !== 'number'
      || typeof healthVersionJson?.eventLoopDelayMeanMillis !== 'number'
      || typeof healthVersionJson?.eventLoopDelayP99Millis !== 'number'
      || typeof healthVersionJson?.eventLoopDelayMaxMillis !== 'number'
    ) {
      throw new Error('health version endpoint missing event-loop telemetry payload');
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
      `Host: 127.0.0.1:${PORT}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    const [, healthHeadBody = ''] = healthHeadRaw.split('\r\n\r\n');
    if (healthHeadBody !== '') {
      throw new Error('expected no payload body for HEAD /api/health');
    }

    const missingHostResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(missingHostResponse)) {
      throw new Error('expected 400 when host header is missing on HTTP/1.1 requests');
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
      `Host: 127.0.0.1:${PORT}`,
      `Host: 127.0.0.1:${PORT}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateHostHeaderResponse)) {
      throw new Error('expected 400 when duplicate Host headers are sent');
    }

    const duplicateAcceptHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Accept: application/json',
      'Accept: */*',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateAcceptHeaderResponse)) {
      throw new Error('expected 400 when duplicate Accept headers are sent');
    }

    const duplicateAcceptLanguageHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Accept-Language: en-US',
      'Accept-Language: en',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateAcceptLanguageHeaderResponse)) {
      throw new Error('expected 400 when duplicate Accept-Language headers are sent');
    }

    const duplicateAcceptCharsetHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Accept-Charset: utf-8',
      'Accept-Charset: iso-8859-1',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateAcceptCharsetHeaderResponse)) {
      throw new Error('expected 400 when duplicate Accept-Charset headers are sent');
    }

    const duplicateCookieHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Cookie: session=abc123',
      'Cookie: prefs=dark',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateCookieHeaderResponse)) {
      throw new Error('expected 400 when duplicate cookie headers are sent');
    }

    const duplicateIfNoneMatchHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'If-None-Match: "etag-a"',
      'If-None-Match: "etag-b"',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateIfNoneMatchHeaderResponse)) {
      throw new Error('expected 400 when duplicate if-none-match headers are sent');
    }

    const duplicateIfModifiedSinceHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'If-Modified-Since: Wed, 21 Oct 2015 07:28:00 GMT',
      'If-Modified-Since: Thu, 22 Oct 2015 07:28:00 GMT',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateIfModifiedSinceHeaderResponse)) {
      throw new Error('expected 400 when duplicate if-modified-since headers are sent');
    }

    const duplicateRequestIdHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Request-Id: reqidgood1234',
      'X-Request-Id: reqidgood5678',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateRequestIdHeaderResponse)) {
      throw new Error('expected 400 when duplicate x-request-id headers are sent');
    }

    const duplicateMatchingContentLengthHeaderResponse = await sendRawHttp([
      'POST /api/stories HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Authorization: Bearer admin_token_live_primary_1234',
      'Content-Type: application/json',
      'Content-Length: 62',
      'Content-Length: 62',
      'Connection: close',
      '',
      '{"author":"Nia","message":"Small kindness made my whole day."}'
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateMatchingContentLengthHeaderResponse)) {
      throw new Error('expected 400 when duplicate content-length headers are sent, even when values match');
    }

const malformedRequestIdHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Request-Id: invalid request id',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(malformedRequestIdHeaderResponse)) {
      throw new Error('expected 400 when x-request-id header is malformed');
    }

    const duplicateContentTypeHeaderResponse = await sendRawHttp([
      'POST /api/stories HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Authorization: Bearer admin_token_live_primary_1234',
      'Content-Type: application/json',
      'Content-Type: application/json; charset=utf-8',
      'Accept: application/json',
      'Content-Length: 62',
      'Connection: close',
      '',
      '{"author":"Nia","message":"Small kindness made my whole day."}'
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateContentTypeHeaderResponse)) {
      throw new Error('expected 400 when duplicate content-type headers are sent');
    }

    const multiHopForwardingHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
      'Upgrade: websocket',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(upgradeHeaderResponse)) {
      throw new Error('expected 400 when upgrade header is present');
    }

    const websocketHandshakeHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(websocketHandshakeHeaderResponse)) {
      throw new Error('expected 400 when websocket handshake headers are present');
    }

    const traceMethodResponse = await sendRawHttp([
      'TRACE /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 405 /.test(traceMethodResponse)) {
      throw new Error('expected 405 when TRACE method is sent');
    }

    const connectMethodResponse = await sendRawHttp([
      `CONNECT 127.0.0.1:${PORT} HTTP/1.1`,
      `Host: 127.0.0.1:${PORT}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 405 /.test(connectMethodResponse)) {
      throw new Error('expected 405 when CONNECT method is sent');
    }

    const proxyConnectionHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Proxy-Connection: keep-alive',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(proxyConnectionHeaderResponse)) {
      throw new Error('expected 400 when proxy-connection header is present');
    }

    const proxyAuthorizationHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Proxy-Authorization: Basic Zm9vOmJhcg==',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(proxyAuthorizationHeaderResponse)) {
      throw new Error('expected 400 when proxy-authorization header is present');
    }

    const proxyAuthenticateHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Proxy-Authenticate: Basic realm="proxy"',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(proxyAuthenticateHeaderResponse)) {
      throw new Error('expected 400 when proxy-authenticate header is present');
    }

    const xForwardedClientCertHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Client-Cert: By=spiffe://edge-proxy;Hash=abc123;Subject="";URI=spiffe://client/workload',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(xForwardedClientCertHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-client-cert header is present');
    }

    const proxyHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Proxy: http://proxy.example:8080',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(proxyHeaderResponse)) {
      throw new Error('expected 400 when proxy header is present');
    }

    const earlyDataHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Early-Data: 1',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(earlyDataHeaderResponse)) {
      throw new Error('expected 400 when early-data header is present');
    }

    const altUsedHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Alt-Used: made-my-day.example',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(altUsedHeaderResponse)) {
      throw new Error('expected 400 when alt-used header is present');
    }

    const http2SettingsHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'HTTP2-Settings: AAMAAABkAAQAAP__',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(http2SettingsHeaderResponse)) {
      throw new Error('expected 400 when http2-settings header is present');
    }

    const maxForwardsHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Max-Forwards: 0',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(maxForwardsHeaderResponse)) {
      throw new Error('expected 400 when max-forwards header is present');
    }

    const pathOverrideHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
      'TE: trailers',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(teHeaderResponse)) {
      throw new Error('expected 400 when te header is present');
    }

    const trailerHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Trailer: x-signature',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(trailerHeaderResponse)) {
      throw new Error('expected 400 when trailer header is present');
    }

    const keepAliveHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Keep-Alive: timeout=5, max=1000',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(keepAliveHeaderResponse)) {
      throw new Error('expected 400 when keep-alive header is present');
    }

    const conflictingConnectionHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Connection: keep-alive, close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(conflictingConnectionHeaderResponse)) {
      throw new Error('expected 400 when connection header has conflicting persistence directives');
    }

    const multiHopForwardedProtoHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Proto: websocket',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedProtoHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-proto is not http/https while TRUST_PROXY=true');
    }

    const multiHopForwardedServerHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Server: edge-01,origin-01',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(multiHopForwardedServerHeaderResponse)) {
      throw new Error('expected 400 when multi-hop x-forwarded-server headers are sent while TRUST_PROXY=true');
    }

    const invalidForwardedServerHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Server: edge node',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedServerHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-server is malformed while TRUST_PROXY=true');
    }

    const multiHopForwardedPortHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Port: 443',
      'X-Forwarded-Port: 80',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateForwardedPortHeaderResponse)) {
      throw new Error('expected 400 when duplicate x-forwarded-port headers are sent while TRUST_PROXY=true');
    }

const multiHopForwardedPrefixHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Prefix: /edge,/origin',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(multiHopForwardedPrefixHeaderResponse)) {
      throw new Error('expected 400 when multi-hop x-forwarded-prefix headers are sent while TRUST_PROXY=true');
    }

    const invalidForwardedPrefixHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'X-Forwarded-Prefix: edge',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedPrefixHeaderResponse)) {
      throw new Error('expected 400 when x-forwarded-prefix is malformed while TRUST_PROXY=true');
    }

    const invalidForwardedPortHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
      'Forwarded: for=_hidden',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidForwardedHeaderResponse)) {
      throw new Error('expected 400 when forwarded is malformed while TRUST_PROXY=true');
    }

    const absoluteTargetResponse = await sendRawHttp([
      `GET http://127.0.0.1:${PORT}/api/health HTTP/1.1`,
      `Host: 127.0.0.1:${PORT}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(absoluteTargetResponse)) {
      throw new Error('expected 400 when request-target is absolute-form instead of origin-form');
    }

    const conflictingContentLengthResponse = await sendRawHttp([
      'POST /api/stories HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
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
      `Host: 127.0.0.1:${PORT}`,
      'Content-Length: two',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(invalidContentLengthOnGetResponse)) {
      throw new Error('expected 400 when content-length header is malformed before route handling');
    }

    const nonZeroContentLengthOnGetResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Content-Length: 1',
      'Connection: close',
      '',
      'x'
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(nonZeroContentLengthOnGetResponse)) {
      throw new Error('expected 400 when GET request carries body framing before route handling');
    }

    const transferEncodingOnHeadResponse = await sendRawHttp([
      'HEAD /api/health HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '0',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(transferEncodingOnHeadResponse)) {
      throw new Error('expected 400 when HEAD request carries transfer-encoding before route handling');
    }

    const oversizedHeaderResponse = await sendRawHttp([
      'GET /api/health HTTP/1.1',
      `X-Oversized: ${'x'.repeat(20000)}`,
      `Host: 127.0.0.1:${PORT}`,
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

    const duplicateAuthorizationHealthDetails = await sendRawHttp([
      `GET /api/health/details HTTP/1.1`,
      `Host: 127.0.0.1:${PORT}`,
      'Authorization: Bearer admin_token_live_primary_1234',
      'Authorization: Bearer admin_token_live_primary_1234',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateAuthorizationHealthDetails)) {
      throw new Error('expected 400 for duplicate authorization headers on admin endpoint');
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

    const storiesFeed = await fetch(`${BASE}/api/stories?limit=1&offset=0`);
    if (storiesFeed.status !== 200) {
      throw new Error(`expected 200 for stories feed, got ${storiesFeed.status}`);
    }
    if (!(storiesFeed.headers.get('vary') || '').toLowerCase().includes('authorization')) {
      throw new Error('expected Vary: Authorization on cached stories feed responses');
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

    const duplicateIdempotencyPayload = JSON.stringify({
      text: `Today I brought coffee to my neighbor and it made their morning brighter. ${uniqueSuffix}`,
      author: 'smoke-test'
    });
    const duplicateIdempotencyCreateStory = await sendRawHttp([
      'POST /api/stories HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Content-Type: application/json; charset=utf-8',
      'Idempotency-Key: idem_story_dup',
      'Idempotency-Key: idem_story_dup',
      `Content-Length: ${Buffer.byteLength(duplicateIdempotencyPayload)}`,
      'Connection: close',
      '',
      duplicateIdempotencyPayload
    ].join('\r\n'));
    if (!/^HTTP\/1\.1 400 /.test(duplicateIdempotencyCreateStory)) {
      throw new Error('expected 400 for duplicate idempotency-key headers on story create');
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

    const badLikeAccept = await fetch(`${BASE}/api/stories/${storyId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: '{}'
    });
    if (badLikeAccept.status !== 406) {
      throw new Error(`expected 406 for invalid like accept header, got ${badLikeAccept.status}`);
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

    const badImportAccept = await fetch(`${BASE}/api/import/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin_token_live_primary_1234',
        Accept: 'text/plain'
      },
      body: JSON.stringify({})
    });
    if (badImportAccept.status !== 406) {
      throw new Error(`expected 406 for invalid import accept header, got ${badImportAccept.status}`);
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
