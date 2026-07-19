'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const sourceDirs = ['src', 'scripts'];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

for (const dir of sourceDirs) walk(path.join(root, dir));

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax error: ${path.relative(root, file)}`);
    console.error(result.stderr || result.stdout);
  }
}

const packageJson = require(path.join(root, 'package.json'));
const declared = new Set(Object.keys(packageJson.dependencies || {}));
const builtins = new Set(require('module').builtinModules.map(name => name.replace(/^node:/, '')));
const missing = new Map();
const requirePattern = /require\(['"]([^'"]+)['"]\)/g;

for (const file of files.filter(file => file.includes(`${path.sep}src${path.sep}`))) {
  const text = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = requirePattern.exec(text))) {
    const moduleName = match[1];
    if (moduleName.startsWith('.')) continue;
    const rootName = moduleName.startsWith('@')
      ? moduleName.split('/').slice(0, 2).join('/')
      : moduleName.split('/')[0];
    if (builtins.has(rootName) || declared.has(rootName)) continue;
    if (!missing.has(rootName)) missing.set(rootName, []);
    missing.get(rootName).push(path.relative(root, file));
  }
}

if (missing.size) {
  failed = true;
  for (const [name, users] of missing) {
    console.error(`Missing dependency ${name}: ${[...new Set(users)].join(', ')}`);
  }
}

const botSource = fs.readFileSync(path.join(root, 'src', 'bot.js'), 'utf8');
if (/4x, 5x, 10x or 100x|4x\/5x\/10x\/100x/.test(botSource)) {
  failed = true;
  console.error('Outdated unsafe leverage text remains in src/bot.js');
}

const ultimateSource = fs.readFileSync(path.join(root, 'src', 'ultimate_ai_trader.js'), 'utf8');
if (/one of 0, 4, 5, 10, 100/.test(ultimateSource)) {
  failed = true;
  console.error('Outdated leverage schema remains in ultimate_ai_trader.js');
}
if (!ultimateSource.includes("source: 'dual-ai-incomplete-hold'")) {
  failed = true;
  console.error('Strict incomplete-ensemble HOLD gate is missing');
}

const analyzerSource = fs.readFileSync(path.join(root, 'src', 'analyzer.js'), 'utf8');
if (!/TIMEFRAMES:\s*\[[^\]]*["']1w["']/.test(analyzerSource)) {
  failed = true;
  console.error('1w timeframe is shown in Telegram but not exported by analyzer.js');
}

for (const callback of ['stats_daily', 'stats_week', 'stats_month', 'stats_year', 'stats_refresh', 'tf_1w']) {
  if (!botSource.includes(callback)) {
    failed = true;
    console.error(`Missing Telegram callback: ${callback}`);
  }
}

if (botSource.includes('riskManager.checkDailyLoss(')) {
  failed = true;
  console.error('bot.js calls non-existent riskManager.checkDailyLoss');
}

if (failed) process.exit(1);
console.log(`OK: ${files.length} JavaScript files passed syntax and dependency audit.`);
