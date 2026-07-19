'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.optionalDependencies || {}),
  ...Object.keys(packageJson.devDependencies || {})
]);
const builtin = new Set([
  ...require('module').builtinModules.flatMap(name => [name, `node:${name}`]),
  'node:sqlite' // available on the V16 minimum Node runtime
]);
const failures = [];
const warnings = [];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const jsFiles = walk(srcDir).filter(file => file.endsWith('.js'));
for (const file of jsFiles) {
  const relative = path.relative(root, file);
  const source = fs.readFileSync(file, 'utf8');
  if (!source.trim()) failures.push(`${relative} is empty`);

  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) failures.push(`${relative} syntax error: ${syntax.stderr.trim()}`);

  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const requested = match[1];
    if (requested.startsWith('.') || builtin.has(requested)) continue;
    const packageName = requested.startsWith('@')
      ? requested.split('/').slice(0, 2).join('/')
      : requested.split('/')[0];
    if (!declared.has(packageName)) failures.push(`${relative} imports undeclared package ${packageName}`);
  }

  if (/\b(?:10x|100x)\b/i.test(source)) failures.push(`${relative} contains a forbidden automatic leverage tier`);
  if (/claude-sonnet-4-20250514|claude-3-|deepseek-chat['"]/.test(source)) {
    warnings.push(`${relative} may contain a retired/deprecated model ID`);
  }
  if (/entryPrice\s*\*\s*0\.97|entryPrice\s*\*\s*1\.03/.test(source) && relative.includes('ultimate_ai_trader')) {
    failures.push(`${relative} still invents fixed fallback stop-loss values`);
  }
}

const requiredFiles = [
  'src/core/config.js', 'src/risk_manager.js', 'src/execution_guard.js',
  'src/order_manager.js', 'src/paper_broker.js', 'src/signal_calibrator.js',
  'src/trade_journal.js', 'src/closed_trade_reconciler.js', 'src/backtest.js'
];
for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`Missing required file ${relative}`);
}

for (const warning of [...new Set(warnings)]) console.warn(`WARN: ${warning}`);
if (failures.length) {
  for (const failure of [...new Set(failures)]) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`Static verification passed for ${jsFiles.length} source files.`);
