'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const LEVELS = Object.freeze({
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  SUCCESS: 35,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
  SILENT: 100
});

const ANSI = Object.freeze({
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m'
});

const LEVEL_STYLE = Object.freeze({
  TRACE: { color: ANSI.gray, marker: '.' },
  DEBUG: { color: ANSI.magenta, marker: ':' },
  INFO: { color: ANSI.cyan, marker: '>' },
  SUCCESS: { color: ANSI.green, marker: '+' },
  WARN: { color: ANSI.yellow, marker: '!' },
  ERROR: { color: ANSI.red, marker: 'x' },
  FATAL: { color: `${ANSI.bold}${ANSI.red}`, marker: 'X' }
});

const CATEGORY_FILES = Object.freeze({
  SYSTEM: 'system',
  BOT: 'bot',
  COMMANDS: 'commands',
  BUTTONS: 'buttons',
  SCANS: 'scans',
  PATTERNS: 'patterns',
  INDICATORS: 'indicators',
  AI: 'ai',
  TRADES: 'trades',
  ORDERS: 'orders',
  POSITIONS: 'positions',
  BALANCE: 'balance',
  PERFORMANCE: 'performance',
  SIGNALS: 'signals',
  LIVE: 'live',
  ERRORS: 'errors'
});

const SENSITIVE_KEY = /(?:api[-_]?key|api[-_]?secret|secret|token|password|passphrase|authorization|cookie|private[-_]?key|signature|telegram_token)/i;
const TOKEN_IN_TEXT = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_IN_TEXT = /((?:api[-_]?key|api[-_]?secret|secret|token|password|passphrase|authorization|private[-_]?key)\s*[:=]\s*)["']?[^\s,"']+/gi;

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTimestamp(date = new Date()) {
  const datePart = localDateKey(date);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${datePart} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const power = 10 ** digits;
  return Math.round(number * power) / power;
}

function safeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      code: error.code,
      status: error.status || error.statusCode,
      stack: error.stack,
      cause: error.cause ? safeError(error.cause) : undefined
    };
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }

  if (error && typeof error === 'object') {
    return { ...error, message: error.message || util.inspect(error, { depth: 2 }) };
  }

  return { name: 'Error', message: String(error) };
}

function redactString(value) {
  return String(value)
    .replace(TOKEN_IN_TEXT, '$1[REDACTED]')
    .replace(ASSIGNMENT_IN_TEXT, '$1[REDACTED]');
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Error) return sanitize(safeError(value), depth + 1, seen);

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
      const result = value.slice(0, 200).map(item => sanitize(item, depth + 1, seen));
      if (value.length > 200) result.push(`[+${value.length - 200} more]`);
      return result;
    }

    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1, seen);
    }
    return result;
  }

  return redactString(String(value));
}

function safeJson(value) {
  try {
    return JSON.stringify(sanitize(value));
  } catch (error) {
    return JSON.stringify({ serializationError: error.message });
  }
}

function compact(value, maxLength = 500) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string'
    ? redactString(value)
    : util.inspect(sanitize(value), {
        depth: 3,
        colors: false,
        compact: true,
        breakLength: Infinity,
        maxArrayLength: 20,
        maxStringLength: 220
      });
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

class ProfessionalLogger {
  constructor() {
    this.appName = process.env.LOG_APP_NAME || 'ULTRA-AI-TRADER';
    this.baseDir = path.resolve(process.env.LOG_DIR || path.join(__dirname, '../logs'));
    this.consoleEnabled = envBool('LOG_CONSOLE', true);
    this.fileEnabled = envBool('LOG_FILE', true);
    this.colorEnabled = envBool('LOG_COLOR', true) && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
    this.stackEnabled = envBool('LOG_STACK', true);
    this.prettyContext = envBool('LOG_CONTEXT', true);
    this.minLevelName = String(process.env.LOG_LEVEL || 'INFO').trim().toUpperCase();
    this.minLevel = LEVELS[this.minLevelName] ?? LEVELS.INFO;
    this.maxFileSize = envNumber('LOG_MAX_FILE_MB', 20, 1, 1024) * 1024 * 1024;
    this.retentionDays = envNumber('LOG_RETENTION_DAYS', 14, 1, 3650);
    this.currentDay = '';
    this.dailyDir = '';
    this.streams = new Map();
    this.sequence = 0;
    this.closed = false;
    this.sessionId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;

    this.ensureDay();
    this.cleanupOldLogs();
    this.installProcessHandlers();
    this.printStartup();
  }

