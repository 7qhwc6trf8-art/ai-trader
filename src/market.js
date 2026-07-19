const ccxt = require('ccxt');
const NodeCache = require('node-cache');
const logger = require('./logger');

const cache = new NodeCache({ stdTTL: 60 });

const requestedMarketType = String(process.env.BYBIT_MARKET_TYPE || 'swap').toLowerCase();
const BYBIT_MARKET_TYPE = ['swap', 'spot'].includes(requestedMarketType)
  ? requestedMarketType
  : 'swap';

// Public Bybit client used only for market candles. Authentication and order
// execution remain isolated in bybit_client.js.
const bybit = new ccxt.bybit({
  enableRateLimit: true,
  options: {
    defaultType: BYBIT_MARKET_TYPE,
    defaultSubType: BYBIT_MARKET_TYPE === 'swap' ? 'linear' : undefined,
    defaultSettle: BYBIT_MARKET_TYPE === 'swap' ? 'USDT' : undefined
  }
});

const TIMEFRAMES = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w'
};

function normalizeBybitSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new Error('A valid Bybit symbol is required');
  }

  const raw = symbol.trim().toUpperCase();
  if (raw.includes(':')) return raw;

  let base;
  if (raw.includes('/')) {
    base = raw.split('/')[0];
  } else {
    base = raw.endsWith('USDT') ? raw.slice(0, -4) : raw;
  }

  if (!base) {
    throw new Error(`Invalid Bybit symbol: ${symbol}`);
  }

  return BYBIT_MARKET_TYPE === 'swap'
    ? `${base}/USDT:USDT`
    : `${base}/USDT`;
}

async function getCandles(symbol, timeframe = '1h', limit = 200) {
  if (!TIMEFRAMES[timeframe]) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const normalizedLimit = Math.max(2, Math.min(1000, Number.parseInt(limit, 10) || 200));
  const marketSymbol = normalizeBybitSymbol(symbol);
  const cacheKey = `bybit_${BYBIT_MARKET_TYPE}_${marketSymbol}_${timeframe}_${normalizedLimit}`;
  const cached = cache.get(cacheKey);

  if (cached) {
    logger.step('CANDLES_CACHE_HIT', {
      exchange: 'bybit',
      marketType: BYBIT_MARKET_TYPE,
      symbol: marketSymbol,
      timeframe
    });
    return cached;
  }

  try {
    logger.step('CANDLES_FETCH_START', {
      exchange: 'bybit',
      marketType: BYBIT_MARKET_TYPE,
      symbol: marketSymbol,
      timeframe,
      limit: normalizedLimit
    });

    await bybit.loadMarkets();
    if (!bybit.markets?.[marketSymbol]) {
      throw new Error(`Bybit market not found: ${marketSymbol}`);
    }

    const data = await bybit.fetchOHLCV(
      marketSymbol,
      timeframe,
      undefined,
      normalizedLimit
    );

    if (!Array.isArray(data) || data.length < 2) {
      throw new Error(`Bybit returned insufficient candles for ${marketSymbol}`);
    }

    const sanitized = data
      .filter(candle => Array.isArray(candle) && candle.length >= 6)
      .map(candle => candle.slice(0, 6).map(Number))
      .filter(candle => candle.every(Number.isFinite));

    if (sanitized.length < 2) {
      throw new Error(`Bybit returned invalid candle data for ${marketSymbol}`);
    }

    cache.set(cacheKey, sanitized);
    logger.step('CANDLES_FETCH_COMPLETE', {
      exchange: 'bybit',
      marketType: BYBIT_MARKET_TYPE,
      symbol: marketSymbol,
      timeframe,
      count: sanitized.length
    });
    return sanitized;
  } catch (error) {
    logger.error('CANDLES_FETCH', error, {
      exchange: 'bybit',
      marketType: BYBIT_MARKET_TYPE,
      symbol: marketSymbol,
      timeframe
    });

    const allowMock = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.ALLOW_MOCK_MARKET_DATA || 'false').toLowerCase()
    );

    if (!allowMock) {
      throw new Error(
        `Live Bybit candles unavailable for ${marketSymbol} ${timeframe}: ${error.message}`
      );
    }

    logger.warn('MOCK_MARKET_DATA_ENABLED', {
      exchange: 'bybit',
      symbol: marketSymbol,
      timeframe,
      reason: error.message
    });

    const data = generateMockData(symbol, normalizedLimit, timeframe);
    cache.set(cacheKey, data);
    return data;
  }
}

function generateMockData(symbol, limit, timeframe = '1h') {
  // Test-only synthetic candles. Keep the exact CCXT OHLCV shape:
  // [timestamp, open, high, low, close, volume].
  const data = [];
  const basePrices = {
    BTC: 65000,
    ETH: 3500,
    SOL: 150,
    XRP: 0.60,
    BNB: 600,
    AVAX: 40,
    ADA: 0.45,
    DOGE: 0.12,
    LINK: 15,
    DOT: 7
  };
  let price = basePrices[String(symbol).toUpperCase().split('/')[0]] || 10;
  const timeframeMs = {
    '1m': 60000,
    '5m': 300000,
    '15m': 900000,
    '30m': 1800000,
    '1h': 3600000,
    '4h': 14400000,
    '1d': 86400000,
    '1w': 604800000
  }[timeframe] || 3600000;
  const start = Date.now() - (limit * timeframeMs);

  for (let i = 0; i < limit; i += 1) {
    const cyclicalMove = Math.sin(i / 15) * 0.0025;
    const noise = (Math.random() - 0.5) * 0.009;
    const open = price;
    const close = Math.max(1e-8, open * (1 + cyclicalMove + noise));
    const high = Math.max(open, close) * (1 + Math.random() * 0.006);
    const low = Math.min(open, close) * (1 - Math.random() * 0.006);
    const volume = Math.random() * 2000 + 500;
    data.push([start + (i * timeframeMs), open, high, low, close, volume]);
    price = close;
  }

  return data;
}

module.exports = {
  getCandles,
  normalizeBybitSymbol,
  TIMEFRAMES,
  BYBIT_MARKET_TYPE
};

