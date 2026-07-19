const ccxt = require("ccxt");
const logger = require('./logger');
const { deduplicateOrders } = require('./order_utils');

class BybitClient {
  constructor() {
    this.exchange = null;
    this.isConnected = false;
    this.mode = 'ro';
    this.balance = {};
    this.portfolio = {};
    this.orders = [];
    this.apiKey = null;
    this.apiSecret = null;
    this.connectionError = null;
    this.lastBalanceFetch = null;
    this.cachedBalance = null;
    this.connectionPromise = null;
    this.marketType = 'swap';
  }

  connect(apiKey, apiSecret, mode = 'ro') {
    try {
      this.apiKey = apiKey;
      this.apiSecret = apiSecret;
      this.mode = mode;
      
      console.log(`🔌 Connecting to Bybit in ${mode.toUpperCase()} mode...`);
      console.log(`📝 API Key: ${apiKey ? apiKey.substring(0, 8) + '...' : 'MISSING'}`);
      
      const requestedMarketType = String(process.env.BYBIT_MARKET_TYPE || 'swap').toLowerCase();
      this.marketType = ['swap', 'spot'].includes(requestedMarketType)
        ? requestedMarketType
        : 'swap';

      this.exchange = new ccxt.bybit({
        apiKey: apiKey,
        secret: apiSecret,
        enableRateLimit: true,
        options: { 
          defaultType: this.marketType,
          defaultSubType: this.marketType === 'swap' ? 'linear' : undefined,
          defaultSettle: this.marketType === 'swap' ? 'USDT' : undefined,
          recvWindow: 5000 
        }
      });
      
      // Keep connect() compatible with the existing synchronous startup code,
      // but retain the promise so every balance/order call can await the real
      // authentication result before using the exchange.
      this.connectionPromise = this.testConnection();
      return true;
    } catch (error) {
      this.connectionError = error.message;
      logger.error('Bybit connection failed:', error.message);
      console.error('❌ Bybit connection failed:', error.message);
      console.error('   Please check your API keys and permissions.');
      return false;
    }
  }

  async testConnection() {
    try {
      console.log('🔍 Testing Bybit connection...');
      await this.exchange.loadMarkets();
      const balance = await this.exchange.fetchBalance({ type: this.marketType });
      const usdtBalance = this.toFiniteNumber(balance?.total?.USDT);
      console.log('✅ Bybit connection successful!');
      console.log(`💰 Unified/Trading USDT wallet balance: ${usdtBalance}`);
      this.isConnected = true;
      this.connectionError = null;

      return true;
    } catch (error) {
      console.error('❌ Connection test failed:', error.message);
      console.error('   Make sure your API keys are correct and have proper permissions');
      this.isConnected = false;
      this.connectionError = error.message;
      return false;
    }
  }

  async waitForConnection() {
    if (this.connectionPromise) {
      const pending = this.connectionPromise;
      await pending;
      if (this.connectionPromise === pending) {
        this.connectionPromise = null;
      }
    }
    return this.isConnected;
  }

