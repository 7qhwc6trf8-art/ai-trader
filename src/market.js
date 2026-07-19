'use strict';

const ccxt = require('ccxt');
const NodeCache = require('node-cache');
const logger = require('./logger');
const { config, bool } = require('./core/config');

const TIMEFRAME_MS = Object.freeze({
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000
});
const TIMEFRAMES = Object.freeze(Object.fromEntries(Object.keys(TIMEFRAME_MS).map(key => [key, key])));
const BYBIT_MARKET_TYPE = config.bybit.marketType;
const useOnlyClosedCandles = bool(process.env.USE_ONLY_CLOSED_CANDLES, true);
const cache = new NodeCache({ stdTTL: 30, useClones: true, checkperiod: 60 });

const bybit = new ccxt.bybit({
  enableRateLimit: true,
  options: {
    defaultType: BYBIT_MARKET_TYPE,
    defaultSubType: BYBIT_MARKET_TYPE === 'swap' ? 'linear' : undefined,
    defaultSettle: BYBIT_MARKET_TYPE === 'swap' ? 'USDT' : undefined
  }
});
let marketsPromise = null;

function loadMarketsOnce() {
  if (!marketsPromise) {
    marketsPromise = bybit.loadMarkets().catch(error => {
      marketsPromise = null;
      throw error;
    });
  }
  return marketsPromise;
}

function normalizeBybitSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('A valid Bybit symbol is required');
  const raw = symbol.trim().toUpperCase();
  if (raw.includes(':')) return raw;
  const base = raw.includes('/') ? raw.split('/')[0] : (raw.endsWith('USDT') ? raw.slice(0, -4) : raw);
  if (!base) throw new Error(`Invalid Bybit symbol: ${symbol}`);
  return BYBIT_MARKET_TYPE === 'swap' ? `${base}/USDT:USDT` : `${base}/USDT`;
}

function isCandleClosed(candle, timeframe, now = Date.now()) {
  const duration = TIMEFRAME_MS[timeframe];
  return Array.isArray(candle) && Number(candle[0]) + duration <= now;
}

function cacheTtlSeconds(timeframe) {
  return Math.max(5, Math.min(60, Math.floor(TIMEFRAME_MS[timeframe] / 1000 / 12)));
}

async function getCandles(symbol, timeframe = '1h', limit = 200) {
  if (!TIMEFRAMES[timeframe]) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const normalizedLimit = Math.max(2, Math.min(999, Number.parseInt(limit, 10) || 200));
  const marketSymbol = normalizeBybitSymbol(symbol);
  const cacheKey = `bybit:${BYBIT_MARKET_TYPE}:${marketSymbol}:${timeframe}:${normalizedLimit}:closed=${useOnlyClosedCandles}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    await loadMarketsOnce();
    if (!bybit.markets?.[marketSymbol]) throw new Error(`Bybit market not found: ${marketSymbol}`);
    const requestedLimit = Math.min(1000, normalizedLimit + (useOnlyClosedCandles ? 2 : 0));
    const data = await bybit.fetchOHLCV(marketSymbol, timeframe, undefined, requestedLimit);
    const now = Date.now();
    let sanitized = (Array.isArray(data) ? data : [])
      .filter(candle => Array.isArray(candle) && candle.length >= 6)
      .map(candle => candle.slice(0, 6).map(Number))
      .filter(candle => candle.every(Number.isFinite));
    if (useOnlyClosedCandles) sanitized = sanitized.filter(candle => isCandleClosed(candle, timeframe, now));
    sanitized = sanitized.slice(-normalizedLimit);
    if (sanitized.length < Math.min(2, normalizedLimit)) throw new Error(`Bybit returned insufficient closed candles for ${marketSymbol}`);
    cache.set(cacheKey, sanitized, cacheTtlSeconds(timeframe));
    return sanitized;
  } catch (error) {
    logger.error('CANDLES_FETCH', error, { marketSymbol, timeframe });
    const allowMock = bool(process.env.ALLOW_MOCK_MARKET_DATA, false);
    if (!allowMock) throw new Error(`Live Bybit candles unavailable for ${marketSymbol} ${timeframe}: ${error.message}`);
    const data = generateMockData(symbol, normalizedLimit, timeframe);
    cache.set(cacheKey, data, cacheTtlSeconds(timeframe));
    return data;
  }
}


async function getTicker(symbol) {
  const marketSymbol = normalizeBybitSymbol(symbol);
  await loadMarketsOnce();
  const ticker = await bybit.fetchTicker(marketSymbol);
  return ticker;
}

async function getMarketRules(symbol, referencePrice = 0) {
  const marketSymbol = normalizeBybitSymbol(symbol);
  await loadMarketsOnce();
  const market = bybit.market(marketSymbol);
  if (!market) return { error: `Bybit market not found: ${marketSymbol}` };
  const lot = market.info?.lotSizeFilter || {};
  const leverageFilter = market.info?.leverageFilter || {};
  const positive = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
  };
  const step = positive(lot.qtyStep, market.precision?.amount);
  const minAmount = positive(lot.minOrderQty, market.limits?.amount?.min);
  const minCost = positive(lot.minNotionalValue, market.limits?.cost?.min);
  const price = Number(referencePrice) || 0;
  const costAmount = price > 0 && minCost > 0 ? minCost / price : 0;
  const minimumRaw = Math.max(step, minAmount, costAmount);
  const minimumOrderAmount = step > 0 ? Math.ceil((minimumRaw / step) - 1e-12) * step : minimumRaw;
  return {
    symbol: marketSymbol,
    amountStep: step,
    minAmount,
    minCost,
    minimumOrderAmount,
    maxLeverage: market.spot ? 1 : positive(leverageFilter.maxLeverage, market.limits?.leverage?.max, 5),
    active: market.active !== false,
    spot: market.spot === true,
    swap: market.swap === true,
    linear: market.linear === true,
    marketType: market.type || BYBIT_MARKET_TYPE
  };
}

function generateMockData(symbol, limit, timeframe = '1h', seed = 42) {
  const data = [];
  const basePrices = { BTC: 65000, ETH: 3500, SOL: 150, XRP: 0.60, BNB: 600, AVAX: 40, ADA: 0.45, DOGE: 0.12, LINK: 15, DOT: 7 };
  let state = (Number(seed) >>> 0) || 42;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  let price = basePrices[String(symbol).toUpperCase().split('/')[0]] || 10;
  const timeframeMs = TIMEFRAME_MS[timeframe] || 3600000;
  const start = Date.now() - ((limit + 1) * timeframeMs);
  for (let i = 0; i < limit; i += 1) {
    const cyclicalMove = Math.sin(i / 15) * 0.0025;
    const noise = (random() - 0.5) * 0.009;
    const open = price;
    const close = Math.max(1e-8, open * (1 + cyclicalMove + noise));
    const high = Math.max(open, close) * (1 + random() * 0.006);
    const low = Math.min(open, close) * (1 - random() * 0.006);
    const volume = random() * 2000 + 500;
    data.push([start + (i * timeframeMs), open, high, low, close, volume]);
    price = close;
  }
  return data;
}

module.exports = { getCandles, getTicker, getMarketRules, normalizeBybitSymbol, isCandleClosed, loadMarketsOnce, generateMockData, TIMEFRAMES, TIMEFRAME_MS, BYBIT_MARKET_TYPE };
