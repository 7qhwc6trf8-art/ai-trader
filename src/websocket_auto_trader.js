const wsManager = require('./websocket_manager');
const orderManager = require('./order_manager');
const riskManager = require('./risk_manager');
const ultimateAI = require('./ultimate_ai_trader');
const logger = require('./logger');
const bybit = require('./bybit_client');
const { getAutoTradeCoins } = require('./coin_universe');

class WebSocketAutoTrader {
  constructor() {
    this.isTrading = false;
    this.lastTradeTime = {};
    this.cooldown = 300000; // 5 minutes cooldown per coin
    this.realTimeData = {
      prices: {},
      tickers: {},
      orderbooks: {},
      candles: {},
      lastUpdate: {}
    };
    this.tradingCoins = getAutoTradeCoins().slice(0, 20);
    this.signals = {};
    this.active = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    
    logger.action('WS_AUTO_TRADER_START', { coins: this.tradingCoins });
    
    // Connect WebSocket
    wsManager.connect();
    
    // Subscribe to all coins
    this.tradingCoins.forEach(coin => {
      this.subscribeCoin(coin);
    });

    // Listen to WebSocket events
    wsManager.on('price_update', this.onPriceUpdate.bind(this));
    wsManager.on('orderbook_update', this.onOrderbookUpdate.bind(this));
    wsManager.on('candle_update', this.onCandleUpdate.bind(this));
    wsManager.on('fast_signal', this.onFastSignal.bind(this));
  }

  stop() {
    this.active = false;
    wsManager.close();
    logger.action('WS_AUTO_TRADER_STOP', {});
  }

  subscribeCoin(coin) {
    // Ticker subscription
    wsManager.subscribeTicker(coin, (ticker) => {
      this.realTimeData.tickers[coin] = ticker;
      this.realTimeData.prices[coin] = ticker.price;
      this.realTimeData.lastUpdate[coin] = Date.now();
      
      // Emit price update event
      wsManager.emit('price_update', { coin, ticker });
    });

    // Orderbook subscription
    wsManager.subscribeOrderbook(coin, (orderbook) => {
      this.realTimeData.orderbooks[coin] = orderbook;
      wsManager.emit('orderbook_update', { coin, orderbook });
    });

    // Kline subscription (1m for fast signals)
    wsManager.subscribeKline(coin, '1m', (candle) => {
      this.realTimeData.candles[coin] = candle;
      wsManager.emit('candle_update', { coin, candle });
    });
  }

  // ==================== EVENT HANDLERS ====================

  async onPriceUpdate(data) {
    const { coin, ticker } = data;
    
    // Check if we should trade this coin
    if (!this.tradingCoins.includes(coin)) return;
    
    // Check cooldown
    const now = Date.now();
    if (this.lastTradeTime[coin] && (now - this.lastTradeTime[coin]) < this.cooldown) {
      return;
    }

    // Check if already in position
    const openPositions = await orderManager.getOpenPositions();
    if (openPositions.find(p => p.coin === coin)) {
      return;
    }

    // Check max positions
    if (openPositions.length >= riskManager.maxPositions) {
      return;
    }

    // Analyze ticker for immediate signal
    const signal = this.analyzeTicker(coin, ticker);
    
    if (signal && signal.action !== 'HOLD' && signal.confidence > 70) {
      await this.executeTrade(coin, signal);
    }
  }

  async onOrderbookUpdate(data) {
    const { coin, orderbook } = data;
    
    if (!this.tradingCoins.includes(coin)) return;
    
    // Check for orderbook imbalance signals
    const imbalance = this.calculateImbalance(orderbook);
    
    if (Math.abs(imbalance) > 0.5) {
      const signal = {
        action: imbalance > 0 ? 'BUY' : 'SELL',
        confidence: 60 + Math.abs(imbalance) * 30,
        entryPrice: this.realTimeData.prices[coin] || 0,
        stopLoss: imbalance > 0 ? this.realTimeData.prices[coin] * 0.99 : this.realTimeData.prices[coin] * 1.01,
        takeProfit: imbalance > 0 ? this.realTimeData.prices[coin] * 1.015 : this.realTimeData.prices[coin] * 0.985,
        reasoning: `Orderbook imbalance: ${imbalance.toFixed(2)}`
      };
      
      wsManager.emit('fast_signal', { coin, signal, source: 'orderbook' });
    }
  }

  async onCandleUpdate(data) {
    const { coin, candle } = data;
    
    if (!this.tradingCoins.includes(coin)) return;
    
    // Check for candle pattern signals
    const signal = this.analyzeCandle(coin, candle);
    
    if (signal && signal.action !== 'HOLD' && signal.confidence > 65) {
      wsManager.emit('fast_signal', { coin, signal, source: 'candle' });
    }
  }

  async onFastSignal(data) {
    const { coin, signal, source } = data;
    
    if (!this.tradingCoins.includes(coin)) return;
    if (this.isTrading) return;
    
    // Check cooldown
    const now = Date.now();
    if (this.lastTradeTime[coin] && (now - this.lastTradeTime[coin]) < this.cooldown) {
      return;
    }

    // Check if already in position
    const openPositions = await orderManager.getOpenPositions();
    if (openPositions.find(p => p.coin === coin)) {
      return;
    }

    // Check max positions
    if (openPositions.length >= riskManager.maxPositions) {
      return;
    }

    // Validate with AI for confirmation
    if (signal.confidence > 80) {
      await this.executeTrade(coin, signal);
    }
  }

  // ==================== ANALYSIS FUNCTIONS ====================

