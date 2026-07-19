'use strict';

const fs = require('fs');
const path = require('path');
const { config, validateConfig } = require('./core/config');
const { getAuthorizedIds } = require('./telegram_auth');

const requiredRuntimeModules = [
  'dotenv', 'telegraf', 'technicalindicators', 'node-cron', 'ccxt', 'ws',
  'node-cache', '@anthropic-ai/sdk'
];


function nodeVersionAtLeast(requiredMajor, requiredMinor) {
  const [major, minor] = String(process.versions.node || '0.0').split('.').map(Number);
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function moduleAvailable(name) {
  try { require.resolve(name); return true; } catch (_) { return false; }
}

function runStartupDiagnostics({ throwOnError = true } = {}) {
  const result = validateConfig();
  const errors = [...result.errors];
  const warnings = [...result.warnings];
  const modules = { nodeVersion: process.versions.node };
  if (!nodeVersionAtLeast(22, 5)) errors.push(`Node.js 22.5+ is required; current ${process.versions.node}.`);

  for (const name of requiredRuntimeModules) {
    modules[name] = moduleAvailable(name);
    if (!modules[name]) errors.push(`Missing runtime dependency: ${name}. Run npm install.`);
  }
  try {
    const sqlite = require('./sqlite_adapter');
    modules.sqliteBackend = sqlite.isAvailable() ? sqlite.getBackendName() : false;
    if (!modules.sqliteBackend) errors.push('No SQLite backend: use Node.js 22.5+ or install better-sqlite3.');
  } catch (error) {
    modules.sqliteBackend = false;
    errors.push(`SQLite backend check failed: ${error.message}`);
  }

  const canvasBackends = ['@napi-rs/canvas', 'canvas'];
  const availableCanvas = canvasBackends.find(moduleAvailable);
  modules.canvasBackend = availableCanvas || false;
  if (!availableCanvas) errors.push('Missing canvas backend: install @napi-rs/canvas (preferred) or canvas.');

  for (const directory of [config.app.dataDir, config.app.logsDir]) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const testFile = path.join(directory, `.write-test-${process.pid}`);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
    } catch (error) {
      errors.push(`Directory is not writable: ${directory} (${error.message})`);
    }
  }

  if (!process.env.TELEGRAM_TOKEN) errors.push('TELEGRAM_TOKEN is required to start the Telegram bot.');
  const authorizedTelegramIds = [...getAuthorizedIds()];
  if (authorizedTelegramIds.length === 0) {
    errors.push('Set AUTHORIZED_TELEGRAM_USER_IDS (or a positive private CHAT_ID) so unauthorized users cannot control the bot.');
  }
  if (config.app.executionMode === 'live') {
    if (!process.env.BYBIT_API_KEY_RW || !process.env.BYBIT_API_SECRET_RW) {
      errors.push('Live mode requires BYBIT_API_KEY_RW and BYBIT_API_SECRET_RW.');
    }
    if (config.ai.provider === 'claude' && !process.env.ANTHROPIC_API_KEY) errors.push('Claude mode requires ANTHROPIC_API_KEY.');
    if (config.ai.provider === 'deepseek' && !process.env.DEEPSEEK_API_KEY) errors.push('DeepSeek mode requires DEEPSEEK_API_KEY.');
    if (config.ai.provider === 'ensemble' && (!process.env.ANTHROPIC_API_KEY || !process.env.DEEPSEEK_API_KEY)) {
      errors.push('Live ensemble mode requires both ANTHROPIC_API_KEY and DEEPSEEK_API_KEY.');
    }
  }

  const diagnostic = {
    valid: errors.length === 0,
    version: config.app.version,
    executionMode: config.app.executionMode,
    errors, warnings, modules,
    authorizedTelegramUsers: authorizedTelegramIds.length,
    checkedAt: new Date().toISOString()
  };
  if (!diagnostic.valid && throwOnError) {
    const error = new Error(`V16 startup diagnostics failed:\n- ${errors.join('\n- ')}`);
    error.diagnostic = diagnostic;
    throw error;
  }
  return diagnostic;
}

module.exports = { runStartupDiagnostics, requiredRuntimeModules, moduleAvailable, nodeVersionAtLeast };
