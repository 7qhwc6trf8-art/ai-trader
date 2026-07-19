'use strict';

const signalCalibrator = require('./signal_calibrator');
const riskManager = require('./risk_manager');
const tradeJournal = require('./trade_journal');
const db = require('./database');
const { normalizeCoin } = require('./symbol_utils');
const { finite } = require('./core/config');

class ClosedTradeReconciler {
  reconcile(snapshot = {}, equity = 0) {
    if (!snapshot?.available || !Array.isArray(snapshot.records)) return { processed: 0, records: [] };

    const newRecords = riskManager.reconcileClosedRecords(snapshot.records, equity);
    const processed = [];

    for (const record of newRecords) {
      const coin = normalizeCoin(record.symbol);
      const open = tradeJournal.findOpenByCoin(coin);
      const entryPrice = finite(record.entryPrice, finite(open?.entryPrice));
      const qty = finite(record.qty);
      const notional = Math.abs(entryPrice * qty);
      const netPnl = finite(record.closedPnl);
      const netPnlPct = notional > 0 ? netPnl / notional * 100 : 0;
      const riskAmount = Math.abs(finite(open?.riskAmount));
      const rMultiple = riskAmount > 0 ? netPnl / riskAmount : 0;
      const tradeId = String(record.tradeId || record.orderId || `${record.symbol}:${record.updatedTime}:${record.closedPnl}`);
      const signal = open?.signal || {
        coin,
        action: String(record.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
        confidence: 0,
        marketCondition: 'UNKNOWN',
        timeframe: 'UNKNOWN',
        source: 'RECONCILED'
      };

      const calibration = signalCalibrator.record(signal, {
        tradeId,
        orderId: record.orderId,
        netPnl,
        netPnlPct,
        riskAmount,
        rMultiple,
        closedAt: new Date(finite(record.updatedTime, Date.now())).toISOString()
      });

      const closedAt = new Date(finite(record.updatedTime, Date.now())).toISOString();
      tradeJournal.closed({
        eventId: `closed-${tradeId}`,
        tradeId,
        orderId: record.orderId,
        signalId: open?.signalId || null,
        coin,
        side: record.side,
        entryPrice,
        exitPrice: finite(record.exitPrice),
        size: qty,
        netPnl,
        netPnlPct,
        rMultiple,
        fees: finite(record.openFee) + finite(record.closeFee),
        closedAt,
        calibrationRecorded: calibration.recorded
      });

      try {
        db.saveTrade({
          tradeId,
          coin,
          side: record.side,
          entryPrice,
          exitPrice: finite(record.exitPrice),
          size: qty,
          pnl: netPnl,
          pnlPercent: netPnlPct,
          fee: finite(record.openFee) + finite(record.closeFee),
          status: 'CLOSED',
          openedAt: open?.openedAt || null,
          closedAt,
          reason: 'BYBIT_CLOSED_PNL_RECONCILIATION'
        });
        db.closePosition(coin);
      } catch (_) {
        // Journal and risk state remain authoritative if the optional DB write fails.
      }

      processed.push({ tradeId, coin, netPnl, netPnlPct, rMultiple, calibration });
    }

    riskManager.overwriteDailyFromExchange(snapshot, equity);
    return { processed: processed.length, records: processed };
  }
}

module.exports = new ClosedTradeReconciler();
