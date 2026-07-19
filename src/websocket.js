const WebSocket = require('ws');
const EventEmitter = require('events');
const logger = require('./logger');

class BybitWebSocket extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.subscriptions = new Map();
    this.isConnected = false;
  }

  connect() {
    this.ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('error', (error) => this.onError(error));
    this.ws.on('close', () => this.onClose());
  }

  onOpen() {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    logger.action('WebSocket connected');
    this.emit('connected');
    for (const [topic, callback] of this.subscriptions) {
      this.subscribe(topic, callback);
    }
  }

  onMessage(data) {
    try {
      const message = JSON.parse(data);
      if (message.topic) {
        const callback = this.subscriptions.get(message.topic);
        if (callback) callback(message.data);
      }
    } catch (error) {
      logger.error('WebSocket message error:', error);
    }
  }

  onError(error) {
    logger.error('WebSocket error:', error);
    this.emit('error', error);
  }

  onClose() {
    this.isConnected = false;
    logger.warn('WebSocket disconnected');
    this.emit('disconnected');
    this.reconnect();
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), this.reconnectDelay * this.reconnectAttempts);
  }

  subscribe(topic, callback) {
    this.subscriptions.set(topic, callback);
    if (this.isConnected) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
    }
  }

  subscribeTicker(symbol, callback) {
    this.subscribe(`tickers.${symbol}USDT`, (data) => {
      if (data && data.length > 0) {
        const t = data[0];
        callback({
          symbol: t.symbol,
          price: parseFloat(t.lastPrice),
          bid: parseFloat(t.bid1Price),
          ask: parseFloat(t.ask1Price),
          change24h: parseFloat(t.price24hPcnt) * 100,
          volume: parseFloat(t.volume24h)
        });
      }
    });
  }

  subscribeKline(symbol, interval, callback) {
    this.subscribe(`kline.${interval}.${symbol}USDT`, (data) => {
      if (data && data.length > 0) {
        const c = data[0];
        callback({
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.volume),
          timestamp: c.start
        });
      }
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.subscriptions.clear();
  }
}

module.exports = BybitWebSocket;
