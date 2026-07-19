'use strict';

function normalizeCoin(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/:USDT$/i, '')
    .replace(/\/USDT$/i, '')
    .replace(/USDT$/i, '')
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeUnifiedSymbol(symbol) {
  const coin = normalizeCoin(symbol);
  return coin ? `${coin}/USDT:USDT` : '';
}

function sameCoin(a, b) {
  const left = normalizeCoin(a);
  const right = normalizeCoin(b);
  return Boolean(left && right && left === right);
}

module.exports = { normalizeCoin, normalizeUnifiedSymbol, sameCoin };
