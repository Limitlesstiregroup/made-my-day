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
      PORT: String(PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForServer();

    const badContentType = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ text: 'This is a validly long story body that should not be accepted with wrong content type.' })
    });
    if (badContentType.status !== 415) {
      throw new Error(`expected 415 for invalid content-type, got ${badContentType.status}`);
    }

    const uniqueSuffix = Date.now();
    const createStory = await fetch(`${BASE}/api/stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
