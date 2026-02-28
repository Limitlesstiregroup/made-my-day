#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

try {
  const storiesPath = path.join(process.cwd(), 'data/stories.json');
  const raw = fs.readFileSync(storiesPath, 'utf8');
  const parsed = JSON.parse(raw);
  const stories = Array.isArray(parsed) ? parsed : parsed.stories;
  if (!Array.isArray(stories)) {
    throw new Error('stories.json must be an array or an object with a stories array');
  }
} catch (err) {
  console.error(`smoke test failed: ${err.message}`);
  process.exit(1);
}

console.log('made-my-day smoke test passed');
