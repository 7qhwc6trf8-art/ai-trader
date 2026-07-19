const logger = require('./logger');

class BacktestEngine {
  constructor() {
    this.initialBalance = 10000;
    this.balance = 10000;
    this.fee = 0.001;
    this.slippage = 0.0005;
    this.riskPerTrade = 0.02;
  }

  async run(strategy, candles) {
    logger.action('Starting backtest');
    this.balance = this.initialBalance;
    const trades = [];
    let position = null;
    let entryPrice = 0;
    let entryTime = 0;

    for (let i = 50; i < candles.length; i++) {
      const candle = candles[i];
      const price = candle[4];
      const timestamp = candle[0];

      const signal = strategy(candles.slice(0, i + 1));

      if (signal.action === 'BUY' && !position) {
        const size = this.calculatePositionSize(this.balance, price, signal.stopLoss);
        const executedPrice = price * (1 + this.slippage);
        const fee = executedPrice * size * this.fee;
        entryPrice = executedPrice;
        entryTime = timestamp;
        position = {
          side: 'BUY',
          size: size,
          entryPrice: executedPrice,
          stopLoss: signal.stopLoss || price * 0.97,
          takeProfit: signal.takeProfit || price * 1.05
        };
        this.balance -= (executedPrice * size + fee);
      } else if (signal.action === 'SELL' && position) {
        const executedPrice = price * (1 - this.slippage);
        const fee = executedPrice * position.size * this.fee;
        const pnl = (executedPrice - entryPrice) * position.size;
        this.balance += (executedPrice * position.size - fee);
        trades.push({
          entryPrice: entryPrice,
          exitPrice: executedPrice,
          size: position.size,
          pnl: pnl,
          pnlPercent: (pnl / (entryPrice * position.size)) * 100,
          entryTime: entryTime,
          exitTime: timestamp,
          duration: timestamp - entryTime
        });
        position = null;
      } else if (position) {
        if (price <= position.stopLoss) {
          const executedPrice = position.stopLoss * (1 - this.slippage);
          const fee = executedPrice * position.size * this.fee;
          const pnl = (executedPrice - entryPrice) * position.size;
          this.balance += (executedPrice * position.size - fee);
          trades.push({
            entryPrice: entryPrice,
            exitPrice: executedPrice,
            size: position.size,
            pnl: pnl,
            pnlPercent: (pnl / (entryPrice * position.size)) * 100,
            entryTime: entryTime,
            exitTime: timestamp,
            duration: timestamp - entryTime,
            exitReason: 'STOP_LOSS'
          });
          position = null;
        } else if (price >= position.takeProfit) {
          const executedPrice = position.takeProfit * (1 - this.slippage);
          const fee = executedPrice * position.size * this.fee;
          const pnl = (executedPrice - entryPrice) * position.size;
          this.balance += (executedPrice * position.size - fee);
          trades.push({
            entryPrice: entryPrice,
            exitPrice: executedPrice,
            size: position.size,
            pnl: pnl,
            pnlPercent: (pnl / (entryPrice * position.size)) * 100,
            entryTime: entryTime,
            exitTime: timestamp,
            duration: timestamp - entryTime,
            exitReason: 'TAKE_PROFIT'
          });
          position = null;
        }
      }
    }

    if (position) {
      const price = candles[candles.length - 1][4];
      const executedPrice = price * (1 - this.slippage);
      const fee = executedPrice * position.size * this.fee;
      const pnl = (executedPrice - entryPrice) * position.size;
      this.balance += (executedPrice * position.size - fee);
      trades.push({
        entryPrice: entryPrice,
        exitPrice: executedPrice,
        size: position.size,
        pnl: pnl,
        pnlPercent: (pnl / (entryPrice * position.size)) * 100,
        entryTime: entryTime,
        exitTime: candles[candles.length - 1][0],
        duration: candles[candles.length - 1][0] - entryTime,
        exitReason: 'END'
      });
    }

    return this.calculateMetrics(trades);
  }

  calculatePositionSize(balance, price, stopLoss) {
    const riskAmount = balance * this.riskPerTrade;
    const riskPerUnit = Math.abs(price - stopLoss);
    return riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
  }

  calculateMetrics(trades) {
    const winning = trades.filter(t => t.pnl > 0);
    const losing = trades.filter(t => t.pnl < 0);
    const winRate = trades.length > 0 ? (winning.length / trades.length) * 100 : 0;
    const avgWin = winning.length > 0 ? winning.reduce((s, t) => s + t.pnl, 0) / winning.length : 0;
    const avgLoss = losing.length > 0 ? losing.reduce((s, t) => s + t.pnl, 0) / losing.length : 0;
    const grossProfit = winning.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losing.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winning.length,
      losingTrades: losing.length,
      winRate: winRate,
      profitFactor: profitFactor,
      avgWin: avgWin,
      avgLoss: avgLoss,
      totalReturn: ((this.balance - this.initialBalance) / this.initialBalance) * 100,
      finalBalance: this.balance,
      startBalance: this.initialBalance,
      trades: trades
    };
  }
}

module.exports = BacktestEngine;
