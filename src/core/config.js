'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  return Math.min(max, Math.max(min, Math.trunc(finite(value, fallback))));
}

function number(value, fallback, min = -Infinity, max = Infinity) {
  return Math.min(max, Math.max(min, finite(value, fallback)));
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function oneOf(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function csvIntegers(value, fallback, min = 1, max = 100) {
  const parsed = String(value || '')
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(item => Number.isInteger(item) && item >= min && item <= max);
  return [...new Set(parsed.length ? parsed : fallback)].sort((a, b) => a - b);
}

function csv(value, fallback = []) {
  const parsed = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

const executionMode = oneOf(process.env.EXECUTION_MODE, ['analysis', 'paper', 'live'], 'analysis');
const configuredLeverages = csvIntegers(process.env.AI_LEVERAGE_OPTIONS, [1, 2, 3, 5], 1, 5);
const maxLeverage = integer(process.env.MAX_AI_LEVERAGE, Math.max(...configuredLeverages), 1, 5);
const allowedLeverages = configuredLeverages.filter(value => value <= maxLeverage);

const config = Object.freeze({
  app: Object.freeze({
    version: '16.0.0',
    name: 'AI Trader V16 Autonomous',
    timezone: process.env.DAILY_TARGET_TIMEZONE || 'Asia/Yerevan',
    dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data')),
    logsDir: path.resolve(process.env.LOGS_DIR || path.join(__dirname, '../../logs')),
    executionMode,
    liveAck: process.env.LIVE_TRADING_ACK || '',
    shutdownOnFatal: bool(process.env.SHUTDOWN_ON_FATAL, true)
  }),

  bybit: Object.freeze({
    mode: oneOf(process.env.BYBIT_MODE, ['ro', 'rw'], executionMode === 'live' ? 'rw' : 'ro'),
    marketType: oneOf(process.env.BYBIT_MARKET_TYPE, ['swap', 'spot'], 'swap'),
    positionMode: oneOf(process.env.BYBIT_POSITION_MODE, ['oneway', 'hedge'], 'oneway'),
    demo: bool(process.env.BYBIT_DEMO_TRADING, false),
    sandbox: bool(process.env.BYBIT_SANDBOX, false),
    recvWindow: integer(process.env.BYBIT_RECV_WINDOW, 10000, 1000, 60000),
    maxEntryDriftPct: number(process.env.MAX_ENTRY_DRIFT_PCT, 0.35, 0.01, 5),
    maxSpreadPct: number(process.env.MAX_SPREAD_PCT, 0.20, 0.001, 5),
    signalMaxAgeMs: integer(process.env.SIGNAL_MAX_AGE_MS, 120000, 5000, 3600000),
    orderTimeoutMs: integer(process.env.ORDER_TIMEOUT_MS, 30000, 5000, 120000),
    protectionRetries: integer(process.env.PROTECTION_RETRIES, 4, 1, 10),
    closeUnprotectedPosition: bool(process.env.CLOSE_UNPROTECTED_POSITION, true),
    triggerBy: oneOf(process.env.TPSL_TRIGGER_BY, ['markprice', 'lastprice', 'indexprice'], 'markprice')
  }),

  ai: Object.freeze({
    provider: oneOf(process.env.AI_PROVIDER, ['ensemble', 'claude', 'deepseek'], 'ensemble'),
    requireCompleteEnsemble: bool(process.env.REQUIRE_COMPLETE_ENSEMBLE_FOR_EXECUTION, true),
    requireDirectionAgreement: bool(process.env.REQUIRE_ENSEMBLE_DIRECTION_AGREEMENT, true),
    failClosed: bool(process.env.AI_FAIL_CLOSED, true),
    timeoutMs: integer(process.env.AI_TIMEOUT_MS, 60000, 5000, 180000),
    maxRetries: integer(process.env.AI_MAX_RETRIES, 2, 1, 4),
    circuitBaseMs: integer(process.env.AI_CIRCUIT_BASE_MS, 15000, 1000, 300000),
    circuitMaxMs: integer(process.env.AI_CIRCUIT_MAX_MS, 300000, 5000, 3600000)
  }),

  risk: Object.freeze({
    riskPerTradePct: number(process.env.RISK_PER_TRADE_PCT, 0.30, 0.05, 1.0),
    maxRiskPerTradePct: number(process.env.MAX_RISK_PER_TRADE_PCT, 0.50, 0.05, 1.5),
    maxDailyNetLossPct: number(process.env.MAX_DAILY_LOSS_PCT, 2.0, 0.25, 10),
    maxDailyGrossLossPct: number(process.env.MAX_DAILY_GROSS_LOSS_PCT, 3.0, 0.25, 15),
    maxWeeklyDrawdownPct: number(process.env.MAX_WEEKLY_DRAWDOWN_PCT, 6.0, 1, 30),
    maxConsecutiveLosses: integer(process.env.MAX_CONSECUTIVE_LOSSES, 2, 1, 10),
    maxTradesPerDay: integer(process.env.MAX_TRADES_PER_DAY, 4, 1, 50),
    maxOpenPositions: integer(process.env.MAX_OPEN_POSITIONS, 2, 1, 10),
    maxPortfolioExposurePct: number(process.env.MAX_PORTFOLIO_EXPOSURE_PCT, 30, 1, 100),
    maxSymbolExposurePct: number(process.env.MAX_SYMBOL_EXPOSURE_PCT, 12, 0.5, 100),
    maxMarginPerTradePct: number(process.env.MAX_MARGIN_PER_TRADE_PCT, 8, 0.5, 50),
    minRiskReward: number(process.env.MIN_RISK_REWARD, 1.6, 0.5, 10),
    minNetRiskReward: number(process.env.MIN_NET_RISK_REWARD, 1.35, 0.25, 10),
    minExecutionScore: number(process.env.MIN_EXECUTION_SCORE, 72, 0, 100),
    minStopDistancePct: number(process.env.MIN_STOP_DISTANCE_PCT, 0.25, 0.01, 20),
    maxStopDistancePct: number(process.env.MAX_STOP_DISTANCE_PCT, 5, 0.05, 50),
    allowedLeverages: Object.freeze(allowedLeverages.length ? allowedLeverages : [1]),
    maxLeverage
  }),

  targets: Object.freeze({
    softPct: number(process.env.DAILY_SOFT_TARGET_PCT, 2, 0, 20),
    hardPct: number(process.env.DAILY_HARD_TARGET_PCT, 5, 0, 25),
    softRiskMultiplier: number(process.env.SOFT_TARGET_RISK_MULTIPLIER, 0.50, 0.05, 1),
    softMaxLeverage: integer(process.env.SOFT_TARGET_MAX_LEVERAGE, 2, 1, 5)
  }),

  calibration: Object.freeze({
    minSamples: integer(process.env.MIN_CALIBRATION_SAMPLES, 100, 20, 10000),
    requireForLive: bool(process.env.REQUIRE_CALIBRATION_FOR_LIVE, false),
    minimumLiveSamples: integer(process.env.MIN_LIVE_CALIBRATION_SAMPLES, 30, 0, 10000),
    priorWins: number(process.env.CALIBRATION_PRIOR_WINS, 6, 0, 100),
    priorLosses: number(process.env.CALIBRATION_PRIOR_LOSSES, 6, 0, 100)
  }),

  costs: Object.freeze({
    takerFeeRate: number(process.env.TRADING_FEE_RATE, 0.0006, 0, 0.01),
    estimatedSlippageRate: number(process.env.ESTIMATED_SLIPPAGE_RATE, 0.0005, 0, 0.02),
    fundingRate8h: number(process.env.ESTIMATED_FUNDING_RATE_8H, 0.0001, -0.01, 0.01)
  }),

  scanner: Object.freeze({
    timeframes: Object.freeze(csv(process.env.SCAN_TIMEFRAMES, ['15m', '1h', '4h'])),
    intervalMs: integer(process.env.AUTO_TRADE_INTERVAL, 90000, 10000, 86400000),
    maxAiAnalyses: integer(process.env.MAX_AI_ANALYSES_PER_SWEEP, 8, 1, 50),
    maxTimeframesPerCoin: integer(process.env.MAX_AI_TIMEFRAMES_PER_COIN, 1, 1, 3),
    minPrescanScore: number(process.env.MIN_PRESCAN_SCORE, 40, 0, 100),
    autoStart: bool(process.env.AUTO_START_TRADING, false)
  })
});

function validateConfig() {
  const errors = [];
  const warnings = [];

  if (config.targets.hardPct < config.targets.softPct) {
    errors.push('DAILY_HARD_TARGET_PCT must be greater than or equal to DAILY_SOFT_TARGET_PCT.');
  }
  if (config.risk.maxRiskPerTradePct < config.risk.riskPerTradePct) {
    errors.push('MAX_RISK_PER_TRADE_PCT must be >= RISK_PER_TRADE_PCT.');
  }
  if (config.app.executionMode === 'live') {
    if (config.bybit.mode !== 'rw') errors.push('Live execution requires BYBIT_MODE=rw.');
    if (config.app.liveAck !== 'I_ACCEPT_REAL_LOSS') {
      errors.push('Live execution requires LIVE_TRADING_ACK=I_ACCEPT_REAL_LOSS.');
    }
    if (config.bybit.marketType !== 'swap') errors.push('Live long/short execution requires BYBIT_MARKET_TYPE=swap.');
  }
  if (config.risk.allowedLeverages.some(value => value > 5)) {
    errors.push('V16 does not permit leverage above 5x.');
  }
  if (config.ai.provider === 'ensemble' && config.ai.requireCompleteEnsemble) {
    if (!process.env.ANTHROPIC_API_KEY) warnings.push('ANTHROPIC_API_KEY is missing; ensemble execution will fail closed.');
    if (!process.env.DEEPSEEK_API_KEY) warnings.push('DEEPSEEK_API_KEY is missing; ensemble execution will fail closed.');
  }
  if (config.app.executionMode !== 'live' && config.bybit.mode === 'rw') {
    warnings.push('BYBIT_MODE=rw is configured while EXECUTION_MODE is not live; V16 will not submit orders outside live mode.');
  }

  return { valid: errors.length === 0, errors, warnings, config };
}

module.exports = { config, validateConfig, finite, integer, number, bool, oneOf, csvIntegers, csv };
