'use strict';

// V16 coin universe. Unsupported or delisted symbols are skipped safely by the
// existing market-data error handling. Override with AUTO_TRADE_COINS in .env.
const DEFAULT_COINS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'POL', 'MATIC', 'LTC', 'BCH', 'ATOM', 'UNI', 'AAVE', 'NEAR', 'APT', 'SUI',
  'ARB', 'OP', 'INJ', 'ETC', 'FIL', 'ICP', 'TRX', 'TON', 'XLM', 'HBAR',
  'ALGO', 'VET', 'RENDER', 'GRT', 'MKR', 'STX', 'IMX', 'EGLD', 'QNT', 'FTM',
  'CRV', 'SNX', 'SUSHI', 'CAKE', '1INCH', 'APE', 'LDO', 'RUNE', 'KAS', 'TIA',
  'SEI', 'JUP', 'PYTH', 'WIF', 'BONK', 'PEPE', 'FLOKI', 'SHIB', 'ORDI', 'WLD'
];

const QUICK_SELECT_COINS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE',
  'ADA', 'AVAX', 'LINK', 'DOT', 'SUI', 'TON'
];

function normalizeCoin(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\/USDT(?::USDT)?$/, '')
    .replace(/[^A-Z0-9]/g, '');
}

function parseCoinList(value) {
  if (!value) return [];
  return [...new Set(String(value)
    .split(/[\s,;|]+/)
    .map(normalizeCoin)
    .filter(Boolean))];
}

function getAutoTradeCoins() {
  const configured = parseCoinList(process.env.AUTO_TRADE_COINS);
  const source = configured.length ? configured : DEFAULT_COINS;
  const max = Number(process.env.MAX_SCAN_COINS);
  const limit = Number.isInteger(max) && max > 0 ? Math.min(200, max) : source.length;
  return source.slice(0, limit);
}

function getQuickSelectPairs() {
  const configured = parseCoinList(process.env.QUICK_SELECT_COINS);
  const source = configured.length ? configured : QUICK_SELECT_COINS;
  return source.slice(0, 18).map(coin => `${coin}/USDT`);
}

module.exports = {
  DEFAULT_COINS,
  QUICK_SELECT_COINS,
  normalizeCoin,
  parseCoinList,
  getAutoTradeCoins,
  getQuickSelectPairs
};