  async getConnectionHealth(probe = true) {
    const startedAt = Date.now();
    const configured = Boolean(this.exchange && this.apiKey && this.apiSecret);
    if (!configured) {
      return {
        configured: false,
        connected: false,
        mode: this.mode,
        marketType: this.marketType,
        error: 'Bybit API key/secret is missing',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
    }

    if (this.connectionPromise) {
      await this.waitForConnection();
    } else if (probe) {
      await this.testConnection();
    }

    return {
      configured: true,
      connected: this.isConnected,
      mode: this.mode,
      marketType: this.marketType,
      error: this.connectionError,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    };
  }

  toFiniteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  unavailableBalance(error) {
    return {
      totalUSD: 0,
      tradableUSD: 0,
      availableUSDT: 0,
      walletUSDT: 0,
      fundingUSDT: 0,
      assets: [],
      mode: this.mode,
      isMock: false,
      unavailable: true,
      error: error || this.connectionError || 'Bybit balance is unavailable'
    };
  }

  async buildBalanceSnapshot(tradingBalance, fundingBalance = null, fundingError = null) {
    const total = tradingBalance?.total || {};
    const free = tradingBalance?.free || {};
    const used = tradingBalance?.used || {};
    const account = tradingBalance?.info?.result?.list?.[0] || null;

    const walletUSDT = this.toFiniteNumber(total.USDT);
    const freeUSDT = this.toFiniteNumber(free.USDT);
    const accountEquity = this.toFiniteNumber(account?.totalEquity, NaN);
    const accountAvailable = this.toFiniteNumber(account?.totalAvailableBalance, NaN);
    const fundingUSDT = this.toFiniteNumber(fundingBalance?.total?.USDT);

    const assets = Object.keys(total)
      .filter(key => this.toFiniteNumber(total[key]) > 0.000001)
      .map(key => ({
        asset: key,
        free: this.toFiniteNumber(free[key]),
        used: this.toFiniteNumber(used[key]),
        total: this.toFiniteNumber(total[key]),
        usdValue: ['USDT', 'USDC'].includes(key) ? this.toFiniteNumber(total[key]) : 0
      }));

    let calculatedUSD = assets.reduce((sum, asset) => sum + asset.usdValue, 0);
    for (const asset of assets) {
      if (asset.asset === 'USDT' || asset.asset === 'USDC') continue;
      try {
        const ticker = await this.exchange.fetchTicker(this.normalizeSymbol(asset.asset));
        const last = this.toFiniteNumber(ticker?.last);
        if (last > 0) {
          asset.usdValue = asset.total * last;
          calculatedUSD += asset.usdValue;
        }
      } catch (error) {
        // Some collateral assets have no direct USDT market. Bybit's
        // account-level totalEquity still values them when it is available.
      }
    }

    // For Unified accounts, totalAvailableBalance is the account-level amount
    // available to open new positions. Coin walletBalance/totalEquity are not
    // interchangeable with available margin.
    const totalUSD = Number.isFinite(accountEquity) ? accountEquity : calculatedUSD;
    const tradableUSD = Number.isFinite(accountAvailable)
      ? accountAvailable
      : freeUSDT;

    return {
      totalUSD,
      tradableUSD,
      availableUSDT: tradableUSD,
      walletUSDT,
      fundingUSDT,
      accountType: account?.accountType || (this.marketType === 'swap' ? 'UNIFIED/CONTRACT' : 'SPOT'),
      assets,
      raw: {
        trading: tradingBalance,
        funding: fundingBalance
      },
      fundingError: fundingError || null,
      mode: this.mode,
      isMock: false,
      unavailable: false
    };
  }

  normalizeSymbol(symbol) {
    if (typeof symbol !== 'string' || !symbol.trim()) {
      throw new Error('A valid Bybit symbol is required');
    }

    const raw = symbol.trim().toUpperCase();
    if (raw.includes(':')) return raw;

    let base;
    if (raw.includes('/')) {
      base = raw.split('/')[0];
    } else {
      base = raw.endsWith('USDT') ? raw.slice(0, -4) : raw;
    }

    if (!base) {
      throw new Error(`Invalid Bybit symbol: ${symbol}`);
    }

    return this.marketType === 'swap'
      ? `${base}/USDT:USDT`
      : `${base}/USDT`;
  }

  firstPositiveNumber(...values) {
    for (const value of values) {
      const numeric = this.toFiniteNumber(value, NaN);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return 0;
  }

  ceilToStep(value, step) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isFinite(step) || step <= 0) return value;
    return Math.ceil((value / step) - 1e-12) * step;
  }

