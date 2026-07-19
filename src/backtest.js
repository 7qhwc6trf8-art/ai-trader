'use strict';

const { config } = require('./core/config');

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = finite(options.initialBalance ?? process.env.BACKTEST_INITIAL_BALANCE, 10000);
    this.feeRate = finite(options.feeRate ?? process.env.BACKTEST_FEE_RATE, config.costs.takerFeeRate);
    this.slippageRate = finite(options.slippageRate ?? process.env.BACKTEST_SLIPPAGE_RATE, config.costs.estimatedSlippageRate);
    this.fundingRatePer8h = finite(options.fundingRatePer8h ?? process.env.BACKTEST_FUNDING_RATE_8H, config.costs.fundingRate8h);
    this.riskFraction = finite(options.riskFraction, finite(process.env.BACKTEST_RISK_PCT, 0.5) / 100);
    this.maxMarginFraction = finite(options.maxMarginFraction, config.risk.maxMarginPerTradePct / 100);
    this.defaultLeverage = Math.min(config.risk.maxLeverage, Math.max(1, Math.trunc(finite(options.leverage, 3))));
    this.maintenanceMarginRate = finite(options.maintenanceMarginRate, 0.005);
    this.liquidationFeeRate = finite(options.liquidationFeeRate, 0.005);
    this.intrabarPolicy = String(options.intrabarPolicy || 'WORST_CASE').toUpperCase();
    this.minimumWarmup = Math.max(2, Math.trunc(finite(options.minimumWarmup, 200)));
  }

  async run(strategy, candles, runOptions = {}) {
    if (typeof strategy !== 'function') throw new TypeError('Backtest strategy must be a function');
    const bars = this.sanitizeCandles(candles);
    if (bars.length <= this.minimumWarmup + 1) throw new Error(`Backtest needs more than ${this.minimumWarmup + 1} valid candles`);

    let balance = this.initialBalance;
    let peak = balance;
    let maxDrawdown = 0;
    let position = null;
    let pendingSignal = null;
    let timeInMarketMs = 0;
    const trades = [];
    const equityCurve = [];

    for (let i = this.minimumWarmup; i < bars.length; i += 1) {
      const candle = this.asCandle(bars[i]);
      const previousTimestamp = i > 0 ? Number(bars[i - 1][0]) : candle.timestamp;

      if (!position && pendingSignal) {
        const opened = this.open(pendingSignal, candle.open, candle.timestamp, balance);
        if (opened) {
          position = opened;
          balance -= opened.entryFee;
        }
        pendingSignal = null;
      }

      if (position) {
        const exit = this.resolveBarExit(position, candle);
        if (exit) {
          const result = this.close(position, exit.price, exit.reason, candle.timestamp, exit.extraFeeRate || 0);
          balance += result.balanceDelta;
          trades.push(result);
          position = null;
        } else {
          timeInMarketMs += Math.max(0, candle.timestamp - previousTimestamp);
        }
      }

      const floating = position ? this.markToMarket(position, candle.close, candle.timestamp) : 0;
      const equity = balance + floating;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak * 100 : 0);
      equityCurve.push({ timestamp: candle.timestamp, equity, balance, position: position ? position.side : null });

      // No look-ahead: a signal created using candle i can only enter at candle i+1 open.
      if (!position && i < bars.length - 1) {
        const signal = await strategy(bars.slice(0, i + 1), {
          index: i,
          balance,
          equity,
          trades: [...trades]
        });
        if (signal && ['BUY', 'SELL'].includes(String(signal.action || '').toUpperCase())) pendingSignal = { ...signal };
      }
    }

    if (position) {
      const last = this.asCandle(bars[bars.length - 1]);
      const result = this.close(position, last.close, 'END_OF_DATA', last.timestamp);
      balance += result.balanceDelta;
      trades.push(result);
      position = null;
    }

    return this.metrics({ trades, finalBalance: balance, maxDrawdown, equityCurve, bars, timeInMarketMs, runOptions });
  }

  sanitizeCandles(candles) {
    return (Array.isArray(candles) ? candles : [])
      .filter(candle => Array.isArray(candle) && candle.length >= 6)
      .map(candle => candle.slice(0, 6).map(Number))
      .filter(candle => candle.every(Number.isFinite))
      .sort((a, b) => a[0] - b[0]);
  }

  asCandle(candle) {
    return { timestamp: candle[0], open: candle[1], high: candle[2], low: candle[3], close: candle[4], volume: candle[5] };
  }

  open(signal, rawOpen, timestamp, balance) {
    const side = String(signal.action || '').toUpperCase();
    const leverage = Math.min(config.risk.maxLeverage, Math.max(1, Math.trunc(finite(signal.leverage, this.defaultLeverage))));
    if (!config.risk.allowedLeverages.includes(leverage)) return null;
    const entry = rawOpen * (side === 'BUY' ? 1 + this.slippageRate : 1 - this.slippageRate);
    const stop = finite(signal.stopLoss);
    const target = finite(signal.takeProfit);
    if (!(entry > 0 && stop > 0 && target > 0)) return null;
    if (side === 'BUY' && !(stop < entry && target > entry)) return null;
    if (side === 'SELL' && !(stop > entry && target < entry)) return null;

    const stopDistance = Math.abs(entry - stop);
    const riskAmount = Math.max(0, balance) * Math.min(this.riskFraction, config.risk.maxRiskPerTradePct / 100);
    const costPerUnit = entry * (this.feeRate * 2 + this.slippageRate * 2);
    const riskSize = riskAmount / Math.max(stopDistance + costPerUnit, Number.EPSILON);
    const maxNotional = Math.max(0, balance) * this.maxMarginFraction * leverage;
    const size = Math.min(riskSize, maxNotional / entry);
    if (!(size > 0)) return null;

    const notional = entry * size;
    const entryFee = notional * this.feeRate;
    const liquidationPrice = side === 'BUY'
      ? Math.max(0, entry * (1 - 1 / leverage + this.maintenanceMarginRate))
      : entry * (1 + 1 / leverage - this.maintenanceMarginRate);

    return {
      side, entry, stop, target, size, notional, leverage, liquidationPrice,
      entryTime: timestamp, entryFee,
      signalId: signal.signalId || null,
      metadata: signal.metadata || null
    };
  }

  resolveBarExit(position, candle) {
    const isLong = position.side === 'BUY';
    const liquidationHit = isLong ? candle.low <= position.liquidationPrice : candle.high >= position.liquidationPrice;
    const stopHit = isLong ? candle.low <= position.stop : candle.high >= position.stop;
    const targetHit = isLong ? candle.high >= position.target : candle.low <= position.target;

    // Gaps execute at the opening price when it is worse than the trigger.
    if (isLong && candle.open <= position.liquidationPrice) return { price: candle.open, reason: 'LIQUIDATION_GAP', extraFeeRate: this.liquidationFeeRate };
    if (!isLong && candle.open >= position.liquidationPrice) return { price: candle.open, reason: 'LIQUIDATION_GAP', extraFeeRate: this.liquidationFeeRate };
    if (isLong && candle.open <= position.stop) return { price: candle.open, reason: 'STOP_GAP' };
    if (!isLong && candle.open >= position.stop) return { price: candle.open, reason: 'STOP_GAP' };
    if (isLong && candle.open >= position.target) return { price: candle.open, reason: 'TARGET_GAP' };
    if (!isLong && candle.open <= position.target) return { price: candle.open, reason: 'TARGET_GAP' };

    if (liquidationHit) return { price: position.liquidationPrice, reason: 'LIQUIDATION', extraFeeRate: this.liquidationFeeRate };
    if (stopHit && targetHit) {
      return this.intrabarPolicy === 'BEST_CASE'
        ? { price: position.target, reason: 'TAKE_PROFIT' }
        : { price: position.stop, reason: 'STOP_LOSS_AMBIGUOUS' };
    }
    if (stopHit) return { price: position.stop, reason: 'STOP_LOSS' };
    if (targetHit) return { price: position.target, reason: 'TAKE_PROFIT' };
    return null;
  }

  fundingCost(position, timestamp) {
    const periods = Math.max(0, timestamp - position.entryTime) / (8 * 60 * 60 * 1000);
    // Positive funding: longs pay, shorts receive. Pass a negative rate for the opposite regime.
    const direction = position.side === 'BUY' ? 1 : -1;
    return position.notional * this.fundingRatePer8h * periods * direction;
  }

  close(position, rawPrice, reason, timestamp, extraFeeRate = 0) {
    const isForced = String(reason).startsWith('LIQUIDATION');
    const exit = rawPrice * (position.side === 'BUY' ? 1 - this.slippageRate : 1 + this.slippageRate);
    const grossPnl = position.side === 'BUY'
      ? (exit - position.entry) * position.size
      : (position.entry - exit) * position.size;
    const exitFee = exit * position.size * this.feeRate;
    const extraFee = exit * position.size * extraFeeRate;
    const funding = this.fundingCost(position, timestamp);
    const netPnl = grossPnl - position.entryFee - exitFee - extraFee - funding;
    // entryFee was deducted when the trade opened.
    const balanceDelta = grossPnl - exitFee - extraFee - funding;
    return {
      signalId: position.signalId,
      side: position.side,
      leverage: position.leverage,
      entryPrice: position.entry,
      exitPrice: exit,
      liquidationPrice: position.liquidationPrice,
      stopLoss: position.stop,
      takeProfit: position.target,
      size: position.size,
      notional: position.notional,
      grossPnl,
      entryFee: position.entryFee,
      exitFee,
      extraFee,
      fees: position.entryFee + exitFee + extraFee,
      funding,
      netPnl,
      pnl: netPnl,
      balanceDelta,
      entryTime: position.entryTime,
      exitTime: timestamp,
      durationMs: timestamp - position.entryTime,
      exitReason: reason,
      liquidated: isForced,
      metadata: position.metadata
    };
  }

  markToMarket(position, price, timestamp) {
    const gross = position.side === 'BUY' ? (price - position.entry) * position.size : (position.entry - price) * position.size;
    const estimatedExitFee = Math.abs(price * position.size) * this.feeRate;
    return gross - estimatedExitFee - this.fundingCost(position, timestamp);
  }

  metrics({ trades, finalBalance, maxDrawdown, equityCurve, bars, timeInMarketMs }) {
    const wins = trades.filter(trade => trade.netPnl > 0);
    const losses = trades.filter(trade => trade.netPnl < 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
    const netProfit = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
    const daily = this.dailyReturns(equityCurve);
    const dailyStd = std(daily);
    const downside = std(daily.filter(value => value < 0));
    const annualizedReturn = daily.length ? mean(daily) * 365 : 0;
    const sharpe = dailyStd > 0 ? annualizedReturn / (dailyStd * Math.sqrt(365)) : 0;
    const sortino = downside > 0 ? annualizedReturn / (downside * Math.sqrt(365)) : 0;
    const totalReturn = this.initialBalance > 0 ? (finalBalance - this.initialBalance) / this.initialBalance * 100 : 0;
    const periodMs = bars.length > 1 ? bars[bars.length - 1][0] - bars[0][0] : 0;

    let lossStreak = 0;
    let maxLossStreak = 0;
    for (const trade of trades) {
      lossStreak = trade.netPnl < 0 ? lossStreak + 1 : 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }

    return {
      totalTrades: trades.length,
      longTrades: trades.filter(trade => trade.side === 'BUY').length,
      shortTrades: trades.filter(trade => trade.side === 'SELL').length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      liquidations: trades.filter(trade => trade.liquidated).length,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      expectancy: trades.length ? netProfit / trades.length : 0,
      expectancyPctOfStart: trades.length && this.initialBalance > 0 ? netProfit / trades.length / this.initialBalance * 100 : 0,
      avgWin: wins.length ? grossProfit / wins.length : 0,
      avgLoss: losses.length ? grossLoss / losses.length : 0,
      payoffRatio: losses.length && wins.length ? (grossProfit / wins.length) / (grossLoss / losses.length) : 0,
      maxConsecutiveLosses: maxLossStreak,
      maxDrawdown,
      recoveryFactor: maxDrawdown > 0 ? totalReturn / maxDrawdown : 0,
      sharpe,
      sortino,
      totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0),
      totalFunding: trades.reduce((sum, trade) => sum + trade.funding, 0),
      timeInMarketPct: periodMs > 0 ? timeInMarketMs / periodMs * 100 : 0,
      totalReturn,
      finalBalance,
      startBalance: this.initialBalance,
      trades,
      equityCurve,
      dailyReturns: daily
    };
  }

  dailyReturns(equityCurve) {
    const byDay = new Map();
    for (const point of equityCurve) {
      const day = new Date(point.timestamp).toISOString().slice(0, 10);
      byDay.set(day, point.equity);
    }
    const values = [...byDay.values()];
    const returns = [];
    for (let i = 1; i < values.length; i += 1) {
      if (values[i - 1] > 0) returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    return returns;
  }

  monteCarlo(trades, { simulations = 1000, seed = 1337 } = {}) {
    const pnl = (Array.isArray(trades) ? trades : []).map(trade => finite(trade.netPnl ?? trade.pnl)).filter(Number.isFinite);
    if (!pnl.length) return { simulations: 0, endingBalances: [], ruinProbabilityPct: 0 };
    let state = seed >>> 0;
    const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
    const endings = [];
    let ruined = 0;
    for (let simulation = 0; simulation < simulations; simulation += 1) {
      let balance = this.initialBalance;
      for (let index = 0; index < pnl.length; index += 1) {
        balance += pnl[Math.floor(random() * pnl.length)];
        if (balance <= 0) { balance = 0; ruined += 1; break; }
      }
      endings.push(balance);
    }
    endings.sort((a, b) => a - b);
    const percentile = p => endings[Math.min(endings.length - 1, Math.max(0, Math.floor((endings.length - 1) * p)))];
    return {
      simulations,
      ruinProbabilityPct: ruined / simulations * 100,
      endingBalanceP05: percentile(0.05),
      endingBalanceMedian: percentile(0.5),
      endingBalanceP95: percentile(0.95)
    };
  }

  async walkForward(strategyFactory, candles, { trainBars = 1000, testBars = 250, stepBars = testBars } = {}) {
    if (typeof strategyFactory !== 'function') throw new TypeError('strategyFactory must be a function');
    const bars = this.sanitizeCandles(candles);
    const windows = [];
    for (let start = 0; start + trainBars + testBars <= bars.length; start += stepBars) {
      const train = bars.slice(start, start + trainBars);
      const test = bars.slice(start + trainBars - this.minimumWarmup, start + trainBars + testBars);
      const strategy = await strategyFactory(train, { start, trainBars, testBars });
      const result = await this.run(strategy, test, { walkForward: true });
      windows.push({ start, trainStart: train[0][0], testStart: test[this.minimumWarmup][0], testEnd: test[test.length - 1][0], result });
    }
    return {
      windows,
      profitableWindows: windows.filter(window => window.result.totalReturn > 0).length,
      profitableWindowPct: windows.length ? windows.filter(window => window.result.totalReturn > 0).length / windows.length * 100 : 0,
      medianReturnPct: windows.length ? [...windows.map(window => window.result.totalReturn)].sort((a, b) => a - b)[Math.floor(windows.length / 2)] : 0
    };
  }
}

module.exports = BacktestEngine;
