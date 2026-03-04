#!/usr/bin/env node
const { spawn } = require('child_process');

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

async function run() {
  const server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MADE_MY_DAY_ADMIN_TOKEN: 'admin_token_live_primary_1234',
      MADE_MY_DAY_ADMIN_TOKEN_PREVIOUS: 'admin_token_live_previous_5678'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForServer();

    const unauthorizedHealthDetails = await fetch(`${BASE}/api/health/details`);
    if (unauthorizedHealthDetails.status !== 401) {
      throw new Error(`expected 401 for health details without admin token, got ${unauthorizedHealthDetails.status}`);
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
    if (invalidIdempotencyKey.status !== 201) {
      throw new Error(`expected 201 for create with invalid idempotency key treated as non-idempotent, got ${invalidIdempotencyKey.status}`);
    }
    const invalidIdempotencyJson = await invalidIdempotencyKey.json();
    if (invalidIdempotencyJson?.story?.id === storyId) {
      throw new Error('invalid idempotency key should not reuse prior story id');
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
