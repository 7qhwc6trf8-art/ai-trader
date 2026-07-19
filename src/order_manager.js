const bybit = require('./bybit_client');
const logger = require('./logger');
const db = require('./database');
const crypto = require('crypto');
const { config } = require('./core/config');
const tradeJournal = require('./trade_journal');
const { sameCoin } = require('./symbol_utils');

const DEFAULT_LEVERAGE = Math.min(config.risk.maxLeverage, Math.max(1, parseInt(process.env.DEFAULT_AI_LEVERAGE, 10) || 1));
const parsedOrderTimeout = Number(process.env.ORDER_FILL_TIMEOUT_MS);
const parsedOrderPollInterval = Number(process.env.ORDER_FILL_POLL_MS);

class OrderManager {
  constructor() {
    // Bybit's minimum contract size per symbol (approximate - Bybit enforces
    // its own exchange minimums too; this is a first-pass local guard so we
    // fail fast with a clear message instead of a rejected-order round trip).
    this.minOrderSize = {
      // Major - $5 minimum
      BTC: 0.0001,
      ETH: 0.001,
      BNB: 0.005,
      SOL: 0.01,
      XRP: 1,
      ADA: 1,
      DOGE: 10,
      DOT: 0.1,
      LINK: 0.05,
      AVAX: 0.01,

      // Large Caps - $5 minimum
      MATIC: 1,
      UNI: 0.05,
      ATOM: 0.02,
      LTC: 0.005,
      ETC: 0.01,
      FIL: 0.01,
      APT: 0.01,
      ARB: 1,
      VET: 10,
      ICP: 0.005,

      // Mid Caps - $5 minimum
      ALGO: 1,
      GRT: 1,
      AAVE: 0.01,
      MKR: 0.0005,
      RNDR: 0.01,
      INJ: 0.01,
      OP: 0.1,
      IMX: 0.1,
      STX: 0.1,
      EGLD: 0.001,

      // DeFi & Popular - $5 minimum
      CRV: 1,
      CVX: 0.01,
      SNX: 0.1,
      '1INCH': 0.5,
      SUSHI: 0.1,
      CAKE: 0.01,
      XLM: 1,
      HBAR: 10,
      QNT: 0.001,
      FTM: 0.1,

      default: 0.001
    };
    this.maxSlippage = 0.005;
    // Bybit can acknowledge a market order before it becomes visible through
    // fetchOrder/order history. Ten seconds caused real, already-filled orders
    // to be reported as failures. Keep the values configurable, but use safe
    // production defaults and avoid hammering the private API.
    this.orderTimeout = Number.isFinite(parsedOrderTimeout) && parsedOrderTimeout >= 5000
      ? parsedOrderTimeout
      : 30000;
    this.orderPollInterval = Number.isFinite(parsedOrderPollInterval) && parsedOrderPollInterval >= 500
      ? parsedOrderPollInterval
      : 1000;
    this.leverage = DEFAULT_LEVERAGE;
  }

  isOrderFilled(order) {
    if (!order) return false;

    const status = String(order.status || '').toLowerCase();
    const amount = Number(order.amount);
    const filled = Number(order.filled);
    const remaining = Number(order.remaining);

    if (status === 'closed' || status === 'filled') return true;
    if (!Number.isFinite(filled) || filled <= 0) return false;

    // A positive fill with no remaining quantity is authoritative even when
    // CCXT/Bybit has not populated the final status yet.
    if (Number.isFinite(remaining) && remaining <= Number.EPSILON) return true;
    if (Number.isFinite(amount) && amount > 0) {
      const tolerance = Math.max(amount * 1e-8, Number.EPSILON);
      return filled + tolerance >= amount;
    }

    // Market-order acknowledgements sometimes include filled but omit amount.
    return true;
  }

  positionChanged(before, after) {
    if (!before && !after) return false;
    if (!before && after) return Number(after.size) > 0;
    // getPositions() intentionally returns an empty list on a temporary API
    // error, so a missing `after` value is not strong enough confirmation.
    if (before && !after) return false;

    const beforeSide = String(before.side || '').toLowerCase();
    const afterSide = String(after.side || '').toLowerCase();
    const beforeSize = Number(before.size) || 0;
    const afterSize = Number(after.size) || 0;
    const tolerance = Math.max(Math.abs(beforeSize) * 1e-8, 1e-12);

    return beforeSide !== afterSide || Math.abs(afterSize - beforeSize) > tolerance;
  }

