'use strict';

const ultimateAI = require('./ultimate_ai_trader');
const { getMarketData } = require('./analyzer');

function buildDataFromCandles(coin, candles, indicators = {}, timeframe = '1h') {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const opens = candles.map(candle => Number(candle[1]));
  const highs = candles.map(candle => Number(candle[2]));
  const lows = candles.map(candle => Number(candle[3]));
  const closes = candles.map(candle => Number(candle[4]));
  const volumes = candles.map(candle => Number(candle[5]));
  const price = closes.at(-1);
  const previous = closes[Math.max(0, closes.length - 25)] || price;

  return {
    coin,
    timeframe,
    price,
    change24h: previous > 0 ? ((price - previous) / previous) * 100 : 0,
    candles,
    opens,
    highs,
    lows,
    closes,
    volumes,
    volume: volumes.at(-1) || 0,
    volumeSpike: Number(indicators.volumeSpike) || 1,
    rsi: Number(indicators.rsi) || 50,
    ema: Number(indicators.ema ?? indicators.ema50) || price,
    ema200: Number(indicators.ema200) || price,
    macd: Number(indicators.macd?.MACD ?? indicators.macd?.macd ?? indicators.macd) || 0,
    macdSignal: Number(indicators.macd?.signal ?? indicators.macdSignal) || 0,
    macdHistogram: Number(indicators.macd?.histogram ?? indicators.macdHistogram) || 0,
    bb: indicators.bb || { upper: price * 1.02, middle: price, lower: price * 0.98 },
    stoch: indicators.stoch || { k: 50, d: 50 },
    atr: Number(indicators.atr) || 0,
    support: Number(indicators.support) || Math.min(...lows.slice(-50)),
    resistance: Number(indicators.resistance) || Math.max(...highs.slice(-50)),
    vwap: Number(indicators.vwap) || 0,
    pivotPoints: indicators.pivotPoints || {},
    fibonacci: indicators.fibonacci || null,
    rsiData: indicators.rsiData || [],
    emaData: indicators.emaData || [],
    ema200Data: indicators.ema200Data || [],
    macdData: indicators.macdData || []
  };
}

class AITrader {
  async analyze(coin, candles = null, indicators = {}, options = {}) {
    const symbol = String(coin || '').toUpperCase().replace('/USDT', '').replace(':USDT', '').trim();
    if (!symbol) throw new Error('A coin symbol is required');
    const timeframe = options.timeframe || '1h';
    const suppliedData = buildDataFromCandles(symbol, candles, indicators, timeframe);
    const data = suppliedData || await getMarketData(symbol, timeframe, options.limit || 250);
    return ultimateAI.analyzeOnly(symbol, data, options.patterns || null);
  }

  async analyzeMarket(coin, options = {}) {
    return this.analyze(coin, null, {}, options);
  }

  getStatus() {
    return ultimateAI.getAIStatus();
  }
}

module.exports = new AITrader();
module.exports.AITrader = AITrader;
