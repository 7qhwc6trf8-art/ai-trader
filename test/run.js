'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname)
  .filter(name => name.endsWith('.test.js'))
  .sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${file}`);
  } else {
    console.log(`PASS ${file}`);
  }
}
if (failed) process.exit(1);
console.log(`All ${files.length} test files passed.`);