  positionConfirmedOrder(initialOrder, position, requestedSize) {
    const entryPrice = Number(position?.entryPrice);
    const requested = Number(requestedSize);
    const reportedFilled = Number(initialOrder?.filled);

    return {
      ...(initialOrder || {}),
      status: 'closed',
      filled: Number.isFinite(reportedFilled) && reportedFilled > 0
        ? reportedFilled
        : requested,
      remaining: 0,
      average: Number.isFinite(Number(initialOrder?.average)) && Number(initialOrder.average) > 0
        ? Number(initialOrder.average)
        : (Number.isFinite(entryPrice) ? entryPrice : undefined),
      price: Number.isFinite(Number(initialOrder?.price)) && Number(initialOrder.price) > 0
        ? Number(initialOrder.price)
        : (Number.isFinite(entryPrice) ? entryPrice : undefined),
      confirmedBy: 'live-position'
    };
  }

  // Opens a new leveraged futures position. action is 'BUY' (go long) or
  // 'SELL' (go short - this is the whole reason this is futures and not
  // spot: spot can't open a short at all). stopLoss/takeProfit are attached
  // directly to the entry order, so Bybit enforces them exchange-side even
  // if this bot process crashes or loses connectivity.
  buildClientOrderId(coin, action, suppliedId = null) {
    if (suppliedId) return String(suppliedId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
    const base = String(coin || 'COIN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const side = action === 'BUY' ? 'B' : 'S';
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    return `v16-${base}-${side}-${suffix}`.slice(0, 36);
  }

  async ensureProtection(coin, action, stopLoss, takeProfit, positionIdx) {
    let lastError = null;
    for (let attempt = 1; attempt <= config.bybit.protectionRetries; attempt += 1) {
      const setResult = await bybit.setTradingStop(coin, {
        stopLoss,
        takeProfit,
        action,
        positionIdx
      });
      if (!setResult.success) lastError = setResult.error;
      await this.sleep(Math.min(5000, attempt * 750));
      const verification = await bybit.verifyPositionProtection(coin, {
        stopLoss,
        takeProfit,
        action,
        positionIdx
      });
      if (verification.protected) {
        tradeJournal.protection({ coin, action, attempt, protected: true, stopLoss, takeProfit, positionIdx });
        return { success: true, attempt, verification, setResult };
      }
      lastError = verification.error || `Protection verification failed (SL=${verification.actualStopLoss || 0}, TP=${verification.actualTakeProfit || 0})`;
    }
    tradeJournal.protection({ coin, action, protected: false, stopLoss, takeProfit, positionIdx, error: lastError });
    return { success: false, error: lastError || 'Could not attach and verify TP/SL.' };
  }

  // V16 live entry flow: preflight price checks -> idempotent client id -> fill
  // confirmation -> explicit Bybit position TP/SL -> verification. An
  // unprotected position is closed immediately by default.
  async openPosition(coin, action, size, stopLoss, takeProfit, leverage = this.leverage, executionApproval = null) {
    const numericSize = Number(size);
    const numericStopLoss = Number(stopLoss);
    const numericTakeProfit = Number(takeProfit);
    const numericLeverage = Math.min(config.risk.maxLeverage, Math.max(1, Math.floor(Number(leverage) || 1)));
    const approvedLeverage = Math.floor(Number(executionApproval?.aiApprovedLeverage) || 0);

    if (config.app.executionMode !== 'live') {
      return { success: false, error: `Order submission disabled in EXECUTION_MODE=${config.app.executionMode}.` };
    }
    if (executionApproval?.approved !== true || approvedLeverage !== numericLeverage) {
      return { success: false, error: `${numericLeverage}x execution rejected: missing or mismatched V16 approval token` };
    }
    if (!config.risk.allowedLeverages.includes(numericLeverage)) {
      return { success: false, error: `${numericLeverage}x is not an allowed V16 leverage tier` };
    }
    if (!(numericSize > 0 && numericStopLoss > 0 && numericTakeProfit > 0)) {
      return { success: false, error: 'Size, stop-loss and take-profit must all be positive.' };
    }

    const normalizedAction = String(action || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(normalizedAction)) return { success: false, error: `Invalid action: ${action}` };
    const side = normalizedAction === 'BUY' ? 'buy' : 'sell';
    const positionSide = normalizedAction === 'BUY' ? 'long' : 'short';
    const positionIdx = bybit.getPositionIdx(normalizedAction);
    const clientOrderId = this.buildClientOrderId(coin, normalizedAction, executionApproval?.clientOrderId);

    try {
      const ticker = await bybit.getTicker(coin);
      const currentPrice = Number(ticker?.last ?? ticker?.mark);
      const bid = Number(ticker?.bid);
      const ask = Number(ticker?.ask);
      if (!(currentPrice > 0)) return { success: false, error: `Could not load the current ${coin} price` };

      const expectedEntry = Number(executionApproval?.expectedEntryPrice);
      const driftPct = expectedEntry > 0 ? Math.abs(currentPrice - expectedEntry) / expectedEntry * 100 : 0;
      const spreadPct = bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : 0;
      if (driftPct > config.bybit.maxEntryDriftPct) {
        return { success: false, error: `Entry drift ${driftPct.toFixed(3)}% exceeds ${config.bybit.maxEntryDriftPct}%.` };
      }
      if (spreadPct > config.bybit.maxSpreadPct) {
        return { success: false, error: `Spread ${spreadPct.toFixed(3)}% exceeds ${config.bybit.maxSpreadPct}%.` };
      }

      const signalTimestamp = Number(executionApproval?.signalTimestamp || Date.now());
      const signalAgeMs = Math.max(0, Date.now() - signalTimestamp);
      if (signalAgeMs > config.bybit.signalMaxAgeMs) {
        return { success: false, error: `Signal expired before order submission (${Math.round(signalAgeMs / 1000)}s).` };
      }

      const rules = await bybit.getMarketRules(coin, currentPrice);
      if (rules?.error) return { success: false, error: `Could not load Bybit order limits: ${rules.error}` };
      if (rules?.spot === true || String(rules?.marketType || '').toLowerCase() === 'spot') {
        return { success: false, error: 'V16 long/short execution requires BYBIT_MARKET_TYPE=swap.' };
      }
      const exchangeMaxLeverage = Number(rules?.maxLeverage);
      if (exchangeMaxLeverage > 0 && numericLeverage > exchangeMaxLeverage) {
        return { success: false, error: `Bybit maximum for ${coin} is ${exchangeMaxLeverage}x; selected ${numericLeverage}x.` };
      }
      const liveMinimum = Number(rules?.minimumOrderAmount);
      if (liveMinimum > 0 && numericSize + Number.EPSILON < liveMinimum) {
        return { success: false, error: `Bybit minimum amount is ${liveMinimum} ${coin}; calculated ${numericSize}.` };
      }

      const balance = await bybit.getBalance();
      const availableMargin = Number(balance?.tradableUSD ?? balance?.availableUSDT ?? 0);
      const requiredMargin = numericSize * currentPrice / numericLeverage * 1.12;
      if (!(availableMargin >= requiredMargin)) {
        return { success: false, error: `Order needs about $${requiredMargin.toFixed(2)} margin; $${Math.max(0, availableMargin || 0).toFixed(2)} available.` };
      }

      const leverageResult = await bybit.setLeverage(coin, numericLeverage);
      if (!leverageResult.success && !/not modified|same leverage|110043/i.test(leverageResult.error || '')) {
        return { success: false, error: `Could not set ${numericLeverage}x leverage: ${leverageResult.error}` };
      }

      let positionBefore = null;
      try { positionBefore = await this.getPosition(coin); } catch (_) {}

      const orderParams = {
        positionIdx,
        reduceOnly: false,
        clientOrderId,
        stopLoss: { triggerPrice: numericStopLoss },
        takeProfit: { triggerPrice: numericTakeProfit }
      };
      const order = await bybit.placeOrder(coin, side, numericSize, undefined, 'market', orderParams);
      if (!order || order.error) return { success: false, error: order?.error || 'Bybit returned no order' };

      tradeJournal.submitted({
        signalId: executionApproval?.signalId || null,
        tradeId: order.id || clientOrderId,
        orderId: order.id || null,
        clientOrderId,
        coin,
        action: normalizedAction,
        side: positionSide,
        size: numericSize,
        expectedEntryPrice: expectedEntry || currentPrice,
        stopLoss: numericStopLoss,
        takeProfit: numericTakeProfit,
        leverage: numericLeverage,
        riskAmount: Number(executionApproval?.riskAmount) || 0,
        positionIdx
      });

      const filled = this.isOrderFilled(order)
        ? order
        : await this.waitForFill(order.id, coin, { initialOrder: order, positionBefore, requestedSize: numericSize });
      if (!filled) {
        return {
          success: false,
          critical: true,
          uncertain: true,
          orderId: order.id || null,
          clientOrderId,
          error: `Bybit accepted the order but fill was not confirmed within ${Math.round(this.orderTimeout / 1000)}s. V16 will not retry automatically.`
        };
      }

      const livePosition = await this.getPosition(coin);
      const position = {
        coin,
        side,
        leverage: numericLeverage,
        entryPrice: Number(livePosition?.entryPrice || filled.average || filled.price || currentPrice),
        size: Number(livePosition?.size || filled.filled || numericSize),
        stopLoss: numericStopLoss,
        takeProfit: numericTakeProfit,
        positionIdx,
        orderId: filled.id || order.id || null,
        clientOrderId,
        timestamp: new Date().toISOString()
      };

      const protection = await this.ensureProtection(coin, normalizedAction, numericStopLoss, numericTakeProfit, positionIdx);
      if (!protection.success) {
        let emergencyClose = null;
        if (config.bybit.closeUnprotectedPosition) {
          emergencyClose = await bybit.closePosition(coin, position.size, positionSide);
        }
        return {
          success: false,
          critical: true,
          order: filled,
          position,
          protection,
          emergencyClose,
          error: emergencyClose && !emergencyClose.error
            ? `Position opened but protection failed; V16 immediately closed it. ${protection.error}`
            : `CRITICAL: position may be open without verified TP/SL. ${protection.error}`
        };
      }

      if (db.savePosition) db.savePosition({ ...position, openedAt: position.timestamp, status: 'OPEN' });
      return { success: true, order: filled, position, protection, clientOrderId };
    } catch (error) {
      logger.error('Order placement error:', error);
      return { success: false, error: error.message };
    }
  }

  async waitForFill(orderId, coin, options = {}) {
    const startTime = Date.now();
    let lastOrder = options.initialOrder || null;
    let lastPositionCheck = 0;

    while (Date.now() - startTime < this.orderTimeout) {
      try {
        const order = bybit.getOrder
          ? await bybit.getOrder(orderId, coin)
          : (await bybit.getOrders(coin, 10)).find(o => o.id === orderId);
        if (order) {
          lastOrder = { ...(lastOrder || {}), ...order };
        }
        if (this.isOrderFilled(lastOrder)) {
          return lastOrder;
        }
        const status = String(lastOrder?.status || '').toLowerCase();
        if (status === 'canceled' || status === 'cancelled' || status === 'rejected' || status === 'expired') {
          return null;
        }
      } catch (error) {
        // A transient lookup failure is expected immediately after submission.
        // The live-position check below gives us an independent confirmation.
      }

      // Position polling is intentionally less frequent than order polling to
      // reduce private API load. It also confirms fills when order history is
      // delayed, which is common for freshly submitted Bybit market orders.
      if (Date.now() - lastPositionCheck >= 2000) {
        lastPositionCheck = Date.now();
        try {
          const currentPosition = await this.getPosition(coin);
          if (this.positionChanged(options.positionBefore, currentPosition)) {
            logger.action('ORDER_CONFIRMED_BY_POSITION', {
              coin,
              orderId,
              positionSize: currentPosition?.size || 0
            });
            return this.positionConfirmedOrder(
              lastOrder,
              currentPosition,
              options.requestedSize
            );
          }
        } catch (error) {
          // Continue polling the order endpoint until the overall timeout.
        }
      }

      await this.sleep(this.orderPollInterval);
    }

    // One final check prevents a fill that becomes visible on the timeout
    // boundary from being misreported.
    try {
      const finalOrder = bybit.getOrder
        ? await bybit.getOrder(orderId, coin)
        : null;
      if (finalOrder) {
        lastOrder = { ...(lastOrder || {}), ...finalOrder };
      }
      if (this.isOrderFilled(lastOrder)) return lastOrder;
    } catch (error) {
      // The caller will return an explicit uncertain-state message.
    }

    try {
      const finalPosition = await this.getPosition(coin);
      if (this.positionChanged(options.positionBefore, finalPosition)) {
        return this.positionConfirmedOrder(lastOrder, finalPosition, options.requestedSize);
      }
    } catch (error) {
      // The caller will return an explicit uncertain-state message.
    }

    return null;
  }

  // Reconciles local records against the REAL exchange positions - not a
  // local-DB guess. This is the ground truth: if Bybit shows a position
  // closed (its stop-loss/take-profit fired, or it got liquidated), or shows
  // one we didn't know about, this brings the local view back in line.
  async verifyOpenPositions() {
    try {
      const exchangePositions = await bybit.getPositions();
      if (bybit.lastPositionsError) {
        return {
          success: false,
          critical: true,
          error: `Cannot reconcile positions because Bybit state is unavailable: ${bybit.lastPositionsError}`
        };
      }

      const dbPositions = db.getOpenPositions ? await db.getOpenPositions() : [];
      const criticalErrors = [];
      const recovered = [];

      for (const dbPos of dbPositions) {
        const exchangePosition = exchangePositions.find(item => sameCoin(item.coin || item.symbol, dbPos.coin));
        if (!exchangePosition) {
          logger.action('POSITION_SYNC', { coin: dbPos.coin, status: 'CLOSED' });
          if (db.closePosition) db.closePosition(dbPos.coin);
          continue;
        }

        const actualStop = Number(exchangePosition.stopLoss) || 0;
        const actualTarget = Number(exchangePosition.takeProfit) || 0;
        const expectedStop = Number(dbPos.stopLoss) || 0;
        const expectedTarget = Number(dbPos.takeProfit) || 0;
        const stopTolerance = expectedStop > 0 ? Math.max(expectedStop * 0.001, 1e-12) : 0;
        const targetTolerance = expectedTarget > 0 ? Math.max(expectedTarget * 0.001, 1e-12) : 0;
        const stopMismatch = expectedStop > 0 && (!(actualStop > 0) || Math.abs(actualStop - expectedStop) > stopTolerance);
        const targetMismatch = expectedTarget > 0 && (!(actualTarget > 0) || Math.abs(actualTarget - expectedTarget) > targetTolerance);
        if (stopMismatch || targetMismatch || !(actualStop > 0 && actualTarget > 0)) {
          if (expectedStop > 0 && expectedTarget > 0) {
            const action = String(exchangePosition.side).toLowerCase() === 'short' ? 'SELL' : 'BUY';
            const repair = await this.ensureProtection(
              exchangePosition.coin,
              action,
              expectedStop,
              expectedTarget,
              exchangePosition.positionIdx
            );
            if (!repair.success) {
              let emergencyClose = null;
              if (config.bybit.closeUnprotectedPosition) {
                emergencyClose = await bybit.closePosition(exchangePosition.coin, exchangePosition.size, exchangePosition.side);
              }
              criticalErrors.push(
                emergencyClose && !emergencyClose.error
                  ? `${exchangePosition.coin}: protection repair failed; position was closed`
                  : `${exchangePosition.coin}: existing bot position is unprotected (${repair.error})`
              );
            } else {
              recovered.push({ coin: exchangePosition.coin, type: 'PROTECTION_REPAIRED' });
            }
          } else {
            let emergencyClose = null;
            if (config.bybit.closeUnprotectedPosition) {
              emergencyClose = await bybit.closePosition(exchangePosition.coin, exchangePosition.size, exchangePosition.side);
            }
            criticalErrors.push(
              emergencyClose && !emergencyClose.error
                ? `${exchangePosition.coin}: bot position had no TP/SL plan and was closed`
                : `${exchangePosition.coin}: open position has no verifiable TP/SL plan`
            );
          }
        }
      }

      for (const exPos of exchangePositions) {
        const existing = dbPositions.find(item => sameCoin(item.coin, exPos.coin || exPos.symbol));
        if (existing) continue;

        const pending = tradeJournal.findPendingByCoin(exPos.coin || exPos.symbol);
        let stopLoss = Number(exPos.stopLoss) || Number(pending?.stopLoss) || 0;
        let takeProfit = Number(exPos.takeProfit) || Number(pending?.takeProfit) || 0;
        const action = pending?.action || (String(exPos.side).toLowerCase() === 'short' ? 'SELL' : 'BUY');

        if (pending && (!(Number(exPos.stopLoss) > 0) || !(Number(exPos.takeProfit) > 0))) {
          const protection = await this.ensureProtection(
            exPos.coin,
            action,
            stopLoss,
            takeProfit,
            exPos.positionIdx
          );
          if (!protection.success) {
            let emergencyClose = null;
            if (config.bybit.closeUnprotectedPosition) {
              emergencyClose = await bybit.closePosition(exPos.coin, exPos.size, exPos.side);
            }
            criticalErrors.push(
              emergencyClose && !emergencyClose.error
                ? `${exPos.coin}: recovered late fill but protection failed; position was closed`
                : `${exPos.coin}: CRITICAL late fill may be unprotected (${protection.error})`
            );
            continue;
          }
          recovered.push({ coin: exPos.coin, type: 'LATE_FILL_RECOVERED' });
        }

        if (!(stopLoss > 0 && takeProfit > 0)) {
          criticalErrors.push(`${exPos.coin}: unmanaged external position has no verified TP/SL; new entries are blocked`);
        }

        logger.action('POSITION_SYNC', {
          coin: exPos.coin,
          status: pending ? 'RECOVERED_PENDING_ORDER' : 'EXTERNAL_FROM_EXCHANGE'
        });
        if (db.savePosition) {
          db.savePosition({
            coin: exPos.coin,
            side: exPos.side === 'long' ? 'buy' : 'sell',
            entryPrice: exPos.entryPrice || 0,
            size: exPos.size,
            leverage: exPos.leverage,
            stopLoss,
            takeProfit,
            orderId: pending?.orderId || null,
            openedAt: pending?.submittedAt || new Date().toISOString(),
            status: 'OPEN'
          });
        }
        if (pending) {
          tradeJournal.opened({
            signalId: pending.signalId,
            tradeId: pending.tradeId || pending.orderId,
            orderId: pending.orderId,
            clientOrderId: pending.clientOrderId,
            coin: exPos.coin,
            action,
            entryPrice: exPos.entryPrice,
            stopLoss,
            takeProfit,
            riskAmount: pending.riskAmount || 0,
            recovery: true
          });
        }
      }

      // Expire abandoned intents only after enough time has passed for Bybit
      // order/position propagation. They remain in the NDJSON audit trail.
      const now = Date.now();
      for (const [coin, pending] of Object.entries(tradeJournal.listPending())) {
        const hasPosition = exchangePositions.some(item => sameCoin(item.coin || item.symbol, coin));
        const ageMs = now - Date.parse(pending.submittedAt || 0);
        if (!hasPosition && Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000) {
          tradeJournal.clearPending(coin);
        }
      }

      return {
        success: criticalErrors.length === 0,
        critical: criticalErrors.length > 0,
        error: criticalErrors.join(' | ') || null,
        exchangePositions,
        recovered
      };
    } catch (error) {
      logger.error('VERIFY_POSITIONS', error);
      return { success: false, critical: true, error: error.message };
    }
  }

  // Closes a position with reduceOnly, so this can only ever shrink/close it
  // - never accidentally open a new one or flip it to the opposite side.
  async closePosition(coin) {
    try {
      const position = await this.getPosition(coin);

      if (!position) {
        return { success: false, error: 'Position not found on exchange' };
      }

      const order = await bybit.closePosition(coin, position.size, position.side);

      if (order && !order.error) {
        if (db.closePosition) {
          db.closePosition(coin);
        }
        logger.action('POSITION_CLOSED', { coin, price: order.price });
        return { success: true, order };
      }
      return { success: false, error: order?.error };
    } catch (error) {
      logger.error('CLOSE_POSITION', error);
      return { success: false, error: error.message };
    }
  }

  async getPosition(coin) {
    const positions = await bybit.getPositions();
    return positions.find(position => sameCoin(position.coin || position.symbol, coin));
  }

  // Real open positions from the exchange (both `coin` and `symbol` keys are
  // present on each, since different parts of this codebase read either).
  async getOpenPositions() {
    return await bybit.getPositions();
  }

  async getPositionPnL(coin) {
    const position = await this.getPosition(coin);
    if (!position) return null;

    // Bybit already computes unrealized PnL from the live mark price as part
    // of the position record - no need to separately fetch a ticker and
    // re-derive it by hand.
    return {
      coin,
      entryPrice: position.entryPrice,
      currentPrice: position.markPrice,
      size: position.size,
      pnl: position.unrealizedPnl,
      pnlPercent: position.percentage,
      side: position.side,
      liquidationPrice: position.liquidationPrice
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new OrderManager();

