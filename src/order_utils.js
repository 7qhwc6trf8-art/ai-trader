'use strict';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function statusRank(status) {
  const normalized = String(status || '').toLowerCase();
  if (['closed', 'filled', 'canceled', 'cancelled', 'rejected', 'expired'].includes(normalized)) return 3;
  if (['open', 'new', 'partially_filled', 'partiallyfilled'].includes(normalized)) return 2;
  return 1;
}

function orderKey(order = {}) {
  if (order.id) return `id:${order.id}`;
  return [
    order.symbol || '', order.side || '', order.type || '',
    finite(order.timestamp), finite(order.amount), finite(order.price)
  ].join(':');
}

function deduplicateOrders(orders = []) {
  const unique = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    const key = orderKey(order);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, order);
      continue;
    }

    const existingRank = statusRank(existing.status);
    const newRank = statusRank(order.status);
    const existingTime = finite(existing.lastTradeTimestamp, finite(existing.timestamp));
    const newTime = finite(order.lastTradeTimestamp, finite(order.timestamp));
    const existingFilled = finite(existing.filled);
    const newFilled = finite(order.filled);

    if (
      newRank > existingRank ||
      (newRank === existingRank && newFilled > existingFilled) ||
      (newRank === existingRank && newFilled === existingFilled && newTime > existingTime)
    ) {
      unique.set(key, order);
    }
  }
  return [...unique.values()];
}

module.exports = { deduplicateOrders, orderKey, statusRank };
