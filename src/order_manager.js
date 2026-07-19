const bybit = require('./bybit_client');
const logger = require('./logger');
const db = require('./database');

const DEFAULT_LEVERAGE = Math.min(100, Math.max(1, parseInt(process.env.DEFAULT_AI_LEVERAGE, 10) || 4));
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
  async openPosition(coin, action, size, stopLoss, takeProfit, leverage = this.leverage, executionApproval = null) {
    const numericSize = Number(size);
    const numericStopLoss = Number(stopLoss);
    const numericTakeProfit = Number(takeProfit);
    const numericLeverage = Math.min(100, Math.max(1, Math.floor(Number(leverage) || 1)));

    // Defense in depth: every leveraged order must carry the exact leverage
    // token produced by the final AI decision + hard risk gate. This prevents
    // manual/WebSocket callers from bypassing the dynamic leverage selector.
    const approvedLeverage = Math.floor(Number(executionApproval?.aiApprovedLeverage) || 0);
    if (executionApproval?.approved !== true || approvedLeverage !== numericLeverage) {
      return {
        success: false,
        error: `${numericLeverage}x execution rejected: missing or mismatched final-AI leverage approval token`
      };
    }

    if (!Number.isFinite(numericSize) || numericSize <= 0) {
      return { success: false, error: `Invalid order size: ${size}` };
    }

    const side = action === 'BUY' ? 'buy' : 'sell';

    try {
      const ticker = await bybit.getTicker(coin);
      const currentPrice = Number(ticker?.last ?? ticker?.mark);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return { success: false, error: `Could not load the current ${coin} price` };
      }

      const rules = bybit.getMarketRules
        ? await bybit.getMarketRules(coin, currentPrice)
        : null;
      if (rules?.error) {
        return { success: false, error: `Could not load Bybit's live ${coin} order limits: ${rules.error}` };
      }

      if (rules?.spot === true || String(rules?.marketType || '').toLowerCase() === 'spot') {
        return {
          success: false,
          error: 'Leveraged long/short positions require BYBIT_MARKET_TYPE=swap; spot markets do not support this execution path'
        };
      }

      const exchangeMaxLeverage = Number(rules?.maxLeverage);
      if (Number.isFinite(exchangeMaxLeverage) && exchangeMaxLeverage > 0 && numericLeverage > exchangeMaxLeverage) {
        return {
          success: false,
          error: `Bybit allows at most ${exchangeMaxLeverage}x leverage for ${coin}; AI selected ${numericLeverage}x`
        };
      }

      const liveMinimum = Number(rules?.minimumOrderAmount);
      if (Number.isFinite(liveMinimum) && liveMinimum > 0 && numericSize + Number.EPSILON < liveMinimum) {
        const minimumNotional = liveMinimum * currentPrice;
        const minimumMargin = (minimumNotional / numericLeverage) * 1.1;
        return {
          success: false,
          error: `Bybit requires at least ${liveMinimum} ${coin} (about $${minimumNotional.toFixed(2)} notional / $${minimumMargin.toFixed(2)} margin at ${numericLeverage}x)`
        };
      }

      const balance = await bybit.getBalance();
      const availableMargin = Number(balance?.tradableUSD ?? balance?.availableUSDT ?? 0);
      const requiredMargin = (numericSize * currentPrice / numericLeverage) * 1.1;
      if (!Number.isFinite(availableMargin) || availableMargin < requiredMargin) {
        return {
          success: false,
          error: `Order needs about $${requiredMargin.toFixed(2)} margin at ${numericLeverage}x; only $${Math.max(0, availableMargin || 0).toFixed(2)} is available`
        };
      }

      const leverageResult = await bybit.setLeverage(coin, numericLeverage);
      if (!leverageResult.success) {
        const harmlessAlreadySet = /not modified|same leverage|110043/i.test(leverageResult.error || '');
        if (!harmlessAlreadySet) {
          return { success: false, error: `Could not set ${numericLeverage}x leverage: ${leverageResult.error}` };
        }
      }

      logger.action('LEVERAGE_APPROVAL_AUDIT', {
        coin,
        action,
        leverage: numericLeverage,
        aiApprovedLeverage: approvedLeverage,
        approvalSource: executionApproval?.source || 'not-required',
        approvalReason: executionApproval?.reason || null
      });

      const orderParams = {
        positionIdx: 0,
        reduceOnly: false
      };

      // Snapshot the current exchange position before submitting. If Bybit's
      // order-history endpoint lags, a changed live position is a safe second
      // source of truth that the accepted market order executed.
      let positionBefore = null;
      try {
        positionBefore = await this.getPosition(coin);
      } catch (error) {
        // Order confirmation can still use the normal order endpoint.
      }

      // CCXT's unified attached TP/SL syntax. These are tied to the position
      // opened by the market order and do not pass a null order price.
      if (Number.isFinite(numericStopLoss) && numericStopLoss > 0) {
        orderParams.stopLoss = { triggerPrice: numericStopLoss };
      }
      if (Number.isFinite(numericTakeProfit) && numericTakeProfit > 0) {
        orderParams.takeProfit = { triggerPrice: numericTakeProfit };
      }

      const order = await bybit.placeOrder(
        coin,
        side,
        numericSize,
        undefined,
        'market',
        orderParams
      );

      if (!order || order.error) {
        return { success: false, error: order?.error || 'Bybit returned no order' };
      }

      const filled = this.isOrderFilled(order)
        ? order
        : await this.waitForFill(order.id, coin, {
          initialOrder: order,
          positionBefore,
          requestedSize: numericSize
        });
      if (!filled) {
        const orderLabel = order.id ? ` ${order.id}` : '';
        return {
          success: false,
          uncertain: true,
          orderId: order.id || null,
          error: `Bybit accepted order${orderLabel}, but its fill could not be confirmed within ${Math.round(this.orderTimeout / 1000)}s. Check live Positions before retrying; no second order was submitted.`
        };
      }

      const position = {
        coin,
        side,
        leverage: numericLeverage,
        entryPrice: filled.price || filled.average || 0,
        size: filled.filled || numericSize,
        stopLoss: numericStopLoss,
        takeProfit: numericTakeProfit,
        timestamp: new Date().toISOString()
      };

      if (db.savePosition) {
        db.savePosition({ ...position, openedAt: position.timestamp, status: 'OPEN' });
      }

      return { success: true, order: filled, position };
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
      const dbPositions = db.getOpenPositions ? await db.getOpenPositions() : [];
      const exchangeCoins = exchangePositions.map(p => p.coin);

      for (const dbPos of dbPositions) {
        if (!exchangeCoins.includes(dbPos.coin)) {
          logger.action('POSITION_SYNC', { coin: dbPos.coin, status: 'CLOSED' });
          if (db.closePosition) {
            db.closePosition(dbPos.coin);
          }
        }
      }

      for (const exPos of exchangePositions) {
        if (!dbPositions.find(p => p.coin === exPos.coin)) {
          logger.action('POSITION_SYNC', { coin: exPos.coin, status: 'NEW_FROM_EXCHANGE' });
          if (db.savePosition) {
            db.savePosition({
              coin: exPos.coin,
              side: exPos.side === 'long' ? 'buy' : 'sell',
              entryPrice: exPos.entryPrice || 0,
              size: exPos.size,
              leverage: exPos.leverage,
              stopLoss: 0,
              takeProfit: 0,
              openedAt: new Date().toISOString(),
              status: 'OPEN'
            });
          }
        }
      }

      return { success: true, exchangePositions };
    } catch (error) {
      logger.error('VERIFY_POSITIONS', error);
      return { success: false, error: error.message };
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
    return positions.find(p => p.coin === coin);
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
