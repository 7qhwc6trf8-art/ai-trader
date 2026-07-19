const logger = require('./logger');

class RiskManager {
  constructor(config) {
    const configuredDailyLoss = Number(process.env.DAILY_LOSS_LIMIT_USD);
    const configuredPositions = Number(process.env.MAX_OPEN_POSITIONS || process.env.MAX_POSITIONS);
    const configuredRiskPct = Number(process.env.RISK_PER_TRADE_PCT);
    const configuredConfidence = Number(process.env.MIN_EXECUTION_CONFIDENCE);
    const configuredRiskReward = Number(process.env.MIN_10X_RISK_REWARD);
    const configuredTrades = Number(process.env.MAX_TRADES_PER_DAY);

    // All loss values in this class are USD. A value <= 0 disables the limit.
    this.maxDailyLoss = Number.isFinite(configuredDailyLoss) && configuredDailyLoss >= 0
      ? configuredDailyLoss
      : (Number(config?.maxDailyLoss) || 0);
    this.maxPositions = Number.isInteger(configuredPositions) && configuredPositions > 0
      ? Math.min(20, configuredPositions)
      : (Number(config?.maxPositions) || 3);
    this.riskPerTrade = Number.isFinite(configuredRiskPct)
      ? Math.min(0.05, Math.max(0.001, configuredRiskPct / 100))
      : (Number(config?.riskPerTrade) || 0.008);
    this.minConfidence = Number.isFinite(configuredConfidence)
      ? Math.min(100, Math.max(0, configuredConfidence))
      : (Number(config?.minConfidence) || 88);
    this.minRiskReward = Number.isFinite(configuredRiskReward)
      ? Math.max(0, configuredRiskReward)
      : (Number(config?.minRiskReward) || 2.0);
    this.maxExposure = Number(config?.maxExposure) || 0.30;
    this.maxTradesPerDay = Number.isInteger(configuredTrades) && configuredTrades >= 0
      ? Math.min(100, configuredTrades)
      : (Number(config?.maxTradesPerDay) || 3);
    this.dailyLoss = 0;
    this.positions = [];
    this.tradesToday = 0;
    this.lastResetDate = new Date().toDateString();
  }

  // ✅ NEW: Check daily loss limit
  checkDailyLoss(currentLoss) {
    this.resetDailyIfNeeded();
    
    if (this.maxDailyLoss > 0 && currentLoss >= this.maxDailyLoss) {
      logger.action('RISK_DAILY_LOSS', { 
        dailyLoss: currentLoss, 
        limit: this.maxDailyLoss 
      });
      return { 
        passed: false, 
        reason: `Daily loss limit reached: $${currentLoss.toFixed(2)} / $${this.maxDailyLoss.toFixed(2)}` 
      };
    }
    
    return { passed: true };
  }

  // ✅ NEW: Reset daily counters if new day
  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0;
      this.tradesToday = 0;
      this.lastResetDate = today;
      logger.action('DAILY_RESET', { date: today });
    }
  }

  // ✅ NEW: Validate trade before execution
  validate(signal, portfolio) {
    const checks = [];
    let passed = true;

    // Reset daily if needed
    this.resetDailyIfNeeded();

    // Check confidence
    if (signal.confidence < this.minConfidence) {
      checks.push(`Confidence ${signal.confidence}% < ${this.minConfidence}%`);
      passed = false;
    }

    // Check risk/reward
    if (signal.riskReward < this.minRiskReward) {
      checks.push(`Risk/Reward ${signal.riskReward} < ${this.minRiskReward}`);
      passed = false;
    }

    // Check max positions
    if (this.positions.length >= this.maxPositions) {
      checks.push(`Max positions ${this.maxPositions} reached`);
      passed = false;
    }

    // Check daily loss
    const dailyCheck = this.checkDailyLoss(this.dailyLoss);
    if (!dailyCheck.passed) {
      checks.push(dailyCheck.reason);
      passed = false;
    }

    // Check max trades per day
    if (this.tradesToday >= this.maxTradesPerDay) {
      checks.push(`Max trades per day ${this.maxTradesPerDay} reached`);
      passed = false;
    }

    // Check if already in position
    const existingPosition = portfolio.positions && portfolio.positions.find(p => p.symbol === signal.coin);
    if (existingPosition) {
      checks.push(`Already have ${signal.coin} position`);
      passed = false;
    }

    return { passed, checks };
  }

  calculatePositionSize(balance, entry, stopLoss) {
    const riskAmount = balance * this.riskPerTrade;
    const riskPerUnit = Math.abs(entry - stopLoss);
    if (riskPerUnit === 0) return 0;
    
    let size = riskAmount / riskPerUnit;
    
    // ✅ FIX: Account for fees (0.1%)
    size = size * 0.998;
    
    // ✅ FIX: Reduce size in high volatility (if ATR > 3% of price)
    // This will be set by the caller
    
    return size;
  }

  calculateRiskReward(entry, stopLoss, takeProfit) {
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    return risk > 0 ? reward / risk : 0;
  }

  updateDailyLoss(pnl) {
    if (pnl < 0) {
      this.dailyLoss += Math.abs(pnl);
    }
    this.tradesToday++;
    logger.action('DAILY_UPDATE', { 
      dailyLoss: this.dailyLoss, 
      tradesToday: this.tradesToday 
    });
  }

  resetDaily() {
    this.dailyLoss = 0;
    this.tradesToday = 0;
    this.lastResetDate = new Date().toDateString();
    logger.action('MANUAL_DAILY_RESET', {});
  }

  getStatus() {
    this.resetDailyIfNeeded();
    return {
      dailyLoss: this.dailyLoss,
      maxDailyLoss: this.maxDailyLoss,
      positions: this.positions.length,
      maxPositions: this.maxPositions,
      tradesToday: this.tradesToday,
      maxTradesPerDay: this.maxTradesPerDay,
      minConfidence: this.minConfidence,
      minRiskReward: this.minRiskReward,
      riskPerTrade: this.riskPerTrade * 100 + '%'
    };
  }
}

module.exports = new RiskManager();
