#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || process.cwd());
const extensions = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml']);

function decodeMojibake(value) {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    // Node's latin1 mapping repairs the common UTF-8-as-Latin-1 case.
    const candidate = Buffer.from(current, 'latin1').toString('utf8');
    if (candidate === current || candidate.includes('\uFFFD')) break;
    const before = (current.match(/[ÃÂâðï]/g) || []).length;
    const after = (candidate.match(/[ÃÂâðï]/g) || []).length;
    if (after >= before) break;
    current = candidate;
  }
  return current;
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target);
      continue;
    }
    if (!extensions.has(path.extname(entry.name).toLowerCase()) && !entry.name.startsWith('.env')) continue;
    const original = fs.readFileSync(target, 'utf8');
    const fixed = original.replace(/[^\x00-\x7F]+/g, decodeMojibake);
    if (fixed !== original) {
      fs.writeFileSync(target, fixed, 'utf8');
      console.log(`fixed ${path.relative(root, target)}`);
    }
  }
}

walk(root);
