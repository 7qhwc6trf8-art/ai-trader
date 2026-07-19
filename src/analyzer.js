const { getCandles } = require("./market");
const { RSI, EMA, MACD, BollingerBands, Stochastic, ATR } = require("technicalindicators");
const logger = require('./logger');
const { calculateFibonacci, calculatePivotPoints, calculateVWAP } = require('./technical_tools');

async function getMarketData(coin, timeframe = "1h", limit = 200) {
    logger.step('MARKET_DATA_FETCH', { coin, timeframe, limit });

    try {
        const candles = await getCandles(coin, timeframe, limit);

        const opens = candles.map(c => c[1]);
        const highs = candles.map(c => c[2]);
        const lows = candles.map(c => c[3]);
        const closes = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);

        const lastIndex = closes.length - 1;
        const price = closes[lastIndex];

        const rsiData = RSI.calculate({ period: 14, values: closes });
        const rsi = rsiData.at(-1) ?? 50;

        const emaData = EMA.calculate({ period: 50, values: closes });
        const ema200Data = EMA.calculate({ period: 200, values: closes });
        const ema = emaData.at(-1) ?? price;
        const ema200 = ema200Data.at(-1) ?? price;

        const macdData = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
        const macd = macdData.at(-1) ?? {
            macd: 0,
            signal: 0,
            histogram: 0
        };

        const bbData = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
        const bb = bbData.at(-1) ?? {
            upper: price * 1.02,
            middle: price,
            lower: price * 0.98
        };

        const stochData = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
        const stoch = stochData.at(-1) ?? {
            k: 50,
            d: 50
        };

        const atrData = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const atr = atrData.at(-1) ?? 0;

        const avgVolume = volumes.reduce((a, b) => a + b, 0) / Math.max(1, volumes.length);
        const volumeSpike = avgVolume > 0 ? volumes[lastIndex] / avgVolume : 1;

        const recentLows = lows.slice(-50);
        const recentHighs = highs.slice(-50);
        const sortedLows = [...recentLows].sort((a, b) => a - b);
        const sortedHighs = [...recentHighs].sort((a, b) => b - a);
        const support = sortedLows[Math.floor(sortedLows.length * 0.2)] ?? (price * 0.97);
        const resistance = sortedHighs[Math.floor(sortedHighs.length * 0.2)] ?? (price * 1.03);
        const vwap = calculateVWAP(highs, lows, closes, volumes, 120);
        const pivotPoints = calculatePivotPoints(highs[lastIndex], lows[lastIndex], closes[lastIndex]);
        const fibonacci = calculateFibonacci(highs, lows, closes, 120);

        const result = {
            coin,
            timeframe,
            limit,
            price,
            change24h: ((closes[lastIndex] - closes[Math.max(0, lastIndex - 24)]) / (closes[Math.max(0, lastIndex - 24)] || closes[lastIndex] || 1) * 100) || 0,
            volume: volumes[lastIndex],
            volumeSpike,
            rsi,
            ema,
            ema200,
            macd: macd.macd || 0,
            macdSignal: macd.signal || 0,
            macdHistogram: macd.histogram || 0,
            macdHistogramPrev: macdData.at(-2)?.histogram ?? 0,
            bb,
            stoch,
            atr,
            support,
            resistance,
            vwap,
            pivotPoints,
            fibonacci,
            candles: candles,
            closes: closes,
            highs: highs,
            lows: lows,
            opens: opens,
            volumes: volumes,
            rsiData: rsiData,
            emaData: emaData,
            ema200Data: ema200Data,
            macdData: macdData,
            bbData: bbData,
            stochData: stochData,
            indicators: {
                ema: emaData,
                ema200: ema200Data,
                rsi: rsiData,
                macd: macdData,
                bb: bbData,
                stoch: stochData,
                atr: atrData,
                vwap,
                pivotPoints,
                fibonacci
            }
        };

        logger.step('MARKET_DATA_COMPLETE', { coin, price: result.price, rsi: result.rsi, vwap: result.vwap });
        return result;
    } catch (error) {
        logger.error('MARKET_DATA', error, { coin, timeframe });
        throw error;
    }
}

module.exports = { getMarketData, TIMEFRAMES: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] };