  async getMarketRules(symbol, referencePrice = null) {
    if (!this.exchange) {
      return { error: 'Not connected to Bybit' };
    }

    try {
      await this.exchange.loadMarkets();
      const marketSymbol = this.normalizeSymbol(symbol);
      const market = typeof this.exchange.market === 'function'
        ? this.exchange.market(marketSymbol)
        : this.exchange.markets?.[marketSymbol];

      if (!market) {
        return { error: `Bybit market not found: ${marketSymbol}` };
      }

      const lot = market.info?.lotSizeFilter || {};
      const leverageFilter = market.info?.leverageFilter || {};
      const amountStep = this.firstPositiveNumber(lot.qtyStep, market.precision?.amount);
      const exchangeMinAmount = this.firstPositiveNumber(
        lot.minOrderQty,
        market.limits?.amount?.min
      );
      const minCost = this.firstPositiveNumber(
        lot.minNotionalValue,
        market.limits?.cost?.min
      );
      const numericPrice = this.toFiniteNumber(referencePrice);
      const costBasedAmount = numericPrice > 0 && minCost > 0
        ? minCost / numericPrice
        : 0;
      const minimumRaw = Math.max(exchangeMinAmount, amountStep, costBasedAmount);
      const minimumOrderAmount = this.ceilToStep(minimumRaw, amountStep);

      return {
        symbol: marketSymbol,
        amountStep,
        minAmount: exchangeMinAmount,
        minCost,
        minimumOrderAmount,
        maxMarketAmount: this.firstPositiveNumber(
          lot.maxMktOrderQty,
          market.limits?.amount?.max
        ),
        maxLeverage: market.spot === true
          ? 1
          : this.firstPositiveNumber(
            leverageFilter.maxLeverage,
            market.limits?.leverage?.max,
            process.env.BYBIT_FALLBACK_MAX_LEVERAGE || 10
          ),
        minLeverage: this.firstPositiveNumber(
          leverageFilter.minLeverage,
          market.limits?.leverage?.min,
          1
        ),
        leverageStep: this.firstPositiveNumber(leverageFilter.leverageStep, 1),
        referencePrice: numericPrice,
        active: market.active !== false,
        spot: market.spot === true,
        swap: market.swap === true,
        linear: market.linear === true,
        marketType: market.spot === true ? 'spot' : (market.swap === true ? 'swap' : market.type || this.marketType),
        raw: market
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async getBalance() {
    if (this.cachedBalance && this.lastBalanceFetch && (Date.now() - this.lastBalanceFetch) < 5000) {
      return this.cachedBalance;
    }

    if (!this.exchange || !this.apiKey || !this.apiSecret) {
      console.log('⚠️ Bybit API keys are missing - live balance unavailable');
      return this.unavailableBalance('The configured Bybit API key/secret is missing');
    }

    if (this.connectionPromise) {
      await this.connectionPromise;
      this.connectionPromise = null;
    }

    if (!this.isConnected) {
      return this.unavailableBalance(this.connectionError || 'Bybit authentication failed');
    }

    try {
      console.log('🔍 Fetching Unified/Trading and Funding balances from Bybit...');
      const tradingBalance = await this.exchange.fetchBalance({ type: this.marketType });
      let fundingBalance = null;
      let fundingError = null;

      try {
        // Bybit's Funding wallet is a separate endpoint and may require the
        // API key's Transfer permission. A failure here must not hide a valid
        // Unified/Trading balance.
        fundingBalance = await this.exchange.fetchBalance({ type: 'funding' });
      } catch (error) {
        fundingError = error.message;
        logger.action('FUNDING_BALANCE_UNAVAILABLE', { error: fundingError });
      }

      this.cachedBalance = await this.buildBalanceSnapshot(
        tradingBalance,
        fundingBalance,
        fundingError
      );
      
      this.lastBalanceFetch = Date.now();
      
      logger.balance(this.cachedBalance, this.mode);
      console.log(
        `✅ Unified equity: $${this.cachedBalance.totalUSD.toFixed(2)} | ` +
        `Tradable: $${this.cachedBalance.tradableUSD.toFixed(2)} | ` +
        `Funding USDT: $${this.cachedBalance.fundingUSDT.toFixed(2)}`
      );
      return this.cachedBalance;
      
    } catch (error) {
      logger.error('Balance fetch error:', error);
      console.error('❌ Balance fetch error:', error.message);
      
      // A real-money bot must fail closed. Never place an order using a stale
      // or fabricated balance after a live balance request fails.
      if (this.mode !== 'rw' && this.cachedBalance) {
        console.log('⚠️ Using cached balance');
        return { ...this.cachedBalance, stale: true, error: error.message };
      }

      return this.unavailableBalance(error.message);
    }
  }

  async getPortfolio() {
    await this.waitForConnection();
    if (!this.isConnected) {
      return { totalValue: 0, availableToTrade: 0, positions: [], mode: this.mode, error: this.connectionError };
    }
    
    try {
      const balance = await this.getBalance();

      if (this.marketType === 'swap') {
        const positions = (await this.getPositions()).filter(position => this.toFiniteNumber(position.size) > 0);
        return {
          totalValue: balance.totalUSD,
          availableToTrade: balance.tradableUSD,
          positions,
          mode: this.mode
        };
      }

      const positions = [];
      
      for (const asset of balance.assets) {
        if (asset.asset === 'USDT' || asset.asset === 'USDC') continue;
        try {
          const ticker = await this.exchange.fetchTicker(this.normalizeSymbol(asset.asset));
          if (ticker && ticker.last) {
            positions.push({
              symbol: asset.asset,
              amount: asset.total,
              price: ticker.last,
              value: asset.total * ticker.last,
              change24h: ticker.percentage || 0
            });
          }
        } catch (e) {
          // Skip if no pair
        }
      }
      
      return { 
        totalValue: balance.totalUSD, 
        positions: positions.sort((a, b) => b.value - a.value), 
        mode: this.mode 
      };
    } catch (error) {
      logger.error('Portfolio fetch error:', error);
      return { totalValue: 0, positions: [], mode: this.mode };
    }
  }

  getTimeZoneDateParts(timestamp = Date.now(), timeZone = 'UTC') {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, Number(part.value)])
    );
    return parts;
  }