  analyzeTicker(coin, ticker) {
    const price = ticker.price;
    const bid = ticker.bid;
    const ask = ticker.ask;
    const change24h = ticker.change24h;
    const volume = ticker.volume;

    // Get orderbook
    const orderbook = this.realTimeData.orderbooks[coin];
    if (!orderbook) return null;

    // Calculate spread
    const spread = ask && bid ? ((ask - bid) / price) * 100 : 0;
    
    // Calculate imbalance
    const imbalance = this.calculateImbalance(orderbook);

    let action = 'HOLD';
    let confidence = 0;
    let reasoning = '';

    // Strong BUY: High volume + positive imbalance + low spread + positive momentum
    if (volume > 1000000 && imbalance > 0.3 && spread < 0.05 && change24h > 0) {
      action = 'BUY';
      confidence = Math.min(90, 70 + (imbalance * 50) + (1 - spread * 100));
      reasoning = `Strong buy: Volume=${volume}, Imbalance=${imbalance.toFixed(2)}, Spread=${spread.toFixed(2)}%`;
    }
    // Strong SELL: High volume + negative imbalance + low spread + negative momentum
    else if (volume > 1000000 && imbalance < -0.3 && spread < 0.05 && change24h < 0) {
      action = 'SELL';
      confidence = Math.min(90, 70 + (Math.abs(imbalance) * 50) + (1 - spread * 100));
      reasoning = `Strong sell: Volume=${volume}, Imbalance=${imbalance.toFixed(2)}, Spread=${spread.toFixed(2)}%`;
    }
    // Momentum BUY
    else if (change24h > 3 && price > (bid || price) * 1.002) {
      action = 'BUY';
      confidence = 65;
      reasoning = `Momentum buy: Change=${change24h.toFixed(2)}%`;
    }
    // Momentum SELL
    else if (change24h < -3 && price < (ask || price) * 0.998) {
      action = 'SELL';
      confidence = 65;
      reasoning = `Momentum sell: Change=${change24h.toFixed(2)}%`;
    }

    return {
      action,
      confidence: Math.round(confidence),
      entryPrice: price,
      stopLoss: action === 'BUY' ? price * 0.99 : price * 1.01,
      takeProfit: action === 'BUY' ? price * 1.02 : price * 0.98,
      reasoning,
      source: 'ticker'
    };
  }

  analyzeCandle(coin, candle) {
    const open = candle.open;
    const close = candle.close;
    const high = candle.high;
    const low = candle.low;
    const volume = candle.volume;

    const body = Math.abs(close - open);
    const range = high - low;
    const bodyPercent = range > 0 ? body / range : 0;

    let action = 'HOLD';
    let confidence = 0;
    let reasoning = '';

    // Bullish engulfing (candle closes above open with long body)
    if (close > open && bodyPercent > 0.6 && range > open * 0.005) {
      action = 'BUY';
      confidence = 70;
      reasoning = `Bullish candle: Body=${(bodyPercent * 100).toFixed(1)}% of range`;
    }
    // Bearish engulfing
    else if (close < open && bodyPercent > 0.6 && range > open * 0.005) {
      action = 'SELL';
      confidence = 70;
      reasoning = `Bearish candle: Body=${(bodyPercent * 100).toFixed(1)}% of range`;
    }
    // High volume breakout
    else if (volume > 500000 && close > high * 0.99) {
      action = 'BUY';
      confidence = 65;
      reasoning = `High volume breakout: Volume=${volume}`;
    }
    // High volume breakdown
    else if (volume > 500000 && close < low * 1.01) {
      action = 'SELL';
      confidence = 65;
      reasoning = `High volume breakdown: Volume=${volume}`;
    }

    return {
      action,
      confidence: Math.round(confidence),
      entryPrice: close,
      stopLoss: action === 'BUY' ? close * 0.99 : close * 1.01,
      takeProfit: action === 'BUY' ? close * 1.015 : close * 0.985,
      reasoning,
      source: 'candle'
    };
  }

  calculateImbalance(orderbook) {
    if (!orderbook || !orderbook.bids || !orderbook.asks) return 0;
    
    let bidVolume = 0;
    let askVolume = 0;
    
    for (let i = 0; i < Math.min(10, orderbook.bids.length); i++) {
      bidVolume += orderbook.bids[i].size;
    }
    for (let i = 0; i < Math.min(10, orderbook.asks.length); i++) {
      askVolume += orderbook.asks[i].size;
    }
    
    if (bidVolume + askVolume === 0) return 0;
    return (bidVolume - askVolume) / (bidVolume + askVolume);
  }

  // ==================== EXECUTE TRADE ====================

  async executeTrade(coin, signal) {
    // V16.1 deliberately does not execute raw ticker/orderbook/candle signals.
    // Those signals have no final ensemble approval and therefore cannot
    // satisfy the dynamic final-AI leverage token required by OrderManager.
    logger.action('WS_SIGNAL_ANALYSIS_ONLY', {
      coin,
      action: signal?.action,
      confidence: signal?.confidence,
      reason: 'Raw WebSocket signal queued for normal AI scan; direct execution disabled.'
    });
    this.signals[coin] = {
      ...signal,
      receivedAt: new Date().toISOString(),
      executionBlocked: true,
      executionReason: 'Full final-AI review is required before leverage selection.'
    };
    return { success: false, blocked: true, error: 'Full final-AI review is required before leverage selection.' };
  }

  getStatus() {
    return {
      active: this.active,
      isTrading: this.isTrading,
      coins: this.tradingCoins,
      cooldown: this.cooldown,
      lastTradeTime: this.lastTradeTime,
      prices: this.realTimeData.prices,
      signals: this.signals
    };
  }
}

module.exports = new WebSocketAutoTrader();

