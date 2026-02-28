#!/usr/bin/env node
const { spawnSync } = require('child_process');

const result = spawnSync(process.execPath, ['--check', 'server.js'], {
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log('made-my-day lint check passed');
