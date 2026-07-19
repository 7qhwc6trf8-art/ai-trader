const WebSocket = require('ws');
const EventEmitter = require('events');
const logger = require('./logger');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.reconnectDelay = 1000;
    this.subscriptions = new Map();
    this.pingInterval = null;
    this.messageQueue = [];
    this.lastMessage = null;
    this.heartbeatInterval = 5000;
    this.realTimeData = {
      prices: {},
      tickers: {},
      orderbooks: {},
      candles: {},
      lastUpdate: {}
    };
    this.lastPrices = {};
  }

  connect() {
    try {
      this.ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
      
      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.action('ðŸ”— WebSocket connected');
        this.emit('connected');
        this.startHeartbeat();
        this.resubscribeAll();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error.message);
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.stopHeartbeat();
        logger.warn('WebSocket disconnected');
        this.emit('disconnected');
        this.reconnect();
      });

    } catch (error) {
      logger.error('WebSocket connection error:', error);
      this.reconnect();
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      this.lastMessage = message;

      // Handle ping/pong
      if (message.type === 'ping') {
        this.sendPong();
        return;
      }

      if (message.type === 'pong') {
        this.emit('pong');
        return;
      }

      // Handle subscription response
      if (message.type === 'response') {
        if (message.success) {
          logger.action(`âœ… Subscribed to: ${message.req_id}`);
        } else {
          logger.error(`âŒ Subscription failed: ${message.ret_msg}`);
        }
        this.emit('subscribed', message);
        return;
      }

      // Handle data messages
      if (message.topic) {
        const callback = this.subscriptions.get(message.topic);
        if (callback) {
          callback(message.data);
        }
        this.emit('data', { topic: message.topic, data: message.data });
      }

    } catch (error) {
      logger.error('WebSocket message parse error:', error);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.sendPing();
      }
    }, this.heartbeatInterval);
  }

  stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  sendPing() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'ping' }));
    }
  }

  sendPong() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'pong' }));
    }
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      this.emit('max_reconnect');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 30000);
    logger.action(`Reconnecting... attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  subscribe(topic, callback) {
    this.subscriptions.set(topic, callback);
    
    if (this.isConnected) {
      this.sendSubscribe(topic);
    } else {
      this.messageQueue.push({ op: 'subscribe', args: [topic] });
    }
  }

  sendSubscribe(topic) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = {
        op: 'subscribe',
        args: [topic],
        req_id: `sub_${Date.now()}`
      };
      this.ws.send(JSON.stringify(message));
      logger.action(`ðŸ“¡ Subscribing to: ${topic}`);
    }
  }

  resubscribeAll() {
    for (const msg of this.messageQueue) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    }
    this.messageQueue = [];

    for (const [topic] of this.subscriptions) {
      this.sendSubscribe(topic);
    }
  }

  unsubscribe(topic) {
    this.subscriptions.delete(topic);
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 'unsubscribe',
        args: [topic]
      }));
    }
  }

  // ==================== PUBLIC SUBSCRIPTION METHODS ====================

  subscribeTicker(symbol, callback) {
    const topic = `tickers.${symbol}USDT`;
    this.subscribe(topic, (data) => {
      if (data && data.length > 0) {
        const t = data[0];
        const tickerData = {
          symbol: t.symbol,
          price: parseFloat(t.lastPrice),
          bid: parseFloat(t.bid1Price),
          ask: parseFloat(t.ask1Price),
          high: parseFloat(t.highPrice24h),
          low: parseFloat(t.lowPrice24h),
          volume: parseFloat(t.volume24h),
          change24h: parseFloat(t.price24hPcnt) * 100,
          openInterest: parseFloat(t.openInterest) || 0,
          turnover: parseFloat(t.turnover24h) || 0,
          timestamp: t.timestamp
        };
        
        // Store real-time data
        this.realTimeData.tickers[symbol] = tickerData;
        this.realTimeData.prices[symbol] = tickerData.price;
        this.realTimeData.lastUpdate[symbol] = Date.now();
        this.lastPrices[symbol] = tickerData.price;
        
        callback(tickerData);
      }
    });
    return topic;
  }

  subscribeKline(symbol, interval, callback) {
    const topic = `kline.${interval}.${symbol}USDT`;
    this.subscribe(topic, (data) => {
      if (data && data.length > 0) {
        const c = data[0];
        const candleData = {
          symbol: symbol,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.volume),
          turnover: parseFloat(c.turnover) || 0,
          timestamp: c.start,
          confirm: c.confirm || false
        };
        
        // Store real-time data
        this.realTimeData.candles[`${symbol}_${interval}`] = candleData;
        
        callback(candleData);
      }
    });
    return topic;
  }

  subscribeOrderbook(symbol, callback) {
    const topic = `orderbook.200.${symbol}USDT`;
    this.subscribe(topic, (data) => {
      if (data) {
        const orderbookData = {
          symbol: symbol,
          bids: data.b ? data.b.map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) })) : [],
          asks: data.a ? data.a.map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) })) : [],
          timestamp: data.t,
          updateId: data.u
        };
        
        this.realTimeData.orderbooks[symbol] = orderbookData;
        callback(orderbookData);
      }
    });
    return topic;
  }

  subscribeTrades(symbol, callback) {
    const topic = `public_trade.${symbol}USDT`;
    this.subscribe(topic, (data) => {
      if (data && data.length > 0) {
        const trades = data.map(t => ({
          price: parseFloat(t.p),
          size: parseFloat(t.v),
          side: t.s,
          timestamp: t.T,
          tradeId: t.i
        }));
        callback(trades);
      }
    });
    return topic;
  }

  // ==================== CONVENIENCE METHODS ====================

  subscribeAll(symbol, callbacks) {
    const topics = [];
    
    if (callbacks.ticker) {
      topics.push(this.subscribeTicker(symbol, callbacks.ticker));
    }
    
    if (callbacks.kline) {
      const interval = callbacks.interval || '1m';
      topics.push(this.subscribeKline(symbol, interval, callbacks.kline));
    }
    
    if (callbacks.orderbook) {
      topics.push(this.subscribeOrderbook(symbol, callbacks.orderbook));
    }
    
    if (callbacks.trades) {
      topics.push(this.subscribeTrades(symbol, callbacks.trades));
    }
    
    return topics;
  }

  // ==================== STATUS ====================

  getStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      subscriptions: Array.from(this.subscriptions.keys()),
      messageQueue: this.messageQueue.length,
      lastMessage: this.lastMessage ? new Date(this.lastMessage.timestamp || Date.now()) : null
    };
  }

  // ==================== CLOSE ====================

  close() {
    this.stopHeartbeat();
    this.subscriptions.clear();
    this.messageQueue = [];
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    logger.action('WebSocket closed');
  }
}

module.exports = new WebSocketManager();