  color(text, code) {
    return this.colorEnabled ? `${code}${text}${ANSI.reset}` : text;
  }

  timestamp() {
    return new Date().toISOString();
  }

  shouldLog(level) {
    return (LEVELS[level] ?? LEVELS.INFO) >= this.minLevel;
  }

  ensureDay() {
    const day = localDateKey();
    if (this.currentDay === day && this.dailyDir) return;

    this.closeStreams();
    this.currentDay = day;
    this.dailyDir = path.join(this.baseDir, day);
    fs.mkdirSync(this.dailyDir, { recursive: true });
  }

  categoryName(category) {
    const normalized = String(category || 'SYSTEM').trim().toUpperCase();
    return CATEGORY_FILES[normalized] ? normalized : 'SYSTEM';
  }

  resolveRotatedPath(baseName) {
    const plain = path.join(this.dailyDir, `${baseName}.jsonl`);
    if (!fs.existsSync(plain) || fs.statSync(plain).size < this.maxFileSize) return plain;

    let index = 1;
    while (true) {
      const candidate = path.join(this.dailyDir, `${baseName}.${index}.jsonl`);
      if (!fs.existsSync(candidate) || fs.statSync(candidate).size < this.maxFileSize) return candidate;
      index += 1;
    }
  }

  getStream(baseName) {
    this.ensureDay();
    const current = this.streams.get(baseName);
    if (current && current.size < this.maxFileSize && !current.stream.destroyed) return current;

    if (current) {
      current.stream.end();
      this.streams.delete(baseName);
    }

    const filePath = this.resolveRotatedPath(baseName);
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', error => {
      process.stderr.write(`[LOGGER] File stream error (${filePath}): ${error.message}${os.EOL}`);
    });

    const holder = { stream, filePath, size };
    this.streams.set(baseName, holder);
    return holder;
  }

  writeRecord(baseName, record) {
    if (!this.fileEnabled || this.closed) return;

    try {
      const line = `${safeJson(record)}${os.EOL}`;
      const holder = this.getStream(baseName);
      holder.stream.write(line);
      holder.size += Buffer.byteLength(line);
    } catch (error) {
      process.stderr.write(`[LOGGER] Write failed: ${error.message}${os.EOL}`);
    }
  }

  makeRecord(level, category, event, data = {}, message = '') {
    const now = new Date();
    return {
      ts: now.toISOString(),
      localTime: localTimestamp(now),
      seq: ++this.sequence,
      sessionId: this.sessionId,
      app: this.appName,
      pid: process.pid,
      level,
      category: this.categoryName(category),
      event: String(event || 'LOG'),
      message: redactString(message || ''),
      data: sanitize(data || {})
    };
  }

  formatValue(key, value) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number') {
      if (/confidence|percent|winRate|probability/i.test(key)) return `${round(value, 2)}%`;
      if (/price|balance|pnl|profit|loss|equity|margin|riskAmount/i.test(key)) return `$${round(value, 6)}`;
      if (/timeMs|durationMs|latency/i.test(key)) return `${Math.round(value)}ms`;
      return String(round(value, 6));
    }

    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'string') return redactString(value);
    return compact(value, 180);
  }

  formatContext(data) {
    if (!this.prettyContext || !data || typeof data !== 'object') return '';

    const priority = [
      'coin', 'symbol', 'timeframe', 'action', 'side', 'status', 'confidence',
      'price', 'entryPrice', 'entry', 'stopLoss', 'takeProfit', 'size', 'amount',
      'leverage', 'pnl', 'totalPnL', 'balance', 'winRate', 'timeMs', 'durationMs',
      'user', 'mode', 'provider', 'model', 'reason'
    ];

    const used = new Set();
    const parts = [];

    for (const key of priority) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const formatted = this.formatValue(key, data[key]);
      if (formatted !== null) parts.push(`${key}=${formatted}`);
      used.add(key);
    }

    const remainder = {};
    for (const [key, value] of Object.entries(data)) {
      if (!used.has(key) && value !== undefined) remainder[key] = value;
    }

    if (Object.keys(remainder).length > 0) {
      parts.push(compact(remainder, 320));
    }

    return parts.length > 0 ? ` | ${parts.join(' | ')}` : '';
  }

  printRecord(record) {
    if (!this.consoleEnabled || !this.shouldLog(record.level)) return;

    const style = LEVEL_STYLE[record.level] || LEVEL_STYLE.INFO;
    const time = this.color(record.localTime.slice(11), ANSI.gray);
    const marker = this.color(style.marker, style.color);
    const level = this.color(record.level.padEnd(7), style.color);
    const category = this.color(record.category.padEnd(12).slice(0, 12), ANSI.blue);
    const event = this.color(record.event, ANSI.bold);
    const message = record.message ? ` - ${record.message}` : '';
    const context = this.formatContext(record.data);
    const line = `${time} ${marker} ${level} ${category} ${event}${message}${context}`;

    const output = record.level === 'ERROR' || record.level === 'FATAL'
      ? process.stderr
      : process.stdout;
    output.write(`${line}${os.EOL}`);

    if (this.stackEnabled && record.data?.error?.stack) {
      const stack = String(record.data.error.stack)
        .split('\n')
        .slice(1, 8)
        .map(item => `             ${this.color(item.trim(), ANSI.gray)}`)
        .join(os.EOL);
      if (stack) output.write(`${stack}${os.EOL}`);
    }
  }

  emit(level, category, event, data = {}, message = '') {
    if (!this.shouldLog(level)) return null;

    const record = this.makeRecord(level, category, event, data, message);
    this.writeRecord('all', record);
    this.writeRecord(CATEGORY_FILES[record.category] || 'system', record);
    if ((level === 'ERROR' || level === 'FATAL') && record.category !== 'ERRORS') {
      this.writeRecord('errors', record);
    }
    this.printRecord(record);
    return record;
  }

  trace(event, data = {}, category = 'SYSTEM') {
    return this.emit('TRACE', category, event, data);
  }

  debug(event, data = {}, category = 'SYSTEM') {
    return this.emit('DEBUG', category, event, data);
  }

  info(event, data = {}, category = 'SYSTEM') {
    return this.emit('INFO', category, event, data);
  }

  success(event, data = {}, category = 'SYSTEM') {
    return this.emit('SUCCESS', category, event, data);
  }

  warn(event, data = {}, category = 'SYSTEM') {
    if (data instanceof Error || typeof data === 'string') {
      return this.emit('WARN', category, event, { warning: sanitize(data) });
    }
    return this.emit('WARN', category, event, data);
  }

  fatal(module, error, context = {}) {
    const normalized = safeError(error);
    return this.emit('FATAL', 'ERRORS', module, { ...sanitize(context), error: normalized }, normalized.message);
  }

  error(module, error, context = {}) {
    const normalized = safeError(error);
    return this.emit('ERROR', 'ERRORS', module, { ...sanitize(context), error: normalized }, normalized.message);
  }

  step(step, data = {}) {
    return this.emit('INFO', 'SYSTEM', step, data);
  }

  action(action, data = {}) {
    const level = /CONNECTED|COMPLETE|EXECUTED|RECOVERED|RESUME|STARTED|READY|SUCCESS/i.test(action)
      ? 'SUCCESS'
      : /BLOCKED|SKIP|RETRY|STOP|DISCONNECT|MISSING|LIMIT/i.test(action)
        ? 'WARN'
        : 'INFO';
    return this.emit(level, 'BOT', action, data);
  }

  command(command, user, data = {}) {
    return this.emit('INFO', 'COMMANDS', command, { user, ...sanitize(data) });
  }

  button(button, user, data = {}) {
    return this.emit('DEBUG', 'BUTTONS', button, { user, ...sanitize(data) });
  }

  scanStart(coin, timeframe) {
    return this.emit('INFO', 'SCANS', 'SCAN_START', { coin, timeframe });
  }

  scanComplete(coin, patterns, indicators, decision, timeMs) {
    const data = {
      coin,
      timeframe: decision?.timeframe,
      action: decision?.action || 'HOLD',
      confidence: decision?.confidence,
      patternCount: Array.isArray(patterns) ? patterns.length : 0,
      rsi: indicators?.rsi,
      macd: indicators?.macd,
      ema: indicators?.ema,
      support: indicators?.support,
      resistance: indicators?.resistance,
      timeMs
    };
    return this.emit('SUCCESS', 'SCANS', 'SCAN_COMPLETE', data);
  }

  patterns(coin, patterns = [], count = patterns.length) {
    const safePatterns = Array.isArray(patterns) ? patterns : [];
    const summary = {
      bullish: safePatterns.filter(p => p?.type === 'BULLISH').length,
      bearish: safePatterns.filter(p => p?.type === 'BEARISH').length,
      neutral: safePatterns.filter(p => p?.type === 'NEUTRAL').length
    };
    return this.emit('INFO', 'PATTERNS', 'PATTERNS_DETECTED', {
      coin,
      count,
      summary,
      patterns: safePatterns.map(p => ({ name: p?.name, type: p?.type, strength: p?.strength ?? p?.confidence }))
    });
  }

  indicators(coin, ind = {}) {
    return this.emit('INFO', 'INDICATORS', 'INDICATORS_CALCULATED', {
      coin,
      rsi: ind?.rsi,
      rsi21: ind?.rsi21,
      ema9: ind?.ema9,
      ema21: ind?.ema21,
      ema50: ind?.ema50,
      ema200: ind?.ema200,
      macd: ind?.macd,
      macdSignal: ind?.macdSignal,
      macdHistogram: ind?.macdHistogram,
      stochK: ind?.stochK,
      stochD: ind?.stochD,
      bbUpper: ind?.bbUpper,
      bbLower: ind?.bbLower,
      atr: ind?.atr,
      support: ind?.support,
      resistance: ind?.resistance,
      trend: ind?.marketTrend,
      volatility: ind?.volatilityLevel,
      liquidity: ind?.liquidity
    });
  }

  ai(coin, sentiment, confidence, reasoning, action, entryPrice, stopLoss, takeProfit) {
    const entry = toFiniteNumber(entryPrice);
    const sl = toFiniteNumber(stopLoss);
    const tp = toFiniteNumber(takeProfit);
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const riskReward = risk > 0 ? reward / risk : 0;
    const level = action === 'HOLD' ? 'WARN' : 'SUCCESS';
    return this.emit(level, 'AI', 'AI_DECISION', {
      coin,
      action,
      confidence,
      sentiment,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      riskReward: round(riskReward, 3),
      reasoning
    });
  }

  trade(coin, action, entryPrice, stopLoss, takeProfit, size, reasoning, orderId, status, pnl = 0) {
    const level = /closed|filled|success|executed|open/i.test(String(status)) ? 'SUCCESS' : 'WARN';
    const data = {
      coin: coin || 'unknown',
      action: action || 'UNKNOWN',
      entryPrice: toFiniteNumber(entryPrice),
      stopLoss: toFiniteNumber(stopLoss),
      takeProfit: toFiniteNumber(takeProfit),
      size: toFiniteNumber(size),
      reasoning: reasoning || 'No reasoning',
      orderId: orderId || 'unknown',
      status: status || 'unknown',
      pnl: toFiniteNumber(pnl)
    };
    this.emit(level, 'TRADES', 'TRADE', data);
    this.emit(level, 'ORDERS', 'MARKET_ORDER', { ...data, orderType: 'market' });
    return data;
  }

  balance(balance = {}, mode) {
    return this.emit('INFO', 'BALANCE', 'BALANCE_SNAPSHOT', {
      balance: toFiniteNumber(balance?.totalUSD),
      tradableUSD: toFiniteNumber(balance?.tradableUSD),
      walletUSDT: toFiniteNumber(balance?.walletUSDT),
      fundingUSDT: toFiniteNumber(balance?.fundingUSDT),
      mode,
      assets: (balance?.assets || []).map(asset => ({
        asset: asset.asset,
        total: asset.total,
        free: asset.free,
        used: asset.used,
        usdValue: asset.usdValue
      }))
    });
  }

  performance(balance, totalPnL, winRate, totalTrades, winningTrades, losingTrades, positions) {
    return this.emit('INFO', 'PERFORMANCE', 'PERFORMANCE_SNAPSHOT', {
      balance: toFiniteNumber(balance),
      totalPnL: toFiniteNumber(totalPnL),
      winRate: toFiniteNumber(winRate),
      totalTrades: toFiniteNumber(totalTrades),
      winningTrades: toFiniteNumber(winningTrades),
      losingTrades: toFiniteNumber(losingTrades),
      activePositions: toFiniteNumber(positions)
    });
  }

  position(coin, side, amount, entryPrice, currentPrice, pnl, pnlPercent) {
    return this.emit(toFiniteNumber(pnl) >= 0 ? 'SUCCESS' : 'WARN', 'POSITIONS', 'POSITION_UPDATE', {
      coin,
      side,
      amount: toFiniteNumber(amount),
      entryPrice: toFiniteNumber(entryPrice),
      currentPrice: toFiniteNumber(currentPrice),
      pnl: toFiniteNumber(pnl),
      pnlPercent: toFiniteNumber(pnlPercent)
    });
  }

  signal(coin, action, confidence, patterns = [], reasoning) {
    return this.emit(action === 'HOLD' ? 'WARN' : 'SUCCESS', 'SIGNALS', 'TRADING_SIGNAL', {
      coin,
      action,
      confidence,
      patterns: (patterns || []).map(pattern => typeof pattern === 'string' ? pattern : pattern?.name),
      reasoning
    });
  }

  order(coin, side, amount, price, orderType, status, orderId, error = null) {
    const data = {
      coin,
      side,
      amount: toFiniteNumber(amount),
      price: toFiniteNumber(price),
      orderType,
      status,
      orderId,
      error: error ? safeError(error) : null
    };
    const level = error || /reject|fail|cancel/i.test(String(status)) ? 'ERROR' : 'SUCCESS';
    return this.emit(level, 'ORDERS', 'ORDER_UPDATE', data);
  }

  liveUpdate(coin, data) {
    return this.emit('DEBUG', 'LIVE', 'LIVE_UPDATE', { coin, ...sanitize(data) });
  }

  section(title, data = {}) {
    if (!this.consoleEnabled) return;
    const width = 86;
    const heading = ` ${String(title).trim()} `;
    const left = Math.max(2, Math.floor((width - heading.length) / 2));
    const right = Math.max(2, width - heading.length - left);
    const line = `${'-'.repeat(left)}${heading}${'-'.repeat(right)}`;
    process.stdout.write(`${this.color(line, ANSI.blue)}${os.EOL}`);
    if (Object.keys(data).length > 0) {
      process.stdout.write(`${this.color(compact(data, 1200), ANSI.gray)}${os.EOL}`);
    }
  }

  timer(event, baseData = {}, category = 'SYSTEM') {
    const startedAt = process.hrtime.bigint();
    return (extraData = {}, level = 'SUCCESS') => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return this.emit(level, category, event, { ...baseData, ...extraData, durationMs: round(durationMs, 2) });
    };
  }

  readCategory(baseName, limit = 20) {
    try {
      this.ensureDay();
      const files = fs.readdirSync(this.dailyDir)
        .filter(name => name === `${baseName}.jsonl` || name.startsWith(`${baseName}.`) && name.endsWith('.jsonl'))
        .sort((a, b) => {
          const aStat = fs.statSync(path.join(this.dailyDir, a));
          const bStat = fs.statSync(path.join(this.dailyDir, b));
          return aStat.mtimeMs - bStat.mtimeMs;
        });

      const lines = [];
      for (const file of files) {
        const text = fs.readFileSync(path.join(this.dailyDir, file), 'utf8');
        lines.push(...text.split(/\r?\n/).filter(Boolean));
      }

      return lines.slice(-Math.max(0, limit)).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  getRecentTrades(limit = 10) {
    return this.readCategory('trades', limit).map(item => item.data || item);
  }

  getPerformance() {
    return this.readCategory('performance', Number.MAX_SAFE_INTEGER).map(item => item.data || item);
  }

  getErrors(limit = 20) {
    return this.readCategory('errors', limit).map(item => ({
      ts: item.ts,
      module: item.event,
      error: item.data?.error?.message || item.message,
      stack: item.data?.error?.stack,
      context: item.data
    }));
  }

  getTodayLogs() {
    try {
      this.ensureDay();
      const result = {};
      const files = fs.readdirSync(this.dailyDir).filter(name => name.endsWith('.jsonl'));
      for (const file of files) {
        const baseName = file.replace(/\.\d+\.jsonl$/, '').replace(/\.jsonl$/, '').toUpperCase();
        const count = fs.readFileSync(path.join(this.dailyDir, file), 'utf8').split(/\r?\n/).filter(Boolean).length;
        result[baseName] = (result[baseName] || 0) + count;
      }
      return result;
    } catch {
      return {};
    }
  }

  getRecentSteps(limit = 20) {
    return this.readCategory('all', limit).map(item => ({
      ts: item.ts,
      step: item.event,
      data: item.data,
      level: item.level,
      category: item.category
    }));
  }

  cleanupOldLogs() {
    if (!this.fileEnabled) return;
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(this.baseDir)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
        const folder = path.join(this.baseDir, name);
        const stat = fs.statSync(folder);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(folder, { recursive: true, force: true });
        }
      }
    } catch (error) {
      process.stderr.write(`[LOGGER] Retention cleanup failed: ${error.message}${os.EOL}`);
    }
  }

  printStartup() {
    if (!this.consoleEnabled) return;
    const width = 86;
    const title = `${this.appName} LOGGING`;
    const line = '='.repeat(width);
    process.stdout.write(`${this.color(line, ANSI.blue)}${os.EOL}`);
    process.stdout.write(`${this.color(title.padStart(Math.floor((width + title.length) / 2)).padEnd(width), `${ANSI.bold}${ANSI.cyan}`)}${os.EOL}`);
    process.stdout.write(`${this.color(line, ANSI.blue)}${os.EOL}`);
    process.stdout.write(`${this.color(' Session ', ANSI.gray)}${this.sessionId}  ${this.color('Level', ANSI.gray)} ${this.minLevelName}  ${this.color('Files', ANSI.gray)} ${this.fileEnabled ? this.dailyDir : 'disabled'}${os.EOL}`);
    process.stdout.write(`${this.color('-'.repeat(width), ANSI.gray)}${os.EOL}`);
  }

  installProcessHandlers() {
    if (global.__ULTRA_LOGGER_PROCESS_HANDLERS__) return;
    global.__ULTRA_LOGGER_PROCESS_HANDLERS__ = true;

    process.on('uncaughtException', error => {
      this.fatal('UNCAUGHT_EXCEPTION', error);
      this.flush();
    });

    process.on('unhandledRejection', reason => {
      this.error('UNHANDLED_REJECTION', reason instanceof Error ? reason : new Error(compact(reason, 1000)));
    });

    process.once('beforeExit', () => this.close());
    process.once('exit', () => this.closeStreams());
  }

  flush() {
    for (const holder of this.streams.values()) {
      if (holder.stream.writable && typeof holder.stream.emit === 'function') {
        holder.stream.emit('drain');
      }
    }
  }

  closeStreams() {
    for (const holder of this.streams.values()) {
      try { holder.stream.end(); } catch { /* ignore shutdown errors */ }
    }
    this.streams.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeStreams();
  }
}

module.exports = new ProfessionalLogger();
module.exports.ProfessionalLogger = ProfessionalLogger;
module.exports.sanitize = sanitize;

