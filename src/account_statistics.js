'use strict';

const db = require('./database');
const bybit = require('./bybit_client');
const logger = require('./logger');
const { normalizeCoin } = require('./symbol_utils');
const signalCalibrator = require('./signal_calibrator');

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class AccountStatistics {
  constructor() {
    this.timeZone = String(process.env.STATISTICS_TIMEZONE || process.env.DAILY_TARGET_TIMEZONE || 'Asia/Yerevan');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone }).format(new Date());
    } catch (_error) {
      this.timeZone = 'UTC';
    }

    this.backfillDays = clamp(Math.floor(finite(process.env.STATISTICS_BACKFILL_DAYS, 30)), 1, 365);
    this.resyncDays = clamp(Math.floor(finite(process.env.STATISTICS_RESYNC_DAYS, 7)), 1, 30);
    this.syncIntervalMs = clamp(finite(process.env.STATISTICS_SYNC_SECONDS, 60), 15, 3600) * 1000;
    this.maxRows = clamp(Math.floor(finite(process.env.STATISTICS_MAX_ROWS, 24)), 5, 100);
    this.lastSyncAt = 0;
    this.syncPromise = null;
  }

  dateKey(timestamp = Date.now()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date(timestamp))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  parseDateKey(key) {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  addDays(key, amount) {
    const date = this.parseDateKey(key);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  daysBetween(startKey, endKey) {
    if (!startKey || !endKey) return 0;
    return Math.max(0, Math.floor((this.parseDateKey(endKey) - this.parseDateKey(startKey)) / 86400000));
  }

  localMidnightMs(key) {
    const [year, month, day] = String(key).split('-').map(Number);
    if (typeof bybit.zonedMidnightToUtcMs === 'function') {
      return bybit.zonedMidnightToUtcMs(year, month, day, this.timeZone);
    }
    return Date.UTC(year, month - 1, day);
  }

  dayBounds(key) {
    const startTime = this.localMidnightMs(key);
    const endExclusive = this.localMidnightMs(this.addDays(key, 1));
    return { startTime, endTime: endExclusive - 1, endExclusive };
  }

  periodThreshold(period) {
    return ({ daily: 1, week: 7, month: 30, year: 365 })[period] || 1;
  }

  periodLabel(period) {
    return ({ daily: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' })[period] || 'Daily';
  }

  getTrackingStartDate() {
    const stored = db.getStatisticsMeta('trackingStartedDate')?.value;
    return /^\d{4}-\d{2}-\d{2}$/.test(String(stored || ''))
      ? String(stored)
      : null;
  }

  setTrackingStartDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    db.setStatisticsMeta('trackingStartedDate', date);
  }

  async fetchClosedPnlHistory(startKey, endKey) {
    const grouped = new Map();
    let cursorKey = startKey;

    while (cursorKey <= endKey) {
      const chunkEnd = [this.addDays(cursorKey, 6), endKey].sort()[0];
      const bounds = {
        startTime: this.dayBounds(cursorKey).startTime,
        // Never send a future endTime for the current chunk; some Bybit API
        // versions reject ranges extending beyond the request timestamp.
        endTime: Math.min(Date.now(), this.dayBounds(chunkEnd).endTime)
      };
      const result = await bybit.getClosedPnl({ ...bounds, limit: 100 });
      if (!result?.available) {
        throw new Error(result?.error || 'Bybit closed PnL history is unavailable');
      }

      for (const record of result.records || []) {
        const timestamp = finite(record.updatedTime || record.createdTime);
        const key = this.dateKey(timestamp || Date.now());
        const row = grouped.get(key) || {
          realizedPnl: 0,
          grossProfit: 0,
          grossLoss: 0,
          fees: 0,
          trades: 0,
          wins: 0,
          losses: 0
        };
        const pnl = finite(record.closedPnl);
        row.realizedPnl += pnl;
        row.grossProfit += Math.max(0, pnl);
        row.grossLoss += Math.abs(Math.min(0, pnl));
        row.fees += Math.abs(finite(record.openFee)) + Math.abs(finite(record.closeFee));
        row.trades += 1;
        if (pnl > 0) row.wins += 1;
        else if (pnl < 0) row.losses += 1;
        grouped.set(key, row);

        const notional = Math.abs(finite(record.entryPrice) * finite(record.qty));
        const pnlPercent = notional > 0 ? pnl / notional * 100 : 0;
        db.saveTrade({
          tradeId: record.orderId || `${record.symbol}:${record.updatedTime}:${record.closedPnl}`,
          coin: normalizeCoin(record.symbol),
          side: String(record.side || '').toUpperCase(),
          entry: finite(record.entryPrice),
          exit: finite(record.exitPrice),
          size: finite(record.qty),
          pnl,
          pnlPercent,
          fee: Math.abs(finite(record.openFee)) + Math.abs(finite(record.closeFee)),
          status: 'CLOSED',
          openedAt: record.createdTime ? new Date(record.createdTime).toISOString() : null,
          closedAt: record.updatedTime ? new Date(record.updatedTime).toISOString() : null,
          reason: 'BYBIT_CLOSED_PNL_SYNC'
        });

        const normalizedCoin = normalizeCoin(record.symbol);
        const signalContext = db.findOpenSignalContext?.(normalizedCoin);
        const closedAtMs = finite(record.updatedTime || record.createdTime);
        const openedAtMs = signalContext?.openedAt ? Date.parse(signalContext.openedAt) : 0;
        if (signalContext && closedAtMs >= openedAtMs) {
          signalCalibrator.record({
            action: signalContext.action,
            confidence: signalContext.confidence,
            marketCondition: signalContext.marketCondition
          }, pnlPercent);
          db.closeSignalContext?.(
            signalContext.id,
            pnlPercent,
            record.updatedTime ? new Date(record.updatedTime).toISOString() : new Date().toISOString()
          );
        }
      }

      cursorKey = this.addDays(chunkEnd, 1);
    }

    return grouped;
  }

  async sync(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && this.lastSyncAt && now - this.lastSyncAt < this.syncIntervalMs) {
      return this.snapshot();
    }
    if (this.syncPromise) return this.syncPromise;

    this.syncPromise = this.performSync(options)
      .finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  async performSync(options = {}) {
    const today = this.dateKey();
    const historyBackfillComplete = db.getStatisticsMeta('historyBackfillComplete')?.value === 'true';
    const fullBackfill = options.fullBackfill === true || !historyBackfillComplete;
    const requestedDays = options.backfill === false
      ? 1
      : (fullBackfill ? this.backfillDays : this.resyncDays);
    const fetchStartKey = this.addDays(today, -(requestedDays - 1));

    const [balance, positions] = await Promise.all([
      bybit.getBalance(),
      typeof bybit.getPositions === 'function' ? bybit.getPositions().catch(() => []) : Promise.resolve([])
    ]);

    if (balance?.unavailable || !(finite(balance?.totalUSD) > 0)) {
      throw new Error(balance?.error || 'Live account equity is unavailable');
    }

    const grouped = await this.fetchClosedPnlHistory(fetchStartKey, today);
    const actualRecordDates = [...grouped.entries()]
      .filter(([, value]) => finite(value?.trades) > 0)
      .map(([key]) => key)
      .sort();
    const earliestActualDate = actualRecordDates[0] || null;

    // Unlock periods from the first trustworthy observation. Empty synthetic
    // backfill days must not instantly unlock weekly/monthly statistics.
    let trackingStart = this.getTrackingStartDate();
    if (!trackingStart) trackingStart = earliestActualDate || today;
    if (earliestActualDate && earliestActualDate < trackingStart) {
      trackingStart = earliestActualDate;
    }
    this.setTrackingStartDate(trackingStart);
    db.deleteDailyStatsBefore?.(trackingStart);

    const unrealizedPnl = (Array.isArray(positions) ? positions : [])
      .reduce((sum, position) => sum + finite(position?.unrealizedPnl), 0);
    const currentEquity = finite(balance.totalUSD);
    const realizedEquity = currentEquity - unrealizedPnl;

    // Only rewrite the fetched window, while never creating rows before the
    // true tracking start date.
    const rowStartKey = fetchStartKey > trackingStart ? fetchStartKey : trackingStart;
    const dayKeys = [];
    for (let key = rowStartKey; key <= today; key = this.addDays(key, 1)) dayKeys.push(key);
    const totalPnl = dayKeys.reduce((sum, key) => sum + finite(grouped.get(key)?.realizedPnl), 0);
    let rollingEquity = Math.max(0.00000001, realizedEquity - totalPnl);
    const nowIso = new Date().toISOString();

    for (const key of dayKeys) {
      const pnl = grouped.get(key) || {
        realizedPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        fees: 0,
        trades: 0,
        wins: 0,
        losses: 0
      };
      const openingEquity = rollingEquity;
      const closingEquity = openingEquity + finite(pnl.realizedPnl);
      const returnPct = openingEquity > 0 ? finite(pnl.realizedPnl) / openingEquity * 100 : 0;
      const currentDay = key === today;

      db.upsertDailyStat({
        date: key,
        timezone: this.timeZone,
        openingEquity,
        closingEquity,
        latestEquity: currentDay ? currentEquity : closingEquity,
        realizedPnl: pnl.realizedPnl,
        grossProfit: pnl.grossProfit,
        grossLoss: pnl.grossLoss,
        fees: pnl.fees,
        trades: pnl.trades,
        wins: pnl.wins,
        losses: pnl.losses,
        returnPct,
        source: 'bybit-closed-pnl-reconstructed',
        isComplete: !currentDay,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso
      });
      rollingEquity = closingEquity;
    }

    db.saveBalance(currentEquity, Array.isArray(positions) ? positions.length : 0, 0);
    db.setStatisticsMeta('lastSuccessfulSync', nowIso);
    db.setStatisticsMeta('statisticsTimeZone', this.timeZone);
    db.setStatisticsMeta('historyBackfillComplete', 'true');
    db.setStatisticsMeta(
      'calculationNote',
      'Returns use Bybit realized closed PnL divided by reconstructed opening equity. Deposits, withdrawals and transfers can distort historical percentages.'
    );
    this.lastSyncAt = Date.now();

    logger.action('ACCOUNT_STATISTICS_SYNC', {
      fetchStartKey,
      rowStartKey,
      trackingStart,
      today,
      currentEquity,
      unrealizedPnl,
      rows: dayKeys.length,
      fullBackfill
    });

    return this.snapshot();
  }

  availability(period) {
    if (period === 'daily') return { available: true, remainingDays: 0, requiredDays: 1, availableDays: 1 };
    const today = this.dateKey();
    const trackingStart = this.getTrackingStartDate() || today;
    const availableDays = this.daysBetween(trackingStart, today) + 1;
    const requiredDays = this.periodThreshold(period);
    return {
      available: availableDays >= requiredDays,
      remainingDays: Math.max(0, requiredDays - availableDays),
      requiredDays,
      availableDays,
      firstDate: trackingStart
    };
  }

  isoWeekInfo(dateKey) {
    const date = this.parseDateKey(dateKey);
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    const weekYear = date.getUTCFullYear();
    const original = this.parseDateKey(dateKey);
    const originalDay = original.getUTCDay() || 7;
    const monday = new Date(original);
    monday.setUTCDate(original.getUTCDate() - originalDay + 1);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      key: `${weekYear}-W${String(week).padStart(2, '0')}`,
      label: `${monday.toISOString().slice(0, 10)} — ${sunday.toISOString().slice(0, 10)}`
    };
  }

  aggregate(period, rows) {
    const groups = new Map();
    for (const row of rows) {
      let key;
      let label;
      if (period === 'daily') {
        key = row.date;
        label = row.date;
      } else if (period === 'week') {
        const info = this.isoWeekInfo(row.date);
        key = info.key;
        label = info.label;
      } else if (period === 'month') {
        key = row.date.slice(0, 7);
        label = key;
      } else {
        key = row.date.slice(0, 4);
        label = key;
      }

      const group = groups.get(key) || {
        key,
        label,
        openingEquity: finite(row.openingEquity),
        closingEquity: finite(row.closingEquity),
        latestEquity: finite(row.latestEquity, finite(row.closingEquity)),
        realizedPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        fees: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        firstDate: row.date,
        lastDate: row.date,
        complete: Boolean(row.isComplete)
      };
      group.realizedPnl += finite(row.realizedPnl);
      group.grossProfit += finite(row.grossProfit);
      group.grossLoss += finite(row.grossLoss);
      group.fees += finite(row.fees);
      group.trades += Math.max(0, Number(row.trades) || 0);
      group.wins += Math.max(0, Number(row.wins) || 0);
      group.losses += Math.max(0, Number(row.losses) || 0);
      group.closingEquity = finite(row.closingEquity, group.closingEquity);
      group.latestEquity = finite(row.latestEquity, group.closingEquity);
      group.lastDate = row.date;
      group.complete = group.complete && Boolean(row.isComplete);
      groups.set(key, group);
    }

    return [...groups.values()]
      .map(group => ({
        ...group,
        returnPct: group.openingEquity > 0 ? group.realizedPnl / group.openingEquity * 100 : 0,
        winRate: group.trades > 0 ? group.wins / group.trades * 100 : 0
      }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }

  get(period = 'daily', limit = this.maxRows) {
    const normalized = ['daily', 'week', 'month', 'year'].includes(period) ? period : 'daily';
    const availability = this.availability(normalized);
    if (!availability.available) {
      return { period: normalized, availability, rows: [], current: null };
    }

    const trackingStart = this.getTrackingStartDate() || '0000-01-01';
    // Read the complete tracked range so yearly history keeps working after
    // the database contains more than 400 days. getDailyStats is ordered ASC.
    const dailyRows = db.getDailyStats(trackingStart, this.dateKey());
    const rows = this.aggregate(normalized, dailyRows).slice(0, Math.max(1, limit));
    return {
      period: normalized,
      availability,
      rows,
      current: rows[0] || null,
      coverage: db.getStatsCoverage(),
      timeZone: this.timeZone,
      note: db.getStatisticsMeta('calculationNote')?.value || ''
    };
  }

  snapshot() {
    return {
      timeZone: this.timeZone,
      coverage: db.getStatsCoverage(),
      daily: this.get('daily', 1),
      week: this.get('week', 1),
      month: this.get('month', 1),
      year: this.get('year', 1)
    };
  }
}

module.exports = new AccountStatistics();