  getTimeZoneOffsetMs(timestamp, timeZone) {
    const parts = this.getTimeZoneDateParts(timestamp, timeZone);
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    return representedAsUtc - Math.floor(timestamp / 1000) * 1000;
  }

  zonedMidnightToUtcMs(year, month, day, timeZone) {
    const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    let result = utcGuess - this.getTimeZoneOffsetMs(utcGuess, timeZone);
    // Recalculate once at the resolved instant to handle offset transitions.
    result = utcGuess - this.getTimeZoneOffsetMs(result, timeZone);
    return result;
  }

  getTradingDayBounds(timeZone = 'UTC', now = Date.now()) {
    let safeTimeZone = String(timeZone || 'UTC');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone }).format(new Date(now));
    } catch (error) {
      safeTimeZone = 'UTC';
    }

    const current = this.getTimeZoneDateParts(now, safeTimeZone);
    const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    const startTime = this.zonedMidnightToUtcMs(
      current.year,
      current.month,
      current.day,
      safeTimeZone
    );
    const endExclusive = this.zonedMidnightToUtcMs(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      safeTimeZone
    );

    return {
      timeZone: safeTimeZone,
      dayKey: `${current.year}-${String(current.month).padStart(2, '0')}-${String(current.day).padStart(2, '0')}`,
      startTime,
      endTime: Math.min(now, endExclusive - 1),
      endExclusive
    };
  }

  async getClosedPnl({ startTime, endTime, limit = 100 } = {}) {
    await this.waitForConnection();
    if (!this.isConnected) {
      return {
        available: false,
        netPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        recordCount: 0,
        records: [],
        error: this.connectionError || 'Not connected to Bybit'
      };
    }

    if (this.marketType !== 'swap') {
      return {
        available: false,
        netPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        recordCount: 0,
        records: [],
        error: 'Closed PnL tracking requires BYBIT_MARKET_TYPE=swap'
      };
    }

    const method = this.exchange?.privateGetV5PositionClosedPnl;
    if (typeof method !== 'function') {
      return {
        available: false,
        netPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        recordCount: 0,
        records: [],
        error: 'The installed CCXT Bybit adapter does not expose the V5 closed-PnL endpoint'
      };
    }

    try {
      const records = [];
      const seen = new Set();
      let cursor;
      let page = 0;
      const pageLimit = Math.min(100, Math.max(1, Number(limit) || 100));

      do {
        const params = {
          category: 'linear',
          startTime: Math.floor(Number(startTime)),
          endTime: Math.floor(Number(endTime)),
          limit: pageLimit
        };
        if (cursor) params.cursor = cursor;

        const response = await method.call(this.exchange, params);
        const list = Array.isArray(response?.result?.list) ? response.result.list : [];

        for (const item of list) {
          const key = `${item.orderId || ''}:${item.updatedTime || item.createdTime || ''}:${item.closedPnl || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push({
            symbol: item.symbol || '',
            orderId: item.orderId || '',
            side: item.side || '',
            leverage: this.toFiniteNumber(item.leverage, 1),
            qty: this.toFiniteNumber(item.qty ?? item.closedSize),
            entryPrice: this.toFiniteNumber(item.avgEntryPrice),
            exitPrice: this.toFiniteNumber(item.avgExitPrice),
            closedPnl: this.toFiniteNumber(item.closedPnl),
            openFee: this.toFiniteNumber(item.openFee),
            closeFee: this.toFiniteNumber(item.closeFee),
            createdTime: this.toFiniteNumber(item.createdTime),
            updatedTime: this.toFiniteNumber(item.updatedTime)
          });
        }

        cursor = response?.result?.nextPageCursor || '';
        page += 1;
      } while (cursor && page < 20);

      const netPnl = records.reduce((sum, record) => sum + record.closedPnl, 0);
      const grossProfit = records.reduce(
        (sum, record) => sum + Math.max(0, record.closedPnl),
        0
      );
      const grossLoss = records.reduce(
        (sum, record) => sum + Math.abs(Math.min(0, record.closedPnl)),
        0
      );

      return {
        available: true,
        netPnl,
        grossProfit,
        grossLoss,
        recordCount: records.length,
        records,
        error: null
      };
    } catch (error) {
      logger.error('BYBIT_CLOSED_PNL', error, { startTime, endTime });
      return {
        available: false,
        netPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        recordCount: 0,
        records: [],
        error: error.message
      };
    }
  }

  async getDailyClosedPnl(timeZone = 'UTC', now = Date.now()) {
    const bounds = this.getTradingDayBounds(timeZone, now);
    const result = await this.getClosedPnl({
      startTime: bounds.startTime,
      endTime: bounds.endTime,
      limit: 100
    });

    return {
      ...result,
      ...bounds,
      syncedAt: new Date().toISOString()
    };
  }

  async getOrders(symbol = null, limit = 50) {
    await this.waitForConnection();
    if (!this.isConnected) return [];
    
    try {
      const marketSymbol = symbol ? this.normalizeSymbol(symbol) : undefined;
      // One unsupported/temporarily unavailable history endpoint should not
      // discard successful results from the other endpoints.
      const results = await Promise.allSettled([
        this.exchange.fetchOpenOrders(marketSymbol, undefined, limit),
        this.exchange.fetchClosedOrders(marketSymbol, undefined, limit),
        this.exchange.fetchCanceledOrders(marketSymbol, undefined, limit)
      ]);

      const allOrders = results
        .filter(result => result.status === 'fulfilled' && Array.isArray(result.value))
        .flatMap(result => result.value);

      if (!allOrders.length && results.every(result => result.status === 'rejected')) {
        const reason = results
          .map(result => result.reason?.message)
          .filter(Boolean)
          .join(' | ');
        logger.error('Orders fetch error:', reason || 'All Bybit order endpoints failed');
      }
      
      const sorted = deduplicateOrders(allOrders)
        .sort((a, b) => this.toFiniteNumber(b.timestamp) - this.toFiniteNumber(a.timestamp))
        .slice(0, limit);
      
      return sorted.map(o => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        price: o.price,
        amount: o.amount,
        filled: o.filled,
        remaining: o.remaining,
        status: o.status,
        timestamp: o.timestamp
      }));
    } catch (error) {
      logger.error('Orders fetch error:', error);
      return [];
    }
  }

  async getOrder(orderId, symbol) {
    await this.waitForConnection();
    if (!this.isConnected || !orderId) return null;

    const marketSymbol = this.normalizeSymbol(symbol);
    try {
      // CCXT's Bybit adapter requires an explicit acknowledgement because
      // fetchOrder can only search the account's most recent 500 orders. This
      // is a brand-new order, so it is necessarily inside that window.
      return await this.exchange.fetchOrder(
        orderId,
        marketSymbol,
        { acknowledged: true }
      );
    } catch (primaryError) {
      // Fresh Bybit orders can briefly be missing from fetchOrder. Prefer the
      // dedicated single-order endpoints; unlike downloading three complete
      // order lists on every poll, these stay fast and avoid rate-limit delays.
      const lookups = [
        'fetchOpenOrder',
        'fetchClosedOrder'
      ];

      for (const method of lookups) {
        if (typeof this.exchange[method] !== 'function') continue;
        try {
          const order = await this.exchange[method](orderId, marketSymbol);
          if (order) return order;
        } catch (error) {
          // Try the other order status. An order cannot be both open and
          // closed, so one of these calls normally reports "not found".
        }
      }

      const message = String(primaryError?.message || primaryError || '');
      const expectedVisibilityDelay = /order not found|order does not exist|110001|not visible/i.test(message);
      if (!expectedVisibilityDelay) {
        logger.error('Order fetch error:', primaryError);
      }
      return null;
    }
  }

  // FIXED: getPositions with null safety
  async getPositions(symbol = null) {
    await this.waitForConnection();
    if (!this.isConnected) {
      return [];
    }

    try {
      // If symbol is null or undefined, fetch all positions
      const requestedSymbols = symbol ? [this.normalizeSymbol(symbol)] : undefined;
      const positions = await this.exchange.fetchPositions(requestedSymbols);
      
      if (!positions || !Array.isArray(positions)) {
        return [];
      }

      return positions
        .filter(pos => this.toFiniteNumber(pos?.contracts ?? pos?.size) > 0)
        .map(pos => {
        // FIXED: Handle null symbol safely
        let symbolStr = pos.symbol || symbol || '';
        let coin = 'unknown';
        
        if (symbolStr && typeof symbolStr === 'string') {
          coin = symbolStr.split('/')[0] || 'unknown';
        }
        
          return {
            coin: coin,
            symbol: symbolStr,
            side: pos.side || 'long',
            size: this.toFiniteNumber(pos.contracts ?? pos.size),
            entryPrice: this.toFiniteNumber(pos.entryPrice),
            markPrice: this.toFiniteNumber(pos.markPrice ?? pos.lastPrice),
            unrealizedPnl: this.toFiniteNumber(pos.unrealizedPnl),
            percentage: this.toFiniteNumber(pos.percentage),
            leverage: this.toFiniteNumber(pos.leverage, 1),
            liquidationPrice: this.toFiniteNumber(pos.liquidationPrice),
            margin: this.toFiniteNumber(pos.margin)
          };
        });
    } catch (error) {
      logger.error('POSITIONS_FETCH', error);
      return [];
    }
  }

  async setLeverage(symbol, leverage) {
    if (!this.isConnected) {
      return { success: false, error: 'Not connected to Bybit' };
    }
    
    try {
      const marketSymbol = this.normalizeSymbol(symbol);
      await this.exchange.setLeverage(leverage, marketSymbol);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async closePosition(symbol, size, side) {
    if (this.mode === 'ro') {
      return { error: 'READ-ONLY mode - cannot close positions' };
    }

    if (!this.isConnected) {
      return { error: 'Not connected to Bybit' };
    }

    try {
      const marketSymbol = this.normalizeSymbol(symbol);
      const order = await this.exchange.createOrder(
        marketSymbol,
        'market',
        side === 'long' ? 'sell' : 'buy',
        size,
        undefined,
        { reduceOnly: true }
      );
      return order;
    } catch (error) {
      return { error: error.message };
    }
  }

  async placeOrder(symbol, side, amount, price = null, orderType = 'market', params = {}) {
    if (this.mode === 'ro') {
      return { error: 'READ-ONLY mode - cannot place orders' };
    }
    
    if (!this.isConnected) {
      return { error: 'Not connected to Bybit' };
    }
    
    try {
      await this.exchange.loadMarkets();

      const marketSymbol = this.normalizeSymbol(symbol);
      const normalizedSide = String(side || '').toLowerCase();
      const numericAmount = Number(amount);
      let normalizedType = String(orderType || 'market').toLowerCase().replace('-', '_');
      const normalizedParams = { ...(params || {}) };

      if (!['buy', 'sell'].includes(normalizedSide)) {
        return { error: `Invalid order side: ${side}` };
      }

      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return { error: `Invalid order amount: ${amount}` };
      }

      // CCXT uses a normal market order plus triggerPrice for stop-market
      // orders. Never pass the custom string STOP_MARKET to createOrder.
      if (normalizedType === 'stop_market' || normalizedType === 'stopmarket') {
        normalizedType = 'market';
        if (normalizedParams.triggerPrice == null && normalizedParams.stopPrice != null) {
          normalizedParams.triggerPrice = Number(normalizedParams.stopPrice);
        }
        delete normalizedParams.stopPrice;
      }

      let orderPrice;
      if (normalizedType === 'market') {
        // Important: use undefined, not null. Some CCXT/Bybit versions call
        // price.toString() when the field is present.
        orderPrice = undefined;
      } else {
        orderPrice = Number(price);
        if (!Number.isFinite(orderPrice) || orderPrice <= 0) {
          return { error: `${normalizedType} orders require a valid price` };
        }
      }

      let referencePrice = orderPrice;
      if (normalizedType === 'market') {
        try {
          const ticker = await this.exchange.fetchTicker(marketSymbol);
          referencePrice = this.toFiniteNumber(ticker?.last ?? ticker?.mark);
        } catch (error) {
          referencePrice = 0;
        }
      }

      const rules = await this.getMarketRules(marketSymbol, referencePrice);
      if (rules.error) {
        return { error: `Cannot validate ${marketSymbol} order limits: ${rules.error}` };
      }
      if (!rules.active) {
        return { error: `${marketSymbol} is not active on Bybit` };
      }

      const minimumAmount = this.toFiniteNumber(rules.minimumOrderAmount);
      if (minimumAmount > 0 && numericAmount + Number.EPSILON < minimumAmount) {
        const minimumNotional = referencePrice > 0 ? minimumAmount * referencePrice : 0;
        return {
          error: `${marketSymbol} requires at least ${minimumAmount} ${symbol.toString().split('/')[0]} ` +
            `(approximately $${minimumNotional.toFixed(2)} notional at the current price)`
        };
      }

      let preciseAmount;
      try {
        preciseAmount = Number(this.exchange.amountToPrecision(marketSymbol, numericAmount));
      } catch (error) {
        return { error: `Invalid ${marketSymbol} amount ${numericAmount}: ${error.message}` };
      }
      if (!Number.isFinite(preciseAmount) || preciseAmount <= 0) {
        return { error: `${marketSymbol} amount rounds to zero at Bybit's ${rules.amountStep} quantity step` };
      }
      if (minimumAmount > 0 && preciseAmount + Number.EPSILON < minimumAmount) {
        return { error: `${marketSymbol} amount ${preciseAmount} is below Bybit's live minimum ${minimumAmount}` };
      }

      const notional = referencePrice > 0 ? preciseAmount * referencePrice : 0;
      if (rules.minCost > 0 && notional > 0 && notional + Number.EPSILON < rules.minCost) {
        return { error: `${marketSymbol} notional $${notional.toFixed(2)} is below Bybit's live minimum $${rules.minCost.toFixed(2)}` };
      }

      const order = await this.exchange.createOrder(
        marketSymbol,
        normalizedType,
        normalizedSide,
        preciseAmount,
        orderPrice,
        normalizedParams
      );
      return order;
    } catch (error) {
      logger.error('Order placement error:', error);
      return { error: error.message };
    }
  }

  async cancelOrder(orderId, symbol) {
    if (this.mode === 'ro') {
      return { error: 'READ-ONLY mode - cannot cancel orders' };
    }
    
    if (!this.isConnected) {
      return { success: true };
    }
    
    try {
      return await this.exchange.cancelOrder(orderId, this.normalizeSymbol(symbol));
    } catch (error) {
      logger.error('Order cancel error:', error);
      return { error: error.message };
    }
  }

  async getTicker(symbol) {
    if (!this.isConnected) {
      return null;
    }
    
    try {
      return await this.exchange.fetchTicker(this.normalizeSymbol(symbol));
    } catch (error) {
      logger.error('Ticker fetch error:', error);
      return null;
    }
  }

  getMode() { 
    return this.mode; 
  }

  getMockBalance() {
    console.log('⚠️ USING MOCK BALANCE - Check your API keys!');
    return {
      totalUSD: 15.00,
      tradableUSD: 15.00,
      availableUSDT: 15.00,
      walletUSDT: 15.00,
      fundingUSDT: 0,
      assets: [
        { asset: 'USDT', free: 15.00, used: 0, total: 15.00, usdValue: 15.00 }
      ],
      mode: this.mode,
      isMock: true
    };
  }
}

module.exports = new BybitClient();

