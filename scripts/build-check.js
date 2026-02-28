#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const required = [
  'server.js',
  'public/index.html',
  'public/app.js',
  'public/styles.css',
  'data/stories.json',
];

for (const rel of required) {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) {
    console.error(`missing required file: ${rel}`);
    process.exit(1);
  }
}

console.log('made-my-day build check passed');
