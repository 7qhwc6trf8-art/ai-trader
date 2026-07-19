'use strict';

class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = Number(options.initialBalance ?? process.env.BACKTEST_INITIAL_BALANCE ?? 10000);
    this.feeRate = Number(options.feeRate ?? process.env.BACKTEST_FEE_RATE ?? 0.0006);
    this.slippageRate = Number(options.slippageRate ?? process.env.BACKTEST_SLIPPAGE_RATE ?? 0.0005);
    this.fundingRatePer8h = Number(options.fundingRatePer8h ?? process.env.BACKTEST_FUNDING_RATE_8H ?? 0.0001);
    this.riskFraction = Number(options.riskFraction ?? (Number(process.env.BACKTEST_RISK_PCT ?? 0.5) / 100));
    this.maxMarginFraction = Number(options.maxMarginFraction ?? 0.08);
    this.leverage = Math.max(1, Number(options.leverage ?? 3));
    this.warmupCandles = Math.max(1, Number(options.warmupCandles ?? 200));
    this.intrabarPolicy = String(options.intrabarPolicy || 'WORST_CASE').toUpperCase();
  }

  async run(strategy, candles) {
    if (!Array.isArray(candles) || candles.length <= this.warmupCandles) {
      return this.metrics([], this.initialBalance, 0, []);
    }

    let balance = this.initialBalance;
    let peak = balance;
    let maxDrawdown = 0;
    let position = null;
    let pendingSignal = null;
    const trades = [];
    const equityCurve = [];

    for (let i = this.warmupCandles; i < candles.length; i++) {
      const [timestamp, open, high, low, close] = candles[i].map(Number);
      const candle = { timestamp, open, high, low, close };

      // A signal is generated only after the previous candle closes and is
      // executed at the next candle's open. This removes same-candle look-ahead.
      if (!position && pendingSignal) {
        position = this.open(pendingSignal, open, timestamp, balance);
        pendingSignal = null;
      }

      if (position) {
        const exit = this.resolveIntrabarExit(position, candle);
        if (exit) {
          const result = this.close(position, exit.price, exit.reason, timestamp);
          balance += result.netPnl;
          trades.push(result);
          position = null;
        }
      }

      const floating = position ? this.unrealizedNet(position, close, timestamp) : 0;
      const equity = balance + floating;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak * 100 : 0);
      equityCurve.push({ timestamp, equity });

      if (!position && !pendingSignal && i < candles.length - 1) {
        const signal = await strategy(candles.slice(0, i + 1));
        if (signal && ['BUY', 'SELL'].includes(String(signal.action).toUpperCase())) {
          pendingSignal = signal;
        }
      }
    }

    if (position) {
      const last = candles[candles.length - 1];
      const result = this.close(position, Number(last[4]), 'END', Number(last[0]));
      balance += result.netPnl;
      trades.push(result);
    }

    return this.metrics(trades, balance, maxDrawdown, equityCurve);
  }

  open(signal, marketPrice, timestamp, balance) {
    const side = String(signal.action).toUpperCase();
    const entry = marketPrice * (side === 'BUY' ? 1 + this.slippageRate : 1 - this.slippageRate);
    const stop = Number(signal.stopLoss);
    const target = Number(signal.takeProfit);
    const stopDistance = Math.abs(entry - stop);
    if (!(entry > 0 && stop > 0 && target > 0 && stopDistance > 0)) return null;
    if (side === 'BUY' && !(stop < entry && target > entry)) return null;
    if (side === 'SELL' && !(stop > entry && target < entry)) return null;

    const riskAmount = Math.max(0, balance) * Math.max(0, this.riskFraction);
    const riskSize = riskAmount / stopDistance;
    const maxNotional = Math.max(0, balance) * Math.max(0, this.maxMarginFraction) * this.leverage;
    const size = Math.min(riskSize, maxNotional / entry);
    if (!(size > 0)) return null;

    const entryFee = entry * size * this.feeRate;
    return { side, entry, stop, target, size, entryTime: timestamp, entryFee, leverage: this.leverage };
  }

  resolveIntrabarExit(position, candle) {
    // Gaps are filled at the candle open, not magically at the stop/target.
    if (position.side === 'BUY') {
      if (candle.open <= position.stop) return { price: candle.open, reason: 'STOP_GAP' };
      if (candle.open >= position.target) return { price: candle.open, reason: 'TAKE_PROFIT_GAP' };
    } else {
      if (candle.open >= position.stop) return { price: candle.open, reason: 'STOP_GAP' };
      if (candle.open <= position.target) return { price: candle.open, reason: 'TAKE_PROFIT_GAP' };
    }

    const stopHit = position.side === 'BUY'
      ? candle.low <= position.stop
      : candle.high >= position.stop;
    const tpHit = position.side === 'BUY'
      ? candle.high >= position.target
      : candle.low <= position.target;

    if (stopHit && tpHit) {
      return this.intrabarPolicy === 'BEST_CASE'
        ? { price: position.target, reason: 'TAKE_PROFIT' }
        : { price: position.stop, reason: 'STOP_LOSS' };
    }
    if (stopHit) return { price: position.stop, reason: 'STOP_LOSS' };
    if (tpHit) return { price: position.target, reason: 'TAKE_PROFIT' };
    return null;
  }

  accruedFunding(position, timestamp) {
    const hours = Math.max(0, timestamp - position.entryTime) / 3600000;
    // Without historical symbol funding data, charge the configured rate as a
    // conservative cost for both directions instead of assuming free funding.
    return position.entry * position.size * this.fundingRatePer8h * (hours / 8);
  }

  close(position, rawPrice, reason, timestamp) {
    const exit = rawPrice * (position.side === 'BUY' ? 1 - this.slippageRate : 1 + this.slippageRate);
    const gross = position.side === 'BUY'
      ? (exit - position.entry) * position.size
      : (position.entry - exit) * position.size;
    const exitFee = exit * position.size * this.feeRate;
    const funding = this.accruedFunding(position, timestamp);
    const netPnl = gross - position.entryFee - exitFee - funding;
    return {
      side: position.side,
      entryPrice: position.entry,
      exitPrice: exit,
      stopLoss: position.stop,
      takeProfit: position.target,
      size: position.size,
      grossPnl: gross,
      fees: position.entryFee + exitFee,
      funding,
      netPnl,
      pnl: netPnl,
      entryTime: position.entryTime,
      exitTime: timestamp,
      durationMs: timestamp - position.entryTime,
      exitReason: reason
    };
  }

  unrealized(position, price) {
    return position.side === 'BUY'
      ? (price - position.entry) * position.size
      : (position.entry - price) * position.size;
  }

  unrealizedNet(position, price, timestamp) {
    return this.unrealized(position, price) - position.entryFee - this.accruedFunding(position, timestamp);
  }

  metrics(trades, finalBalance, maxDrawdown, equityCurve) {
    const wins = trades.filter(trade => trade.netPnl > 0);
    const losses = trades.filter(trade => trade.netPnl < 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const expectancy = trades.length
      ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length
      : 0;

    return {
      totalTrades: trades.length,
      longTrades: trades.filter(trade => trade.side === 'BUY').length,
      shortTrades: trades.filter(trade => trade.side === 'SELL').length,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancy,
      avgWin,
      avgLoss,
      maxDrawdown,
      totalReturn: (finalBalance - this.initialBalance) / this.initialBalance * 100,
      finalBalance,
      startBalance: this.initialBalance,
      trades,
      equityCurve
    };
  }
}

module.exports = BacktestEngine;
