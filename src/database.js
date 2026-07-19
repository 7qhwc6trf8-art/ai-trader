'use strict';

const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
  constructor() {
    const databasePath = process.env.TRADING_DB_PATH
      ? path.resolve(process.env.TRADING_DB_PATH)
      : path.join(__dirname, '../trading.db');

    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');

    this.init();
  }

  init() {
    this.createBaseTables();
    this.runMigrations();
    this.prepareStatements();
  }

  createBaseTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tradeId TEXT,
        coin TEXT,
        side TEXT,
        entry REAL,
        exit REAL,
        size REAL,
        pnl REAL,
        pnlPercent REAL,
        fee REAL,
        status TEXT,
        openedAt TEXT,
        closedAt TEXT,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT UNIQUE,
        side TEXT,
        entry REAL,
        entryPrice REAL,
        size REAL,
        leverage REAL DEFAULT 1,
        stopLoss REAL,
        takeProfit REAL,
        openedAt TEXT,
        updatedAt TEXT,
        orderId TEXT,
        slOrderId TEXT,
        tpOrderId TEXT,
        status TEXT DEFAULT 'OPEN'
      );

      CREATE TABLE IF NOT EXISTS performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE,
        balance REAL,
        totalPnl REAL,
        winRate REAL,
        trades INTEGER,
        maxDrawdown REAL
      );

      CREATE TABLE IF NOT EXISTS ai_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        coin TEXT,
        action TEXT,
        confidence INTEGER,
        reasoning TEXT,
        indicators TEXT,
        executed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS balance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        balance REAL,
        totalPositions INTEGER,
        exposure REAL
      );

      CREATE TABLE IF NOT EXISTS trade_signal_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId TEXT UNIQUE,
        coin TEXT,
        action TEXT,
        confidence REAL DEFAULT 0,
        executionScore REAL DEFAULT 0,
        marketCondition TEXT,
        openedAt TEXT,
        closedAt TEXT,
        pnlPercent REAL DEFAULT 0,
        status TEXT DEFAULT 'OPEN'
      );

      CREATE TABLE IF NOT EXISTS account_daily_stats (
        date TEXT PRIMARY KEY,
        timezone TEXT NOT NULL,
        openingEquity REAL DEFAULT 0,
        closingEquity REAL DEFAULT 0,
        latestEquity REAL DEFAULT 0,
        realizedPnl REAL DEFAULT 0,
        grossProfit REAL DEFAULT 0,
        grossLoss REAL DEFAULT 0,
        fees REAL DEFAULT 0,
        trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        returnPct REAL DEFAULT 0,
        source TEXT,
        isComplete INTEGER DEFAULT 0,
        firstSeenAt TEXT,
        lastSeenAt TEXT
      );

      CREATE TABLE IF NOT EXISTS statistics_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      );
    `);
  }

  runMigrations() {
    const migrate = this.db.transaction(() => {
      // Existing trading.db files may have been created by an older build.
      // CREATE TABLE IF NOT EXISTS does not add new columns, so every required
      // column is checked and added explicitly.
      this.ensureColumns('trades', {
        tradeId: 'TEXT',
        coin: 'TEXT',
        side: 'TEXT',
        entry: 'REAL',
        exit: 'REAL',
        size: 'REAL',
        pnl: 'REAL',
        pnlPercent: 'REAL',
        fee: 'REAL',
        status: 'TEXT',
        openedAt: 'TEXT',
        closedAt: 'TEXT',
        reason: 'TEXT'
      });

      this.ensureColumns('positions', {
        coin: 'TEXT',
        side: 'TEXT',
        entry: 'REAL',
        entryPrice: 'REAL',
        size: 'REAL',
        leverage: 'REAL DEFAULT 1',
        stopLoss: 'REAL',
        takeProfit: 'REAL',
        openedAt: 'TEXT',
        updatedAt: 'TEXT',
        orderId: 'TEXT',
        slOrderId: 'TEXT',
        tpOrderId: 'TEXT',
        status: "TEXT DEFAULT 'OPEN'"
      });

      this.ensureColumns('performance', {
        date: 'TEXT',
        balance: 'REAL',
        totalPnl: 'REAL',
        winRate: 'REAL',
        trades: 'INTEGER',
        maxDrawdown: 'REAL'
      });

      this.ensureColumns('ai_decisions', {
        timestamp: 'TEXT',
        coin: 'TEXT',
        action: 'TEXT',
        confidence: 'INTEGER',
        reasoning: 'TEXT',
        indicators: 'TEXT',
        executed: 'INTEGER DEFAULT 0'
      });

      this.ensureColumns('balance_snapshots', {
        timestamp: 'TEXT',
        balance: 'REAL',
        totalPositions: 'INTEGER',
        exposure: 'REAL'
      });

      this.ensureColumns('trade_signal_context', {
        orderId: 'TEXT',
        coin: 'TEXT',
        action: 'TEXT',
        confidence: 'REAL DEFAULT 0',
        executionScore: 'REAL DEFAULT 0',
        marketCondition: 'TEXT',
        openedAt: 'TEXT',
        closedAt: 'TEXT',
        pnlPercent: 'REAL DEFAULT 0',
        status: "TEXT DEFAULT 'OPEN'"
      });

      this.ensureColumns('account_daily_stats', {
        date: 'TEXT',
        timezone: "TEXT DEFAULT 'UTC'",
        openingEquity: 'REAL DEFAULT 0',
        closingEquity: 'REAL DEFAULT 0',
        latestEquity: 'REAL DEFAULT 0',
        realizedPnl: 'REAL DEFAULT 0',
        grossProfit: 'REAL DEFAULT 0',
        grossLoss: 'REAL DEFAULT 0',
        fees: 'REAL DEFAULT 0',
        trades: 'INTEGER DEFAULT 0',
        wins: 'INTEGER DEFAULT 0',
        losses: 'INTEGER DEFAULT 0',
        returnPct: 'REAL DEFAULT 0',
        source: 'TEXT',
        isComplete: 'INTEGER DEFAULT 0',
        firstSeenAt: 'TEXT',
        lastSeenAt: 'TEXT'
      });

      this.ensureColumns('statistics_meta', {
        key: 'TEXT',
        value: 'TEXT',
        updatedAt: 'TEXT'
      });

      this.migratePositionEntryColumns();
      this.normalizePositionRows();
      this.normalizeTradeRows();
      this.createIndexes();

      this.db.prepare(`
        INSERT OR IGNORE INTO schema_migrations (version, appliedAt)
        VALUES (?, ?)
      `).run(3, new Date().toISOString());
    });

    migrate();
  }

  ensureColumns(tableName, definitions) {
    const existingColumns = new Set(
      this.db.prepare(`PRAGMA table_info("${tableName}")`).all()
        .map(column => column.name)
    );

    for (const [columnName, definition] of Object.entries(definitions)) {
      if (existingColumns.has(columnName)) continue;

      this.db.exec(
        `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
      );
      existingColumns.add(columnName);
    }
  }

  migratePositionEntryColumns() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info("positions")').all()
        .map(column => column.name)
    );

    if (!columns.has('entry') || !columns.has('entryPrice')) return;

    // Support both legacy schemas:
    //   positions.entry
    //   positions.entryPrice
    // Keep both populated so old and new code can read the same database.
    this.db.exec(`
      UPDATE positions
      SET entryPrice = entry
      WHERE (entryPrice IS NULL OR entryPrice = 0)
        AND entry IS NOT NULL
        AND entry != 0;

      UPDATE positions
      SET entry = entryPrice
      WHERE (entry IS NULL OR entry = 0)
        AND entryPrice IS NOT NULL
        AND entryPrice != 0;
    `);
  }

  normalizePositionRows() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info("positions")').all()
        .map(column => column.name)
    );

    this.db.exec(`
      UPDATE positions SET status = 'OPEN' WHERE status IS NULL OR TRIM(status) = '';
      UPDATE positions SET leverage = 1 WHERE leverage IS NULL OR leverage <= 0;
      UPDATE positions SET updatedAt = COALESCE(updatedAt, openedAt, CURRENT_TIMESTAMP);
    `);

    // Older schemas did not always enforce one local position per coin.
    // Keep the newest row before adding the unique index used by UPSERT.
    if (columns.has('id') && columns.has('coin')) {
      this.db.exec(`
        DELETE FROM positions
        WHERE coin IS NOT NULL
          AND id NOT IN (
            SELECT MAX(id)
            FROM positions
            WHERE coin IS NOT NULL
            GROUP BY coin
          );
      `);
    }
  }

  normalizeTradeRows() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info("trades")').all()
        .map(column => column.name)
    );
    if (!columns.has('id') || !columns.has('tradeId')) return;

    this.db.exec(`
      DELETE FROM trades
      WHERE tradeId IS NOT NULL
        AND TRIM(tradeId) != ''
        AND id NOT IN (
          SELECT MAX(id)
          FROM trades
          WHERE tradeId IS NOT NULL AND TRIM(tradeId) != ''
          GROUP BY tradeId
        );
    `);
  }

  createIndexes() {
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_coin_unique
        ON positions(coin);

      CREATE INDEX IF NOT EXISTS idx_positions_status
        ON positions(status);

      CREATE INDEX IF NOT EXISTS idx_trades_opened_at
        ON trades(openedAt);

      CREATE INDEX IF NOT EXISTS idx_ai_decisions_timestamp
        ON ai_decisions(timestamp);

      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_timestamp
        ON balance_snapshots(timestamp);

      CREATE INDEX IF NOT EXISTS idx_account_daily_stats_date
        ON account_daily_stats(date);

      CREATE INDEX IF NOT EXISTS idx_trade_signal_context_lookup
        ON trade_signal_context(coin, status, openedAt);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_trade_id_unique
        ON trades(tradeId)
        WHERE tradeId IS NOT NULL AND TRIM(tradeId) != '';
    `);
  }

  prepareStatements() {
    this.statements = {
      saveTrade: this.db.prepare(`
        INSERT OR REPLACE INTO trades (
          tradeId, coin, side, entry, exit, size, pnl, pnlPercent,
          fee, status, openedAt, closedAt, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      savePosition: this.db.prepare(`
        INSERT INTO positions (
          coin, side, entry, entryPrice, size, leverage,
          stopLoss, takeProfit, openedAt, updatedAt,
          orderId, slOrderId, tpOrderId, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(coin) DO UPDATE SET
          side = excluded.side,
          entry = excluded.entry,
          entryPrice = excluded.entryPrice,
          size = excluded.size,
          leverage = excluded.leverage,
          stopLoss = excluded.stopLoss,
          takeProfit = excluded.takeProfit,
          openedAt = COALESCE(positions.openedAt, excluded.openedAt),
          updatedAt = excluded.updatedAt,
          orderId = COALESCE(excluded.orderId, positions.orderId),
          slOrderId = COALESCE(excluded.slOrderId, positions.slOrderId),
          tpOrderId = COALESCE(excluded.tpOrderId, positions.tpOrderId),
          status = excluded.status
      `),

      getOpenPositions: this.db.prepare(`
        SELECT
          *,
          COALESCE(NULLIF(entryPrice, 0), entry, 0) AS entryPrice,
          COALESCE(NULLIF(entry, 0), entryPrice, 0) AS entry
        FROM positions
        WHERE UPPER(COALESCE(status, 'OPEN')) = 'OPEN'
        ORDER BY openedAt DESC
      `),

      closePosition: this.db.prepare(`
        UPDATE positions
        SET status = 'CLOSED', updatedAt = ?
        WHERE coin = ?
      `),

      getTradeHistory: this.db.prepare(`
        SELECT * FROM trades
        ORDER BY openedAt DESC
        LIMIT ?
      `),

      saveAIDecision: this.db.prepare(`
        INSERT INTO ai_decisions (
          timestamp, coin, action, confidence,
          reasoning, indicators, executed
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      getAIDecisions: this.db.prepare(`
        SELECT * FROM ai_decisions
        ORDER BY timestamp DESC
        LIMIT ?
      `),

      saveBalance: this.db.prepare(`
        INSERT INTO balance_snapshots (
          timestamp, balance, totalPositions, exposure
        ) VALUES (?, ?, ?, ?)
      `),

      getLastBalance: this.db.prepare(`
        SELECT * FROM balance_snapshots
        ORDER BY timestamp DESC
        LIMIT 1
      `),

      saveDailyPerformance: this.db.prepare(`
        INSERT INTO performance (
          date, balance, totalPnl, winRate, trades, maxDrawdown
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          balance = excluded.balance,
          totalPnl = excluded.totalPnl,
          winRate = excluded.winRate,
          trades = excluded.trades,
          maxDrawdown = excluded.maxDrawdown
      `),

      getPerformanceHistory: this.db.prepare(`
        SELECT * FROM performance
        ORDER BY date DESC
        LIMIT ?
      `),

      saveSignalContext: this.db.prepare(`
        INSERT INTO trade_signal_context (
          orderId, coin, action, confidence, executionScore, marketCondition, openedAt, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
        ON CONFLICT(orderId) DO UPDATE SET
          coin = excluded.coin,
          action = excluded.action,
          confidence = excluded.confidence,
          executionScore = excluded.executionScore,
          marketCondition = excluded.marketCondition,
          openedAt = COALESCE(trade_signal_context.openedAt, excluded.openedAt)
      `),

      findOpenSignalContext: this.db.prepare(`
        SELECT * FROM trade_signal_context
        WHERE coin = ? AND UPPER(COALESCE(status, 'OPEN')) = 'OPEN'
        ORDER BY openedAt DESC
        LIMIT 1
      `),

      closeSignalContext: this.db.prepare(`
        UPDATE trade_signal_context
        SET status = 'CLOSED', closedAt = ?, pnlPercent = ?
        WHERE id = ?
      `),

      countSignalContextsSince: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM trade_signal_context
        WHERE openedAt >= ?
      `),

      upsertDailyStat: this.db.prepare(`
        INSERT INTO account_daily_stats (
          date, timezone, openingEquity, closingEquity, latestEquity,
          realizedPnl, grossProfit, grossLoss, fees, trades, wins, losses,
          returnPct, source, isComplete, firstSeenAt, lastSeenAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          timezone = excluded.timezone,
          openingEquity = excluded.openingEquity,
          closingEquity = excluded.closingEquity,
          latestEquity = excluded.latestEquity,
          realizedPnl = excluded.realizedPnl,
          grossProfit = excluded.grossProfit,
          grossLoss = excluded.grossLoss,
          fees = excluded.fees,
          trades = excluded.trades,
          wins = excluded.wins,
          losses = excluded.losses,
          returnPct = excluded.returnPct,
          source = excluded.source,
          isComplete = excluded.isComplete,
          firstSeenAt = COALESCE(account_daily_stats.firstSeenAt, excluded.firstSeenAt),
          lastSeenAt = excluded.lastSeenAt
      `),

      getDailyStats: this.db.prepare(`
        SELECT * FROM account_daily_stats
        WHERE date >= ? AND date <= ?
        ORDER BY date ASC
      `),

      getRecentDailyStats: this.db.prepare(`
        SELECT * FROM account_daily_stats
        ORDER BY date DESC
        LIMIT ?
      `),

      deleteDailyStatsBefore: this.db.prepare(`
        DELETE FROM account_daily_stats
        WHERE date < ?
      `),

      getStatsCoverage: this.db.prepare(`
        SELECT MIN(date) AS firstDate, MAX(date) AS lastDate, COUNT(*) AS days
        FROM account_daily_stats
      `),

      setStatisticsMeta: this.db.prepare(`
        INSERT INTO statistics_meta (key, value, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
      `),

      getStatisticsMeta: this.db.prepare(`
        SELECT value, updatedAt FROM statistics_meta WHERE key = ?
      `)
    };
  }

  toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  safeJson(value) {
    try {
      return JSON.stringify(value || {});
    } catch (_error) {
      return '{}';
    }
  }

  saveTrade(trade = {}) {
    const entry = this.toFiniteNumber(trade.entry ?? trade.entryPrice);
    const exit = this.toFiniteNumber(trade.exit ?? trade.exitPrice);

    return this.statements.saveTrade.run(
      trade.tradeId || trade.orderId || null,
      trade.coin || null,
      trade.side || null,
      entry,
      exit,
      this.toFiniteNumber(trade.size),
      this.toFiniteNumber(trade.pnl),
      this.toFiniteNumber(trade.pnlPercent),
      this.toFiniteNumber(trade.fee),
      trade.status || null,
      trade.openedAt || trade.timestamp || null,
      trade.closedAt || null,
      trade.reason || null
    );
  }

  savePosition(position = {}) {
    if (!position.coin) {
      throw new Error('Cannot save position: coin is required');
    }

    const entryPrice = this.toFiniteNumber(
      position.entryPrice ?? position.entry
    );
    const now = new Date().toISOString();

    return this.statements.savePosition.run(
      position.coin,
      position.side || null,
      entryPrice, // legacy entry column
      entryPrice, // canonical entryPrice column
      this.toFiniteNumber(position.size),
      Math.max(1, this.toFiniteNumber(position.leverage, 1)),
      this.toFiniteNumber(position.stopLoss),
      this.toFiniteNumber(position.takeProfit),
      position.openedAt || position.timestamp || now,
      now,
      position.orderId || null,
      position.slOrderId || null,
      position.tpOrderId || null,
      String(position.status || 'OPEN').toUpperCase()
    );
  }

  getOpenPositions() {
    return this.statements.getOpenPositions.all();
  }

  closePosition(coin) {
    return this.statements.closePosition.run(new Date().toISOString(), coin);
  }

  getTradeHistory(limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.statements.getTradeHistory.all(safeLimit);
  }

  getStats() {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) AS totalTrades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS winningTrades,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS losingTrades,
        COALESCE(SUM(pnl), 0) AS totalPnl,
        COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) AS grossProfit,
        ABS(COALESCE(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END), 0)) AS grossLoss,
        COALESCE(MAX(pnl), 0) AS largestWin,
        COALESCE(MIN(pnl), 0) AS largestLoss,
        COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl END), 0) AS averageWin,
        COALESCE(AVG(CASE WHEN pnl < 0 THEN pnl END), 0) AS averageLoss
      FROM trades
      WHERE UPPER(COALESCE(status, 'CLOSED')) = 'CLOSED'
    `).get();

    const totalTrades = Number(stats?.totalTrades) || 0;
    const winningTrades = Number(stats?.winningTrades) || 0;
    const losingTrades = Number(stats?.losingTrades) || 0;
    const grossProfit = this.toFiniteNumber(stats?.grossProfit);
    const grossLoss = this.toFiniteNumber(stats?.grossLoss);

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      totalPnl: this.toFiniteNumber(stats?.totalPnl),
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      largestWin: this.toFiniteNumber(stats?.largestWin),
      largestLoss: this.toFiniteNumber(stats?.largestLoss),
      averageWin: this.toFiniteNumber(stats?.averageWin),
      averageLoss: this.toFiniteNumber(stats?.averageLoss)
    };
  }

  saveAIDecision(decision = {}) {
    return this.statements.saveAIDecision.run(
      decision.timestamp || new Date().toISOString(),
      decision.coin || null,
      decision.action || 'HOLD',
      Math.max(0, Math.min(100, this.toFiniteNumber(decision.confidence))),
      decision.reasoning || '',
      this.safeJson(decision.indicators),
      decision.executed ? 1 : 0
    );
  }

  getAIDecisions(limit = 50) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 50));
    return this.statements.getAIDecisions.all(safeLimit);
  }

  saveBalance(balance, totalPositions, exposure) {
    return this.statements.saveBalance.run(
      new Date().toISOString(),
      this.toFiniteNumber(balance),
      Math.max(0, Math.trunc(this.toFiniteNumber(totalPositions))),
      this.toFiniteNumber(exposure)
    );
  }

  getLastBalance() {
    return this.statements.getLastBalance.get();
  }

  saveDailyPerformance(performance = {}) {
    return this.statements.saveDailyPerformance.run(
      performance.date || new Date().toISOString().slice(0, 10),
      this.toFiniteNumber(performance.balance),
      this.toFiniteNumber(performance.totalPnl),
      this.toFiniteNumber(performance.winRate),
      Math.max(0, Math.trunc(this.toFiniteNumber(performance.trades))),
      this.toFiniteNumber(performance.maxDrawdown)
    );
  }

  getPerformanceHistory(limit = 30) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 30));
    return this.statements.getPerformanceHistory.all(safeLimit);
  }

  saveSignalContext(context = {}) {
    if (!context.orderId || !context.coin) return null;
    return this.statements.saveSignalContext.run(
      String(context.orderId),
      String(context.coin),
      String(context.action || '').toUpperCase(),
      this.toFiniteNumber(context.confidence),
      this.toFiniteNumber(context.executionScore),
      String(context.marketCondition || 'UNKNOWN').toUpperCase(),
      context.openedAt || new Date().toISOString()
    );
  }

  findOpenSignalContext(coin) {
    return this.statements.findOpenSignalContext.get(String(coin)) || null;
  }

  closeSignalContext(id, pnlPercent, closedAt = new Date().toISOString()) {
    return this.statements.closeSignalContext.run(closedAt, this.toFiniteNumber(pnlPercent), id);
  }

  countSignalContextsSince(isoTimestamp) {
    return Number(this.statements.countSignalContextsSince.get(String(isoTimestamp))?.count) || 0;
  }

  upsertDailyStat(stat = {}) {
    const now = new Date().toISOString();
    return this.statements.upsertDailyStat.run(
      stat.date,
      stat.timezone || 'UTC',
      this.toFiniteNumber(stat.openingEquity),
      this.toFiniteNumber(stat.closingEquity),
      this.toFiniteNumber(stat.latestEquity),
      this.toFiniteNumber(stat.realizedPnl),
      this.toFiniteNumber(stat.grossProfit),
      this.toFiniteNumber(stat.grossLoss),
      this.toFiniteNumber(stat.fees),
      Math.max(0, Math.trunc(this.toFiniteNumber(stat.trades))),
      Math.max(0, Math.trunc(this.toFiniteNumber(stat.wins))),
      Math.max(0, Math.trunc(this.toFiniteNumber(stat.losses))),
      this.toFiniteNumber(stat.returnPct),
      stat.source || 'local',
      stat.isComplete ? 1 : 0,
      stat.firstSeenAt || now,
      stat.lastSeenAt || now
    );
  }

  getDailyStats(startDate = '0000-01-01', endDate = '9999-12-31') {
    return this.statements.getDailyStats.all(startDate, endDate);
  }

  getRecentDailyStats(limit = 30) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 30));
    return this.statements.getRecentDailyStats.all(safeLimit);
  }

  deleteDailyStatsBefore(date) {
    return this.statements.deleteDailyStatsBefore.run(String(date));
  }

  getStatsCoverage() {
    return this.statements.getStatsCoverage.get() || { firstDate: null, lastDate: null, days: 0 };
  }

  setStatisticsMeta(key, value) {
    return this.statements.setStatisticsMeta.run(String(key), String(value ?? ''), new Date().toISOString());
  }

  getStatisticsMeta(key) {
    return this.statements.getStatisticsMeta.get(String(key)) || null;
  }

  clearAll() {
    const clear = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM trades;
        DELETE FROM positions;
        DELETE FROM ai_decisions;
        DELETE FROM balance_snapshots;
        DELETE FROM performance;
        DELETE FROM account_daily_stats;
        DELETE FROM statistics_meta;
        DELETE FROM trade_signal_context;
      `);
    });

    clear();
  }

  close() {
    if (this.db?.open) {
      this.db.close();
    }
  }
}

module.exports = new DatabaseManager();

