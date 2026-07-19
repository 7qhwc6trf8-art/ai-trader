'use strict';

const crypto = require('crypto');

const TIMEFRAME_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '12h': 720,
  '1d': 1440,
  '1w': 10080
};

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdDev(values, average = mean(values)) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function seededRandom(seedText) {
  const hash = crypto.createHash('sha256').update(String(seedText)).digest();
  let state = hash.readUInt32LE(0) || 0x12345678;
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function normalRandom(random) {
  const u1 = Math.max(1e-12, random());
  const u2 = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Not estimated';
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(minutes < 360 ? 1 : 0)} h`;
  return `${(minutes / 1440).toFixed(minutes < 4320 ? 1 : 0)} d`;
}

class ForecastEngine {
  constructor() {
    const configuredSteps = Number(process.env.FORECAST_STEPS);
    const configuredSimulations = Number(process.env.FORECAST_SIMULATIONS);
    this.steps = Number.isInteger(configuredSteps) ? clamp(configuredSteps, 8, 96) : 24;
    this.simulations = Number.isInteger(configuredSimulations) ? clamp(configuredSimulations, 100, 3000) : 600;
    this.feeRate = clamp(finite(process.env.TRADING_FEE_RATE, 0.001), 0, 0.01);
  }

  timeframeMinutes(timeframe) {
    return TIMEFRAME_MINUTES[String(timeframe || '1h')] || 60;
  }

  extractCloses(data) {
    return (Array.isArray(data?.closes) ? data.closes : [])
      .map(Number)
      .filter(value => Number.isFinite(value) && value > 0);
  }

  extractReturns(closes) {
    const returns = [];
    for (let index = 1; index < closes.length; index++) {
      const previous = closes[index - 1];
      const current = closes[index];
      if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
    }
    return returns;
  }

  calculateDrift(closes, returns) {
    const recentReturns = returns.slice(-48);
    const robustCenter = median(recentReturns);
    const fastWindow = closes.slice(-12);
    const slowWindow = closes.slice(-48);
    const fast = mean(fastWindow);
    const slow = mean(slowWindow);
    const trendComponent = slow > 0 ? Math.log(Math.max(1e-12, fast / slow)) / Math.max(1, fastWindow.length) : 0;
    return clamp((robustCenter * 0.55) + (trendComponent * 0.45), -0.025, 0.025);
  }

  createForecast(data, timeframe = data?.timeframe || '1h', options = {}) {
    const closes = this.extractCloses(data);
    const currentPrice = finite(data?.price, closes.at(-1));
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || closes.length < 20) {
      return {
        available: false,
        disclaimer: 'Forecast unavailable because there is not enough valid candle history.',
        timeframe,
        currentPrice: currentPrice || 0,
        path: []
      };
    }

    const steps = Number.isInteger(options.steps) ? clamp(options.steps, 8, 96) : this.steps;
    const simulations = Number.isInteger(options.simulations)
      ? clamp(options.simulations, 100, 3000)
      : this.simulations;
    const returns = this.extractReturns(closes).slice(-120);
    const drift = this.calculateDrift(closes, returns);
    const rawVolatility = stdDev(returns.slice(-72));
    const atrPct = finite(data?.atr || data?.indicators?.atr, 0) / currentPrice;
    const volatility = clamp(Math.max(rawVolatility, atrPct * 0.45, 0.0005), 0.0005, 0.08);
    const minutesPerStep = this.timeframeMinutes(timeframe);
    const seed = `${data?.coin || ''}:${timeframe}:${currentPrice}:${closes.slice(-8).join(',')}`;
    const random = seededRandom(seed);
    const simulationPaths = [];

    for (let simulation = 0; simulation < simulations; simulation++) {
      let price = currentPrice;
      const path = [];
      for (let step = 1; step <= steps; step++) {
        const damping = Math.exp(-step / Math.max(10, steps));
        const effectiveDrift = drift * damping;
        const shock = normalRandom(random) * volatility;
        price *= Math.exp(effectiveDrift - (volatility ** 2) / 2 + shock);
        price = Math.max(currentPrice * 0.05, price);
        path.push(price);
      }
      simulationPaths.push(path);
    }

    const path = [];
    for (let step = 0; step < steps; step++) {
      const prices = simulationPaths.map(simulation => simulation[step]);
      path.push({
        step: step + 1,
        minutesAhead: (step + 1) * minutesPerStep,
        price: percentile(prices, 0.50),
        lower: percentile(prices, 0.20),
        upper: percentile(prices, 0.80)
      });
    }

    const expectedPrice = path.at(-1)?.price || currentPrice;
    const expectedReturnPct = ((expectedPrice - currentPrice) / currentPrice) * 100;
    const upProbability = simulationPaths.filter(simulation => simulation.at(-1) > currentPrice).length / simulations;
    const direction = upProbability >= 0.56 ? 'BULLISH' : upProbability <= 0.44 ? 'BEARISH' : 'NEUTRAL';
    const confidence = Math.round(clamp(Math.abs(upProbability - 0.5) * 200, 0, 100));

    return {
      available: true,
      timeframe,
      currentPrice,
      minutesPerStep,
      steps,
      horizonMinutes: steps * minutesPerStep,
      horizonLabel: formatDuration(steps * minutesPerStep),
      driftPerCandlePct: (Math.exp(drift) - 1) * 100,
      volatilityPerCandlePct: volatility * 100,
      direction,
      confidence,
      upProbabilityPct: upProbability * 100,
      downProbabilityPct: (1 - upProbability) * 100,
      expectedPrice,
      expectedReturnPct,
      lowerPrice: path.at(-1)?.lower || currentPrice,
      upperPrice: path.at(-1)?.upper || currentPrice,
      path,
      _simulationPaths: simulationPaths,
      disclaimer: 'Statistical scenario only, not a promise. Crypto prices can gap beyond the projected range.'
    };
  }

  evaluateTrade(data, forecast, decision, options = {}) {
    if (!forecast?.available || !decision || !['BUY', 'SELL'].includes(decision.action)) {
      return {
        available: false,
        tpReachProbabilityPct: 0,
        tpEtaLabel: 'Not estimated',
        projectedNetProfit: 0,
        projectedLossAtStop: 0
      };
    }

    const entry = finite(decision.entryPrice, forecast.currentPrice);
    const stopLoss = finite(decision.stopLoss);
    const takeProfit = finite(decision.takeProfit);
    const size = Math.max(0, finite(options.positionSize ?? decision.positionSize));
    const leverage = Math.max(1, finite(options.leverage ?? decision.leverage, 1));
    const isLong = decision.action === 'BUY';
    const simulations = forecast._simulationPaths || [];
    const tpSteps = [];
    const slSteps = [];
    let tpFirst = 0;
    let slFirst = 0;

    for (const path of simulations) {
      let outcome = null;
      for (let index = 0; index < path.length; index++) {
        const price = path[index];
        const hitTp = isLong ? price >= takeProfit : price <= takeProfit;
        const hitSl = isLong ? price <= stopLoss : price >= stopLoss;
        if (hitTp) {
          tpSteps.push(index + 1);
          if (!outcome) {
            tpFirst++;
            outcome = 'TP';
          }
          break;
        }
        if (hitSl) {
          slSteps.push(index + 1);
          if (!outcome) {
            slFirst++;
            outcome = 'SL';
          }
          break;
        }
      }
    }

    const simulationCount = Math.max(1, simulations.length);
    const tpProbability = tpFirst / simulationCount;
    const slProbability = slFirst / simulationCount;
    const medianTpStep = tpSteps.length ? median(tpSteps) : 0;
    const etaMinutes = medianTpStep * forecast.minutesPerStep;
    const notional = entry * size;
    const grossAtTp = Math.abs(takeProfit - entry) * size;
    const grossAtSl = Math.abs(entry - stopLoss) * size;
    const estimatedFees = ((entry + takeProfit) * size) * this.feeRate;
    const estimatedStopFees = ((entry + stopLoss) * size) * this.feeRate;
    const projectedNetProfit = Math.max(0, grossAtTp - estimatedFees);
    const projectedLossAtStop = Math.max(0, grossAtSl + estimatedStopFees);
    const marginUsed = leverage > 0 ? notional / leverage : notional;
    const projectedRoiOnMarginPct = marginUsed > 0 ? (projectedNetProfit / marginUsed) * 100 : 0;
    const stopRoiOnMarginPct = marginUsed > 0 ? (projectedLossAtStop / marginUsed) * 100 : 0;
    const maintenanceMarginRate = clamp(finite(process.env.APPROX_MAINTENANCE_MARGIN_RATE, 0.005), 0, 0.05);
    const liquidationPrice = isLong
      ? entry * (1 - (1 / leverage) + maintenanceMarginRate)
      : entry * (1 + (1 / leverage) - maintenanceMarginRate);

    return {
      available: true,
      tpReachProbabilityPct: tpProbability * 100,
      slReachProbabilityPct: slProbability * 100,
      tpEtaMinutes: etaMinutes,
      tpEtaLabel: etaMinutes > 0 ? formatDuration(etaMinutes) : `Not reached in ${forecast.horizonLabel}`,
      forecastHorizonLabel: forecast.horizonLabel,
      projectedGrossProfit: grossAtTp,
      projectedNetProfit,
      projectedLossAtStop,
      estimatedRoundTripFees: estimatedFees,
      notional,
      marginUsed,
      projectedRoiOnMarginPct,
      stopRoiOnMarginPct,
      approximateLiquidationPrice: liquidationPrice,
      disclaimer: forecast.disclaimer
    };
  }

  publicForecast(forecast) {
    if (!forecast || typeof forecast !== 'object') return forecast;
    const { _simulationPaths, ...safe } = forecast;
    return safe;
  }
}

module.exports = new ForecastEngine();

