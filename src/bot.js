require('dotenv').config();

const { Telegraf, Markup, session } = require("telegraf");
const { getMarketData, TIMEFRAMES } = require("./analyzer");
const chartGenerator = require("./chart_generator");
const patternVisualizer = require("./pattern_visualizer");
const forecastEngine = require("./forecast_engine");
const forecastChartGenerator = require("./forecast_chart_generator");
const marketScanner = require("./market_scanner");
const { getAutoTradeCoins, getQuickSelectPairs } = require("./coin_universe");
const ultimateAI = require("./ultimate_ai_trader");
const bybit = require("./bybit_client");
const orderManager = require("./order_manager");
const processLock = require('./process_lock');
const riskManager = require("./risk_manager");
const logger = require("./logger");
const db = require("./database");
const aiValidator = require("./ai_validator");
const wsManager = require("./websocket_manager");
const BacktestEngine = require("./backtest");
const accountStatistics = require("./account_statistics");
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const TELEGRAM_HANDLER_TIMEOUT = Math.max(
  90000,
  parseInt(process.env.TELEGRAM_HANDLER_TIMEOUT, 10) || 300000
);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN, {
  handlerTimeout: TELEGRAM_HANDLER_TIMEOUT
});
bot.use(session());

// ==================== CONSTANTS ====================

const BYBIT_MODE = process.env.BYBIT_MODE || 'ro';
// Was 600000 (10 min) and only scanned ONE coin per tick, round-robin.
// Now this is the pause BETWEEN full sweeps; each sweep itself scans every
// coin across every timeframe below. Override with AUTO_TRADE_INTERVAL in .env.
const AUTO_TRADE_INTERVAL = parseInt(process.env.AUTO_TRADE_INTERVAL) || 90000;
const AUTO_TRADE_COINS = getAutoTradeCoins();
const SCAN_TIMEFRAMES = (process.env.SCAN_TIMEFRAMES || '15m,1h,4h').split(',').map(s => s.trim()).filter(Boolean);
const SCAN_STAGGER_MS = parseInt(process.env.SCAN_STAGGER_MS, 10) || 350;
const AI_SCAN_STAGGER_MS = parseInt(process.env.AI_SCAN_STAGGER_MS, 10) || 1200;
const PAIRS = getQuickSelectPairs();

function targetLabel() {
  return ultimateAI.tradingTargetEnabled
    ? `$${ultimateAI.targetBalance.toFixed(2)}`
    : 'Disabled';
}

function dailyTargetLabel() {
  return ultimateAI.dailyProfitTargetEnabled
    ? `$${ultimateAI.dailyProfitTarget.toFixed(2)}/day`
    : 'Disabled';
}

function dailyTargetSummary(status = ultimateAI.getStatus()) {
  const daily = status.dailyTarget || ultimateAI.getDailyTargetStatus();
  if (!daily.enabled) return 'Disabled';
  const targetBand = daily.mode === 'percent'
    ? `soft ${finiteNumber(daily.softTargetPct).toFixed(1)}% / hard ${finiteNumber(daily.hardTargetPct).toFixed(1)}%`
    : 'fixed USD target';
  return `$${finiteNumber(daily.netPnl).toFixed(2)} / $${finiteNumber(daily.target).toFixed(2)} ` +
    `(${finiteNumber(daily.progress).toFixed(1)}%, ${targetBand}, ${daily.timeZone})`;
}

function aiProviderLabel() {
  const ai = ultimateAI.getAIStatus ? ultimateAI.getAIStatus() : null;
  if (!ai) return 'Not configured';
  const name = ai.provider === 'claude'
    ? 'Claude'
    : ai.provider === 'ensemble'
      ? 'Claude × DeepSeek Ensemble'
    : ai.provider === 'deepseek'
      ? 'DeepSeek'
      : 'Claude + DeepSeek';
  return `${name} · ${ai.model}`;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compactText(value, maxLength = 120) {
  let textValue;
  if (typeof value === 'string') {
    textValue = value;
  } else if (value && typeof value.message === 'string') {
    textValue = value.message;
  } else {
    try {
      textValue = JSON.stringify(value);
    } catch (error) {
      textValue = String(value ?? '');
    }
  }
  // These characters can break Telegram's legacy Markdown parser when they
  // originate in an API error or arbitrary log payload.
  return String(textValue || '')
    .replace(/_/g, ' ')
    .replace(/[*`\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function aiConsensusSummary(result) {
  const review = result?.ensemble;
  if (!review) return `AI: ${aiProviderLabel()}`;

  const vote = item => {
    if (item?.error) return `❌ ${compactText(item.error, 90)}`;
    if (item?.action) return `${item.action} ${finiteNumber(item.confidence)}%`;
    return 'Not configured';
  };
  return `Claude: ${vote(review.claude)} · DeepSeek: ${vote(review.deepseek)} · Final: ${vote(review.final)}`;
}

function officialNewsContext() {
  return '';
}

function executionStatusText(result) {
  if (!result || result.action === 'HOLD') return '';

  if (result.executed) {
    const orderId = compactText(
      result.executionResult?.order?.id || result.executionResult?.trade?.orderId || '',
      80
    );
    return `\n✅ *Execution:* POSITION OPENED${orderId ? ` · Order ${orderId}` : ''}`;
  }

  const reason = compactText(
    result.executionReason ||
      result.executionError ||
      result.executionResult?.error ||
      'The order was not confirmed. Check the terminal log and Bybit Positions before retrying.',
    320
  );
  const label = result.executionBlocked ? 'BLOCKED' : 'FAILED / NOT CONFIRMED';
  return `\n⛔ *Execution:* ${label} — ${reason}`;
}


function leverageApprovalText(result) {
  if (!result || result.action === 'HOLD') return `\n*AI leverage:* Not selected`;
  const requested = finiteNumber(result.leverageApproval?.requestedLeverage || result.recommendedLeverage || result.approvedLeverage);
  if (result.leverageApproved && result.leverage > 0) {
    const downgrade = requested > 0 && requested !== result.leverage
      ? ` · downgraded from ${requested}x by hard risk gate`
      : '';
    return `\n*AI leverage:* ${result.leverage}x APPROVED${downgrade}`;
  }
  const reason = compactText(result.leverageApproval?.reason || result.leverageReason || 'Not approved', 260);
  return `\n*AI leverage:* REJECTED — ${reason}`;
}

function forecastProjectionText(result) {
  const forecast = result?.forecast;
  const projection = result?.tradeProjection;
  let text = '';
  if (forecast?.available) {
    text += `\n*Rough forecast:* ${forecast.direction || 'NEUTRAL'} · ${finiteNumber(forecast.expectedReturnPct).toFixed(2)}% expected over ${forecast.horizonLabel || 'configured horizon'}`;
    text += `\n*Scenario range:* $${finiteNumber(forecast.lowerPrice).toFixed(4)} — $${finiteNumber(forecast.upperPrice).toFixed(4)}`;
  }
  if (projection?.available) {
    text += `\n*TP probability:* ${finiteNumber(projection.tpReachProbabilityPct).toFixed(1)}%`;
    text += `\n*Approx. TP time:* ${projection.tpEtaLabel || 'Not estimated'}`;
    text += `\n*Projected net TP profit:* $${finiteNumber(projection.projectedNetProfit).toFixed(4)}`;
    text += `\n*Projected loss at SL:* $${finiteNumber(projection.projectedLossAtStop).toFixed(4)}`;
    text += `\n*Margin / notional:* $${finiteNumber(projection.marginUsed).toFixed(4)} / $${finiteNumber(projection.notional).toFixed(4)}`;
    text += `\n*Approx. liquidation:* $${finiteNumber(projection.approximateLiquidationPrice).toFixed(4)}`;
  }
  return text;
}

function moneyManagementText(result) {
  const plan = result?.moneyManagement;
  if (!plan) return '';
  return `\n*Risk budget:* ${finiteNumber(plan.riskPercent).toFixed(2)}% ($${finiteNumber(plan.riskAmount).toFixed(4)})` +
    `\n*Position size:* ${finiteNumber(result.positionSize).toFixed(8)} · ${finiteNumber(plan.marginPercent).toFixed(1)}% account margin`;
}

// ==================== CONNECT BYBIT ====================

let apiKey, apiSecret;

if (BYBIT_MODE === 'rw') {
  apiKey = process.env.BYBIT_API_KEY_RW;
  apiSecret = process.env.BYBIT_API_SECRET_RW;
  logger.action('USING_RW_KEYS', {});
} else {
  apiKey = process.env.BYBIT_API_KEY_RO;
  apiSecret = process.env.BYBIT_API_SECRET_RO;
  logger.action('USING_RO_KEYS', {});
}

if (apiKey && apiSecret) {
  const connected = bybit.connect(apiKey, apiSecret, BYBIT_MODE);
  logger.action('BYBIT_CONNECTION', { connected, mode: BYBIT_MODE });
} else {
  logger.error('BYBIT_KEYS_MISSING', 'API keys not found');
}

// ==================== STATE ====================

let autoTradeInterval = null;
let isAutoTrading = false;
let isScanning = false;
let currentCoinIndex = 0;
let autoTradeMsgId = null;
let performanceMsgId = null;
let statusMsgId = null;

// ==================== KEYBOARDS ====================

const mainKeyboard = Markup.keyboard([
  ['🧠 AI Engine'],
  ['📊 Chart', '📈 RSI', '📉 MACD'],
  ['🔮 Forecast', '🤖 AI Signal', '🧠 Full Analysis'],
  ['💰 Balance', '💼 Portfolio'],
  ['📝 Orders', '📌 Positions'],
  ['📡 Connection', '⏱️ Timeframe'],
  ['🚀 Start Auto-Trade', '🛑 Stop Auto-Trade'],
  ['📊 Status', '🏆 Performance'],
  ['📈 Account Statistics', '💵 Daily Target'],
  ['📋 Logs', '🟢 Live Updates'],
  ['🔴 Stop Live', '❓ Help']
]).resize();

const pairRows = [];
for (let index = 0; index < PAIRS.length; index += 3) {
  pairRows.push(PAIRS.slice(index, index + 3));
}
const pairKeyboard = Markup.inlineKeyboard(
  pairRows.map(row => row.map(pair => Markup.button.callback(pair, `pair_${pair.replace('/', '_')}`)))
);

const timeframeKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('1m', 'tf_1m'), Markup.button.callback('5m', 'tf_5m'), Markup.button.callback('15m', 'tf_15m'), Markup.button.callback('30m', 'tf_30m')],
  [Markup.button.callback('1h', 'tf_1h'), Markup.button.callback('4h', 'tf_4h'), Markup.button.callback('1d', 'tf_1d'), Markup.button.callback('1w', 'tf_1w')]
]);

const balanceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'refresh_balance')],
  [Markup.button.callback('💼 Portfolio', 'view_portfolio'), Markup.button.callback('📝 Orders', 'view_orders')]
]);

const actionKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🧠 Run AI approval', 'action_ai_approval'), Markup.button.callback('🔮 Forecast', 'action_forecast')],
  [Markup.button.callback('🔄 Refresh', 'update_chart'), Markup.button.callback('🧠 Full Analysis', 'action_full_analysis')]
]);

const statisticsKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('📅 Daily Statistics', 'stats_daily'),
    Markup.button.callback('🗓️ Week Statistics', 'stats_week')
  ],
  [
    Markup.button.callback('📆 Monthly Statistics', 'stats_month'),
    Markup.button.callback('📊 Year Statistics', 'stats_year')
  ],
  [Markup.button.callback('🔄 Refresh Statistics', 'stats_refresh')]
]);

const telegramCommands = [
  { command: 'start', description: '🏠 Open the main menu' },
  { command: 'ai', description: '🧠 View the AI engine' },
  { command: 'signal', description: '🤖 Generate an AI signal' },
  { command: 'analysis', description: '📊 Run full market analysis' },
  { command: 'forecast', description: '🔮 Generate rough future chart' },
  { command: 'coins', description: '🪙 Show the scan universe' },
  { command: 'balance', description: '💰 View trading balance' },
  { command: 'portfolio', description: '💼 View portfolio' },
  { command: 'positions', description: '📌 View open positions' },
  { command: 'orders', description: '📝 View orders' },
  { command: 'connection', description: '🔌 Check Bybit and AI APIs' },
  { command: 'status', description: '📊 View bot status' },
  { command: 'performance', description: '🏆 View performance' },
  { command: 'statistics', description: '📈 Daily, weekly, monthly and yearly statistics' },
  { command: 'daily', description: '💵 View daily percentage target' }
];

// ==================== PATTERN ZOOM SESSIONS ====================
// Telegram callback_data is capped at 64 bytes, so we can't stuff the full
// candle/indicator payload into a button. Instead each chart message gets a
// short-lived session id; tapping a pattern button looks the session back up,
// crops+redraws just that pattern, and edits the message in place. "Back"
// reverses it using the same session.

const patternSessions = new Map(); // sessionId -> { coin, data, patterns, decision, fullChartPath, caption, extraRows }
let patternSessionCounter = 0;
const PATTERN_SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

function createPatternSession(coin, data, patterns, decision, fullChartPath, caption, extraRows, zooms = []) {
  const id = `${Date.now()}_${patternSessionCounter++}`;
  patternSessions.set(id, {
    coin,
    data,
    patterns,
    decision,
    fullChartPath,
    zooms,
    caption,
    extraRows: extraRows || [],
    createdAt: Date.now()
  });
  return id;
}

setInterval(() => {
  const cutoff = Date.now() - PATTERN_SESSION_TTL_MS;
  for (const [id, session] of patternSessions) {
    if (session.createdAt < cutoff) patternSessions.delete(id);
  }
}, 10 * 60 * 1000);

// `extraRows` lets callers (like the pair_ selector, which already shows
// BUY/SELL/Refresh buttons) keep their own buttons above the pattern buttons.
function buildPatternKeyboard(sessionId, patterns, extraRows, zooms = []) {
  const rows = [...(extraRows || [])];
  const zoomIndexes = new Set(zooms.map(zoom => Number(zoom.index)));
  if (patterns && patterns.length > 0) {
    let row = [];
    patterns.slice(0, 8).forEach((p, idx) => {
      if (!zoomIndexes.has(idx)) return;
      row.push(Markup.button.callback(`🔍 ${p.name}`, `zoom_${sessionId}_${idx}`));
      if (row.length === 2) {
        rows.push(row);
        row = [];
      }
    });
    if (row.length) rows.push(row);
  }
  return rows.length ? Markup.inlineKeyboard(rows) : null;
}

function buildBackKeyboard(sessionId, extraRows) {
  const rows = [...(extraRows || []), [Markup.button.callback('🔙 Back to full chart', `back_${sessionId}`)]];
  return Markup.inlineKeyboard(rows);
}

// Sends the full chart as a document (not a photo) so Telegram doesn't
// recompress it to a lossy JPEG, plus per-pattern "zoom" buttons when
// patterns were detected. `extraKeyboard` (a Markup.inlineKeyboard result)
// is optional and gets merged in above the pattern buttons.
async function sendPatternChart(ctx, coin, data, patterns, decision, chartResult, caption, extraKeyboard) {
  const chartPath = typeof chartResult === 'string' ? chartResult : chartResult?.path;
  const zooms = Array.isArray(chartResult?.zooms) ? chartResult.zooms : [];

  if (!chartPath || !fs.existsSync(chartPath) || fs.statSync(chartPath).size === 0) {
    throw new Error(`Pattern chart was not generated correctly for ${coin}`);
  }

  const fullCaption = String(caption || '');
  const captionNeedsFollowUp = fullCaption.length > 1000;
  const chartCaption = captionNeedsFollowUp
    ? `📊 *${coin} AI chart*\n${aiConsensusSummary(decision)}${officialNewsContext(decision, 1)}\n\nFull cited analysis is in the next message.`
    : fullCaption;
  const extraRows = extraKeyboard?.reply_markup?.inline_keyboard || [];
  const sessionId = createPatternSession(coin, data, patterns, decision, chartPath, chartCaption, extraRows, zooms);
  const keyboard = buildPatternKeyboard(sessionId, patterns, extraRows, zooms);
  const sent = await ctx.replyWithDocument(
    { source: chartPath, filename: `${coin}_chart.png` },
    {
      caption: chartCaption,
      parse_mode: 'Markdown',
      ...(keyboard || {})
    }
  );

  if (captionNeedsFollowUp) {
    if (fullCaption.length <= 4000) {
      await ctx.reply(fullCaption, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true }
      });
    } else {
      await ctx.reply(compactText(fullCaption, 4000), {
        link_preview_options: { is_disabled: true }
      });
    }
  }

  return sent;
}

bot.action(/^zoom_(.+)_(\d+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const patternIndex = parseInt(ctx.match[2], 10);
  const session = patternSessions.get(sessionId);

  if (!session) {
    await ctx.answerCbQuery('⌛ This chart expired. Run the analysis again.');
    return;
  }

  const pattern = session.patterns[patternIndex];
  if (!pattern) {
    await ctx.answerCbQuery('Pattern not found.');
    return;
  }

  await ctx.answerCbQuery(`🔍 Zooming into ${pattern.name}...`);

  try {
    const zoom = session.zooms.find(item => Number(item.index) === patternIndex);
    const zoomedPath = zoom?.path;

    if (!zoomedPath || !fs.existsSync(zoomedPath)) {
      throw new Error(`Zoom image was not generated for ${pattern.name}`);
    }

    await ctx.editMessageMedia(
      {
        type: 'document',
        media: { source: zoomedPath, filename: `${session.coin}_${pattern.name.replace(/\s+/g, '_')}.png` },
        caption: `🔍 *${pattern.name}* — ${session.coin}\nStrength: ${pattern.strength}% • ${pattern.type}`,
        parse_mode: 'Markdown'
      },
      { reply_markup: buildBackKeyboard(sessionId, session.extraRows).reply_markup }
    );
  } catch (err) {
    logger.error('PATTERN_ZOOM', err, { coin: session.coin, pattern: pattern.name });
    await ctx.answerCbQuery('❌ Could not generate zoomed view.');
  }
});

bot.action(/^back_(.+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const session = patternSessions.get(sessionId);

  if (!session) {
    await ctx.answerCbQuery('⌛ This chart expired. Run the analysis again.');
    return;
  }

  await ctx.answerCbQuery('🔙 Back to full chart');

  try {
    await ctx.editMessageMedia(
      {
        type: 'document',
        media: { source: session.fullChartPath, filename: `${session.coin}_chart.png` },
        caption: session.caption,
        parse_mode: 'Markdown'
      },
      { reply_markup: buildPatternKeyboard(sessionId, session.patterns, session.extraRows, session.zooms)?.reply_markup }
    );
  } catch (err) {
    logger.error('PATTERN_BACK', err, { coin: session.coin });
    await ctx.answerCbQuery('❌ Could not restore chart.');
  }
});

// ==================== SESSION ====================

// Telegram can keep an older reply keyboard after the bot is updated. The
// previous source also contained double-encoded emoji bytes, so tapping one
// of those cached buttons sends text such as a double-encoded legacy label.
// Translate only known legacy button labels before Telegraf's hears handlers.
const legacyButtonAliases = new Map([
  ['AI Provider', '🧠 AI Engine'],
  ['Chart', '📊 Chart'],
  ['RSI', '📈 RSI'],
  ['MACD', '📉 MACD'],
  ['AI Signal', '🤖 AI Signal'],
  ['Full Analysis', '🧠 Full Analysis'],
  ['Forecast', '🔮 Forecast'],
  ['Balance', '💰 Balance'],
  ['Portfolio', '💼 Portfolio'],
  ['Orders', '📝 Orders'],
  ['Positions', '📌 Positions'],
  ['WS Status', '📡 Connection'],
  ['Set Timeframe', '⏱️ Timeframe'],
  ['Ultra AI Auto-Trade', '🚀 Start Auto-Trade'],
  ['Stop Auto-Trade', '🛑 Stop Auto-Trade'],
  ['Status', '📊 Status'],
  ['Performance', '🏆 Performance'],
  ['Account Statistics', '📈 Account Statistics'],
  ['Statistics', '📈 Account Statistics'],
  ['Logs', '📋 Logs'],
  ['Live Mode ON', '🟢 Live Updates'],
  ['Stop Live', '🔴 Stop Live'],
  ['Help', '❓ Help']
]);

function normalizeLegacyButtonText(ctx) {
  const text = ctx.message?.text;
  if (typeof text !== 'string') return;

  const looksCorrupted = /Ã|Â|â|ð|Å|�/.test(text);
  for (const [legacyLabel, currentLabel] of legacyButtonAliases) {
    const isKnownOldLabel = text === legacyLabel || text === `🤖 ${legacyLabel}` || text === `⏹️ ${legacyLabel}`;
    if (isKnownOldLabel || (looksCorrupted && text.endsWith(legacyLabel))) {
      ctx.message.text = currentLabel;
      logger.action('LEGACY_BUTTON_NORMALIZED', { from: text, to: currentLabel });
      return;
    }
  }
}

bot.use((ctx, next) => {
  normalizeLegacyButtonText(ctx);
  ctx.session = ctx.session || {};
  ctx.session.timeframe = ctx.session.timeframe || '1h';
  ctx.session.selectedPair = ctx.session.selectedPair || 'BTC/USDT';
  ctx.session.liveMode = ctx.session.liveMode || false;
  ctx.session.liveInterval = ctx.session.liveInterval || null;
  ctx.session.statusMsgId = ctx.session.statusMsgId || null;
  ctx.session.chartMsgId = ctx.session.chartMsgId || null;
  ctx.session.balanceMsgId = ctx.session.balanceMsgId || null;
  ctx.session.portfolioMsgId = ctx.session.portfolioMsgId || null;
  ctx.session.ordersMsgId = ctx.session.ordersMsgId || null;
  return next();
});

// ==================== HELPERS ====================

async function sendOrEdit(ctx, chatId, messageId, text, options = {}) {
  const telegramOptions = { ...options };
  if (telegramOptions.parse_mode === false || telegramOptions.parse_mode === null) {
    delete telegramOptions.parse_mode;
  } else if (!telegramOptions.parse_mode) {
    telegramOptions.parse_mode = 'Markdown';
  }

  try {
    if (messageId) {
      await ctx.telegram.editMessageText(chatId, messageId, null, text, {
        ...telegramOptions
      });
      return messageId;
    } else {
      const sent = await ctx.reply(text, telegramOptions);
      return sent.message_id;
    }
  } catch (error) {
    if (error.message.includes('message is not modified')) {
      return messageId;
    }
    logger.error('SEND_OR_EDIT', error);
    try {
      const plainOptions = { ...telegramOptions };
      delete plainOptions.parse_mode;
      const sent = await ctx.reply(text, plainOptions);
      return sent.message_id;
    } catch (fallbackError) {
      logger.error('SEND_OR_EDIT_FALLBACK', fallbackError);
      throw fallbackError;
    }
  }
}

async function sendOrEditPhoto(ctx, chatId, messageId, photo, caption, options = {}) {
  try {
    if (messageId) {
      await ctx.telegram.editMessageMedia(chatId, messageId, null, {
        type: 'photo',
        media: { source: photo },
        caption: caption,
        parse_mode: 'Markdown'
      });
      return messageId;
    } else {
      const sent = await ctx.replyWithPhoto({ source: photo }, {
        caption: caption,
        parse_mode: 'Markdown',
        ...options
      });
      return sent.message_id;
    }
  } catch (error) {
    logger.error('SEND_OR_EDIT_PHOTO', error);
    const sent = await ctx.replyWithPhoto({ source: photo }, {
      caption: caption,
      parse_mode: 'Markdown',
      ...options
    });
    return sent.message_id;
  }
}

function formatChartCaption(data, pair, tf) {
  return `
📊 *${pair}* - ${tf} Chart

💰 Price: $${data.price.toFixed(2)}
📈 RSI: ${data.rsi.toFixed(2)}
📉 MACD: ${data.macd.toFixed(4)}
📊 Volume: ${data.volume.toFixed(0)}

⏰ ${new Date().toISOString()}
  `;
}

// ==================== BALANCE ====================

async function showBalance(ctx, messageId = null) {
  logger.action('SHOW_BALANCE', { user: ctx.from?.username || ctx.from?.id });
  try {
    const balance = await bybit.getBalance();
    const mode = bybit.getMode ? bybit.getMode().toUpperCase() : 'RO';
    
    let message = `
💎 *BYBIT UNIFIED ACCOUNT*
━━━━━━━━━━━━━━━━━━

💳 *Available to trade:* $${balance.tradableUSD.toFixed(2)}
💰 *Total equity:* $${balance.totalUSD.toFixed(2)}
🪙 *Unified USDT:* $${balance.walletUSDT.toFixed(2)}
🏦 *Funding USDT:* $${balance.fundingUSDT.toFixed(2)}

🤖 *AI:* ${aiProviderLabel()}
🔐 *Trading mode:* ${mode}

*Unified assets*
`;
    if (balance.assets.length === 0) {
      message += `\n• No assets found`;
    } else {
      for (const asset of balance.assets) {
        const usdValue = asset.usdValue || 0;
        message += `• ${asset.asset}: ${asset.total.toFixed(6)} · $${usdValue.toFixed(2)}\n`;
        if (asset.free !== undefined) {
          message += `  Free ${asset.free.toFixed(6)} · Used ${asset.used.toFixed(6)}\n`;
        }
      }
    }

    if (balance.unavailable) {
      message += `\n❌ *Live balance unavailable:* ${balance.error || 'unknown Bybit error'}\n`;
    } else if (balance.tradableUSD < 0.01 && balance.fundingUSDT >= 0.01) {
      message += `\n⚠️ Your USDT is in Funding. Transfer *Funding → Unified Trading* before starting auto-trade.\n`;
    } else if (balance.fundingError) {
      message += `\n⚠️ Funding wallet could not be checked: ${balance.fundingError}\n`;
    }
    
    message += `\n${bybit.isConnected ? '🟢 Live Bybit data' : '🔴 Bybit disconnected'}\n🕒 ${new Date().toISOString()}`;
    
    const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.balanceMsgId, message, balanceKeyboard);
    ctx.session.balanceMsgId = newId;
    return newId;
  } catch (error) {
    logger.error('SHOW_BALANCE', error);
    const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.balanceMsgId, `❌ Balance error: ${error.message}`);
    ctx.session.balanceMsgId = newId;
    return newId;
  }
}

// ==================== PORTFOLIO ====================

async function showPortfolio(ctx, messageId = null) {
  logger.action('SHOW_PORTFOLIO', { user: ctx.from?.username || ctx.from?.id });
  try {
    const [portfolio, balance] = await Promise.all([
      bybit.getPortfolio(),
      bybit.getBalance()
    ]);
    const mode = bybit.getMode ? bybit.getMode().toUpperCase() : 'RO';
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const totalValue = finiteNumber(portfolio?.totalValue, finiteNumber(balance?.totalUSD));
    const availableToTrade = finiteNumber(portfolio?.availableToTrade, finiteNumber(balance?.tradableUSD));
    const maxPositions = finiteNumber(ultimateAI.maxPositions, 1);
    
    let message = `
💼 *BYBIT PORTFOLIO*
━━━━━━━━━━━━━━━━━━

💰 *Total equity:* $${totalValue.toFixed(2)}
💳 *Available to trade:* $${availableToTrade.toFixed(2)}
📌 *Open positions:* ${positions.length}/${maxPositions}
🔐 *Trading mode:* ${mode}

*Positions*
`;
    if (positions.length === 0) {
      message += `\n• No open positions`;
    } else {
      for (const pos of positions.slice(0, 10)) {
        const isFutures = pos?.size !== undefined || pos?.entryPrice !== undefined;
        if (isFutures) {
          const coin = compactText(pos.coin || String(pos.symbol || '').split('/')[0] || 'Unknown', 20);
          const side = String(pos.side || 'unknown').toUpperCase();
          const pnl = finiteNumber(pos.unrealizedPnl);
          const pnlPercent = finiteNumber(pos.percentage);
          const direction = side === 'LONG' ? '🟢' : side === 'SHORT' ? '🔴' : '⚪';
          message += `\n${direction} *${coin} ${side}* · ${finiteNumber(pos.size).toFixed(6)}\n`;
          message += `   Entry $${finiteNumber(pos.entryPrice).toFixed(4)} · Mark $${finiteNumber(pos.markPrice).toFixed(4)}\n`;
          message += `   PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%) · ${finiteNumber(pos.leverage, 1)}x\n`;
        } else {
          const change = finiteNumber(pos.change24h);
          const emoji = change >= 0 ? '🟢' : '🔴';
          message += `\n${emoji} *${compactText(pos.symbol || 'Asset', 24)}* · ${finiteNumber(pos.amount).toFixed(6)}\n`;
          message += `   Value $${finiteNumber(pos.value).toFixed(2)} · 24h ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n`;
        }
      }
    }
    
    if (balance?.unavailable) {
      message += `\n❌ Bybit balance unavailable: ${compactText(balance.error, 140)}`;
    }
    message += `\n${bybit.isConnected ? '🟢 Live Bybit data' : '🔴 Bybit disconnected'}`;
    message += `\n🕒 ${new Date().toISOString()}`;
    
    const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.portfolioMsgId, message, balanceKeyboard);
    ctx.session.portfolioMsgId = newId;
    return newId;
  } catch (error) {
    logger.error('SHOW_PORTFOLIO', error);
    const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.portfolioMsgId, `❌ Error: ${error.message}`);
    ctx.session.portfolioMsgId = newId;
    return newId;
  }
}

// ==================== ORDERS ====================

async function showOrders(ctx, messageId = null) {
  logger.action('SHOW_ORDERS', { user: ctx.from?.username || ctx.from?.id });
  try {
    const orders = await bybit.getOrders(null, 20);
    const mode = bybit.getMode ? bybit.getMode().toUpperCase() : 'RO';
    
    if (orders.length === 0) {
      const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.ordersMsgId, `📝 No orders found\n🔑 Mode: ${mode}`);
      ctx.session.ordersMsgId = newId;
      return newId;
    }
    
    let message = `
📝 BYBIT ORDERS - ${new Date().toISOString()}
🔑 Mode: ${mode}

`;
    const openOrders = orders.filter(o => o.status === 'open');
    const closedOrders = orders.filter(o => o.status === 'closed');
    
    if (openOrders.length > 0) {
      message += `⏳ Open Orders (${openOrders.length}):\n`;
      for (const order of openOrders.slice(0, 5)) {
        message += `• ${order.symbol} ${order.side.toUpperCase()} ${order.amount} @ $${order.price?.toFixed(2) || 'market'}\n`;
        message += `  Fill: ${order.filled}/${order.amount} | ${new Date(order.timestamp).toLocaleString()}\n`;
      }
      message += '\n';
    }
    
    if (closedOrders.length > 0) {
      message += `✅ Closed Orders (${closedOrders.length}):\n`;
      for (const order of closedOrders.slice(0, 10)) {
        message += `• ${order.symbol} ${order.side.toUpperCase()} ${order.amount} @ $${order.price?.toFixed(2) || 'market'}\n`;
        message += `  ${new Date(order.timestamp).toLocaleString()}\n`;
      }
    }
    
    if (orders.length > 20) {
      message += `\n... and ${orders.length - 20} more orders`;
    }
    
    message += `\n${bybit.isConnected ? '✅ Live Bybit Data' : '⚠️ Mock Data'}`;
    
    const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.ordersMsgId, message);
    ctx.session.ordersMsgId = newId;
    return newId;
  } catch (error) {
    logger.error('SHOW_ORDERS', error);
    const newId = await sendOrEdit(ctx, ctx.chat.id, messageId || ctx.session.ordersMsgId, `❌ Error: ${error.message}`);
    ctx.session.ordersMsgId = newId;
    return newId;
  }
}

// ==================== POSITIONS ====================

async function showPositions(ctx) {
  logger.action('SHOW_POSITIONS', { user: ctx.from?.username || ctx.from?.id });
  
  const positions = await orderManager.getOpenPositions();
  
  if (positions.length === 0) {
    await sendOrEdit(ctx, ctx.chat.id, null, '📊 No open positions');
    return;
  }
  
  let message = '📊 OPEN POSITIONS\n\n';
  for (const pos of positions) {
    const pnl = await orderManager.getPositionPnL(pos.coin);
    message += `${pos.coin} ${pos.side.toUpperCase()}\n`;
    message += `  Size: ${pos.size.toFixed(6)}\n`;
    message += `  Entry: $${pos.entryPrice.toFixed(2)}\n`;
    if (pnl) {
      message += `  Current: $${pnl.currentPrice.toFixed(2)}\n`;
      message += `  PnL: ${pnl.pnlPercent >= 0 ? '+' : ''}${pnl.pnlPercent.toFixed(2)}% ($${pnl.pnl.toFixed(2)})\n`;
    }
    message += '\n';
  }
  
  await sendOrEdit(ctx, ctx.chat.id, null, message);
}

async function showAIStatus(ctx) {
  const ai = ultimateAI.getAIStatus();
  const providerName = ai.provider === 'claude'
    ? 'Claude'
    : ai.provider === 'ensemble'
      ? 'Claude × DeepSeek Ensemble'
    : ai.provider === 'deepseek'
      ? 'DeepSeek'
      : 'Claude + DeepSeek';
  const last = ai.ensemble;
  const reviewItem = item => {
    if (item?.error) return `❌ ${compactText(item.error, 120)}`;
    if (item?.action) return `${item.action} (${finiteNumber(item.confidence)}%)`;
    return 'Not checked';
  };
  const ensembleState = last?.status === 'blocked-incomplete'
    ? 'Incomplete — execution blocked'
    : last?.technicalAgreement === true
      ? 'Providers agree'
      : last?.technicalAgreement === false
        ? 'Providers differ — judge resolved it'
        : 'Not fully checked';
  const ensembleResult = last
    ? `
*Last ensemble review*
• Claude: ${reviewItem(last.claude)}
• DeepSeek: ${reviewItem(last.deepseek)}
• Final: ${reviewItem(last.final)}
• Ensemble state: ${ensembleState}
`
    : '';

  const message = `
🧠 *AI ANALYSIS ENGINE*
━━━━━━━━━━━━━━━━━━

${ai.ready ? '🟢' : '🔴'} *Status:* ${ai.ready ? 'Ready' : 'Setup required'}
✨ *Provider:* ${providerName}
⚙️ *Model:* ${ai.model}
🎯 *Decision mode:* AI chooses BUY / SELL / HOLD
⚖️ *Pipeline:* ${ai.provider === 'ensemble' ? 'Claude + DeepSeek independent reviews → final AI judge' : 'Single AI provider'}
🛡️ *Complete ensemble required:* ${ai.requireCompleteEnsemble && !ai.allowPartialEnsemble ? 'Yes — partial results are HOLD' : 'No'}
🔌 *Claude transport:* ${ai.claudeApiMode || 'direct'}
📊 *Confidence gate:* ${ultimateAI.minimumExecutionConfidence > 0 ? `${ultimateAI.minimumExecutionConfidence}%` : 'Disabled — AI decision used directly'}
🧩 *Patterns:* Context only, never a manual requirement

${ai.setupHint}
${ensembleResult}

To use the mixed analysis:
\`AI_PROVIDER=ensemble\`
\`ANTHROPIC_API_KEY=your_key\`
\`DEEPSEEK_API_KEY=your_key\`
\`CLAUDE_MODEL=claude-sonnet-5\`
\`DEEPSEEK_MODEL=deepseek-v4-pro\`
\`ENSEMBLE_JUDGE=claude\` # or deepseek
\`REQUIRE_COMPLETE_ENSEMBLE=true\`
\`CLAUDE_API_MODE=direct\`
  `;

  await sendOrEdit(ctx, ctx.chat.id, null, message);
}

// ==================== COMMANDS ====================

bot.command("start", async (ctx) => {
  logger.command('START', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await ultimateAI.syncDailyPnl();
  const status = ultimateAI.getStatus();
  const mode = bybit.getMode ? bybit.getMode().toUpperCase() : 'RO';
  const ai = ultimateAI.getAIStatus();
  
  await ctx.reply(`
🚀 *ULTIMATE AI TRADER*
━━━━━━━━━━━━━━━━━━

🧠 *AI:* ${aiProviderLabel()}
${ai.ready ? '🟢 Ready' : '🔴 Setup required'}

💳 *Available balance:* $${status.balance?.toFixed(2) || '0.00'}
🔐 *Bybit mode:* ${mode}
🎯 *Daily target:* ${dailyTargetSummary(status)}
🏁 *Balance target:* ${targetLabel()}
📈 *Win rate:* ${status.winRate?.toFixed(1) || 0}%

⚡ USDT perpetual execution
📊 Multi-timeframe market analysis
🛡️ Exchange-side stop-loss and take-profit

Choose an action below 👇
  `, { parse_mode: 'Markdown', ...mainKeyboard });
});

bot.command("ai", async (ctx) => {
  logger.command('AI_STATUS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showAIStatus(ctx);
});

bot.command("balance", async (ctx) => {
  logger.command('BALANCE', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showBalance(ctx);
});

bot.command("portfolio", async (ctx) => {
  logger.command('PORTFOLIO', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showPortfolio(ctx);
});

bot.command("orders", async (ctx) => {
  logger.command('ORDERS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showOrders(ctx);
});

bot.command("positions", async (ctx) => {
  logger.command('POSITIONS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showPositions(ctx);
});

bot.command("close", async (ctx) => {
  const args = ctx.message.text.split(" ");
  const coin = args[1]?.toUpperCase();
  
  if (!coin) {
    await sendOrEdit(ctx, ctx.chat.id, null, 'Usage: /close COIN\nExample: /close BTC');
    return;
  }
  
  logger.command('CLOSE', ctx.from?.username || ctx.from?.id, { coin });
  
  const result = await orderManager.closePosition(coin);
  
  if (result.success) {
    await sendOrEdit(ctx, ctx.chat.id, null, `✅ Position ${coin} closed at $${result.order.price.toFixed(2)}`);
  } else {
    await sendOrEdit(ctx, ctx.chat.id, null, `❌ Failed to close ${coin}: ${result.error}`);
  }
});

async function handleStatus(ctx) {
  logger.command('STATUS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await ultimateAI.syncDailyPnl();
  
  const openPositions = await orderManager.getOpenPositions();
  const status = ultimateAI.getStatus();
  const stats = db.getStats();
  
  let positionsText = '';
  if (openPositions.length === 0) {
    positionsText = 'No open positions';
  } else {
    for (const pos of openPositions) {
      const pnl = await orderManager.getPositionPnL(pos.coin);
      positionsText += `\n• ${pos.coin} ${pos.side.toUpperCase()} | ${pos.size.toFixed(6)} @ $${pos.entryPrice.toFixed(2)}`;
      if (pnl) {
        positionsText += ` | PnL: ${pnl.pnlPercent >= 0 ? '+' : ''}${pnl.pnlPercent.toFixed(2)}%`;
      }
    }
  }
  
  const message = `
📊 BOT STATUS

⏱️ Timeframe: ${ctx.session.timeframe || '1h'}
🤖 Auto-Trade: ${isAutoTrading ? 'ACTIVE' : 'INACTIVE'}
🔑 Mode: ${bybit.getMode ? bybit.getMode().toUpperCase() : 'RO'}

📈 ULTRA AI:
• Provider: ${aiProviderLabel()} ${status.aiReady ? '🟢' : '🔴'}
• Balance: $${status.balance?.toFixed(2) || 'N/A'}
• Daily Target: ${dailyTargetSummary(status)}
• Daily Remaining: $${finiteNumber(status.dailyTarget?.remaining).toFixed(2)}
• Balance Target: ${targetLabel()}
• Balance Progress: ${status.progress?.toFixed(1) || 0}%
• Win Rate: ${status.winRate?.toFixed(1) || 0}%
• Trades Today: ${status.tradesToday || 0}/${ultimateAI.maxTradesPerDay > 0 ? ultimateAI.maxTradesPerDay : 'Unlimited'}

📊 TRADING:
• Total Trades: ${stats.totalTrades || 0}
• Total PnL: $${stats.totalPnl?.toFixed(2) || '0.00'}
• Open Positions: ${openPositions.length}/${ultimateAI.maxPositions}
${positionsText}

📋 Commands:
/balance - View balance
/ai - View AI provider
/portfolio - View portfolio
/performance - Trading performance
/positions - View open positions
/close COIN - Close position
  `;
  
  statusMsgId = await sendOrEdit(ctx, ctx.chat.id, statusMsgId, message);
}

async function handlePerformance(ctx) {
  logger.command('PERFORMANCE', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await ultimateAI.syncDailyPnl();
  const status = ultimateAI.getStatus();
  const perf = ultimateAI.performance;
  const stats = db.getStats();
  
  const message = `
📊 ULTRA AI PERFORMANCE

💰 Balance: $${status.balance?.toFixed(2) || 'N/A'}
🎯 Daily Target: ${dailyTargetSummary(status)}
💵 Daily Remaining: $${finiteNumber(status.dailyTarget?.remaining).toFixed(2)}
📅 Daily Closed Records: ${finiteNumber(status.dailyTarget?.recordCount)}
🏁 Balance Target: ${targetLabel()}
📈 Balance Progress: ${status.progress?.toFixed(1) || 0}%

📊 Trading Stats:
• Total Trades: ${stats.totalTrades || perf.totalTrades || 0}
• Win Rate: ${stats.winRate?.toFixed(1) || perf.winRate?.toFixed(1) || 0}%
• Wins: ${stats.winningTrades || perf.winningTrades || 0}
• Losses: ${stats.losingTrades || perf.losingTrades || 0}
• Profit factor: ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}

📈 PnL:
• Total: $${finiteNumber(stats.totalPnl, perf.totalPnL).toFixed(2)}
• Largest Win: $${finiteNumber(stats.largestWin, perf.largestWin).toFixed(2)}
• Largest Loss: $${finiteNumber(stats.largestLoss, perf.largestLoss).toFixed(2)}
• Average Win: $${finiteNumber(stats.averageWin, perf.averageWin).toFixed(2)}
• Average Loss: $${finiteNumber(stats.averageLoss, perf.averageLoss).toFixed(2)}

🔑 Mode: ${status.mode?.toUpperCase() || 'RO'}
🔄 Trading: ${status.isTrading ? '🟢 Active' : '🔴 Idle'}
  `;
  
  performanceMsgId = await sendOrEdit(ctx, ctx.chat.id, performanceMsgId, message);
}

async function handleDailyTarget(ctx) {
  logger.command('DAILY_TARGET', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  const daily = await ultimateAI.syncDailyPnl({ force: true });
  const state = daily.reached ? 'REACHED — new entries paused' : 'ACTIVE';
  const errorLine = daily.error ? `\n⚠️ Sync warning: ${compactText(daily.error, 180)}` : '';

  await sendOrEdit(ctx, ctx.chat.id, null, `💵 DAILY PROFIT TARGET

Status: ${state}
Net realized PnL: $${finiteNumber(daily.netPnl).toFixed(2)}
Opening equity: $${finiteNumber(daily.openingEquity).toFixed(2)}
Soft target (${finiteNumber(daily.softTargetPct).toFixed(1)}%): $${finiteNumber(daily.softTarget).toFixed(2)} ${daily.softReached ? '— reached' : ''}
Hard target (${finiteNumber(daily.hardTargetPct).toFixed(1)}%): $${finiteNumber(daily.target).toFixed(2)}
Remaining: $${finiteNumber(daily.remaining).toFixed(2)}
Progress: ${finiteNumber(daily.progress).toFixed(1)}%
Gross profit: $${finiteNumber(daily.grossProfit).toFixed(2)}
Gross loss: $${finiteNumber(daily.grossLoss).toFixed(2)}
Closed records: ${finiteNumber(daily.recordCount)}
Trading day: ${daily.dayKey} (${daily.timeZone})
Source: ${daily.source}${errorLine}

The target is a stop condition, not a guaranteed return. The bot will not force weak trades to chase it.`, { parse_mode: false });
}

bot.command('daily', handleDailyTarget);
bot.hears('💵 Daily Target', handleDailyTarget);

function formatStatsDate(value, period = 'daily') {
  const text = String(value || '');
  if (period === 'daily' && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-');
    return `${day}/${month}/${year}`;
  }
  if (period === 'month' && /^\d{4}-\d{2}$/.test(text)) {
    const [year, month] = text.split('-');
    return `${month}/${year}`;
  }
  if (period === 'week' && text.includes(' — ')) {
    return text.split(' — ').map(item => formatStatsDate(item, 'daily')).join(' — ');
  }
  return text;
}

function signedPercent(value) {
  const numeric = finiteNumber(value);
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}%`;
}

function signedMoney(value) {
  const numeric = finiteNumber(value);
  return `${numeric >= 0 ? '+' : '-'}$${Math.abs(numeric).toFixed(4)}`;
}

function statisticsTitle(period) {
  return ({
    daily: '📅 DAILY STATISTICS',
    week: '🗓️ WEEK STATISTICS',
    month: '📆 MONTHLY STATISTICS',
    year: '📊 YEAR STATISTICS'
  })[period] || '📈 ACCOUNT STATISTICS';
}

function buildStatisticsMessage(result, syncWarning = '') {
  const period = result?.period || 'daily';
  const availability = result?.availability || {};
  let message = `${statisticsTitle(period)}\n`;
  message += '━━━━━━━━━━━━━━━━━━\n';

  if (!availability.available) {
    const periodName = ({ week: 'Weekly', month: 'Monthly', year: 'Yearly' })[period] || 'This';
    message += `🔒 ${periodName} statistics opens after ${availability.remainingDays} day${availability.remainingDays === 1 ? '' : 's'}.\n`;
    message += `Tracking started: ${formatStatsDate(availability.firstDate, 'daily')}\n`;
    message += `Available history: ${availability.availableDays || 0}/${availability.requiredDays || 0} days\n`;
    if (syncWarning) message += `\n⚠️ ${syncWarning}`;
    return message;
  }

  const current = result.current;
  if (!current) {
    message += 'No account statistics have been recorded yet.';
    if (syncWarning) message += `\n\n⚠️ ${syncWarning}`;
    return message;
  }

  message += `Current period: ${formatStatsDate(current.label, period)} • ${signedPercent(current.returnPct)}\n`;
  message += `Realized PnL: ${signedMoney(current.realizedPnl)}\n`;
  message += `Trades: ${current.trades} • Wins: ${current.wins} • Losses: ${current.losses}\n`;
  message += `Win rate: ${finiteNumber(current.winRate).toFixed(1)}%\n`;
  message += `Opening equity: $${finiteNumber(current.openingEquity).toFixed(2)}\n`;
  message += `Latest/closing equity: $${finiteNumber(current.latestEquity ?? current.closingEquity).toFixed(2)}\n`;
  message += `Timezone: ${result.timeZone || accountStatistics.timeZone}\n`;
  message += '\nHistory\n';

  for (const row of (result.rows || []).slice(0, 18)) {
    message += `${formatStatsDate(row.label, period)} • ${signedPercent(row.returnPct)} • ${signedMoney(row.realizedPnl)} • ${row.trades} trade${row.trades === 1 ? '' : 's'}\n`;
  }

  if (result.note) {
    message += `\nℹ️ ${result.note}`;
  }
  if (syncWarning) message += `\n⚠️ ${syncWarning}`;
  return message.trim();
}

async function handleStatistics(ctx, period = 'daily', options = {}) {
  ctx.session = ctx.session || {};
  ctx.session.statisticsPeriod = period;
  logger.command('ACCOUNT_STATISTICS', ctx.from?.username || ctx.from?.id, { period, chatId: ctx.chat?.id });
  let syncWarning = '';
  try {
    await accountStatistics.sync({ force: Boolean(options.force) });
  } catch (error) {
    syncWarning = `Live synchronization failed: ${compactText(error.message, 180)}. Showing saved data when available.`;
    logger.error('ACCOUNT_STATISTICS_SYNC', error, { period });
  }

  const result = accountStatistics.get(period);
  const message = buildStatisticsMessage(result, syncWarning);
  const replyOptions = { ...statisticsKeyboard };

  if (ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery('Statistics updated');
    } catch (_error) {}
    try {
      await ctx.editMessageText(message, replyOptions);
      return;
    } catch (error) {
      if (!String(error.message || '').includes('message is not modified')) {
        logger.error('ACCOUNT_STATISTICS_EDIT', error, { period });
      }
    }
  }

  await ctx.reply(message, replyOptions);
}

bot.command('statistics', ctx => handleStatistics(ctx, 'daily', { force: true }));
bot.hears('📈 Account Statistics', ctx => handleStatistics(ctx, 'daily', { force: true }));
bot.action('stats_daily', ctx => handleStatistics(ctx, 'daily'));
bot.action('stats_week', ctx => handleStatistics(ctx, 'week'));
bot.action('stats_month', ctx => handleStatistics(ctx, 'month'));
bot.action('stats_year', ctx => handleStatistics(ctx, 'year'));
bot.action('stats_refresh', ctx => handleStatistics(ctx, ctx.session?.statisticsPeriod || 'daily', { force: true }));

async function handleLogs(ctx) {
  logger.command('LOGS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });

  try {
    const logs = logger.getTodayLogs?.() || {};
    const errors = logger.getErrors?.(5) || [];
    const recentSteps = logger.getRecentSteps?.(10) || [];
    const perf = logger.getPerformance?.() || [];
    const lastPerf = perf[perf.length - 1] || {};

    let message = `
📋 ACTIVITY LOG
━━━━━━━━━━━━━━━━━━

📊 Today
• Steps: ${finiteNumber(logs.ALL)}
• Bot actions: ${finiteNumber(logs.BOT)}
• Trades: ${finiteNumber(logs.TRADES)}
• AI decisions: ${finiteNumber(logs.AI)}
• Scans: ${finiteNumber(logs.SCANS)}
• Errors: ${finiteNumber(logs.ERRORS)}

📈 Latest performance
• Balance: ${lastPerf.balance == null ? 'N/A' : `$${finiteNumber(lastPerf.balance).toFixed(2)}`}
• PnL: $${finiteNumber(lastPerf.totalPnL).toFixed(2)}
• Win rate: ${finiteNumber(lastPerf.winRate).toFixed(1)}%

📝 Recent activity`;

    if (recentSteps.length === 0) {
      message += `\n• No activity recorded yet`;
    } else {
      for (const step of recentSteps.slice(-5)) {
        const label = compactText(step?.step || step?.action || 'EVENT', 30);
        const detail = compactText(step?.data ?? step, 90);
        message += `\n• ${label}${detail ? ` — ${detail}` : ''}`;
      }
    }

    if (errors.length > 0) {
      message += `\n\n⚠️ Recent errors`;
      for (const errorEntry of errors.slice(-3)) {
        message += `\n• ${compactText(errorEntry?.module || 'ERROR', 30)} — ${compactText(errorEntry?.error || errorEntry, 120)}`;
      }
    }

    message += `\n\n🕒 ${new Date().toISOString()}`;
    await sendOrEdit(ctx, ctx.chat.id, null, message, { parse_mode: false });
  } catch (error) {
    logger.error('SHOW_LOGS', error);
    await sendOrEdit(ctx, ctx.chat.id, null, `❌ Logs error: ${compactText(error.message, 180)}`, { parse_mode: false });
  }
}

async function handleConnection(ctx) {
  logger.command('CONNECTION', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  const loadingId = await sendOrEdit(
    ctx,
    ctx.chat.id,
    null,
    '🔄 Checking Bybit, Claude and DeepSeek...',
    { parse_mode: false }
  );

  try {
    const [bybitHealth, aiHealth] = await Promise.all([
      bybit.getConnectionHealth ? bybit.getConnectionHealth(true) : Promise.resolve({
        configured: Boolean(bybit.exchange),
        connected: Boolean(bybit.isConnected),
        mode: bybit.getMode ? bybit.getMode() : 'ro',
        marketType: bybit.marketType || 'swap',
        error: bybit.connectionError || null
      }),
      ultimateAI.checkAIConnections ? ultimateAI.checkAIConnections() : Promise.resolve({
        claude: { ok: Boolean(process.env.ANTHROPIC_API_KEY), error: null },
        deepseek: { ok: Boolean(process.env.DEEPSEEK_API_KEY), error: null }
      })
    ]);
    const positions = bybitHealth?.connected && bybit.getPositions
      ? await bybit.getPositions()
      : [];

    const providerLine = (name, model, health) => {
      const icon = health?.ok ? '🟢' : '🔴';
      const latency = Number.isFinite(Number(health?.latencyMs)) ? ` · ${health.latencyMs}ms` : '';
      const detail = health?.ok
        ? `${model}${latency}`
        : compactText(health?.error || 'Not configured', 160);
      return `${icon} ${name}: ${detail}`;
    };

    const safePositions = Array.isArray(positions) ? positions : [];
    const maxPositions = finiteNumber(ultimateAI.maxPositions, 1);
    const bybitIcon = bybitHealth?.connected ? '🟢' : '🔴';
    const bybitDetail = bybitHealth?.connected
      ? `${String(bybitHealth.marketType || 'swap').toUpperCase()} · ${String(bybitHealth.mode || 'ro').toUpperCase()}${Number.isFinite(Number(bybitHealth.latencyMs)) ? ` · ${bybitHealth.latencyMs}ms` : ''}`
      : compactText(bybitHealth?.error || 'Not connected', 160);

    let message = `
🔌 CONNECTION STATUS
━━━━━━━━━━━━━━━━━━

${bybitIcon} Bybit: ${bybitDetail}
${providerLine('Claude', ultimateAI.claudeModel, aiHealth?.claude)}
${providerLine('DeepSeek', ultimateAI.deepseekModel, aiHealth?.deepseek)}

📌 Open positions: ${safePositions.length}/${maxPositions}`;

    for (const position of safePositions.slice(0, 8)) {
      const coin = compactText(position?.coin || String(position?.symbol || '').split('/')[0] || 'Unknown', 20);
      const side = String(position?.side || 'unknown').toUpperCase();
      message += `\n• ${coin} ${side} · ${finiteNumber(position?.size).toFixed(6)}`;
    }

    message += `\n\n🕒 ${new Date().toISOString()}`;
    await sendOrEdit(ctx, ctx.chat.id, loadingId, message, { parse_mode: false });
  } catch (error) {
    logger.error('CONNECTION_STATUS', error);
    await sendOrEdit(
      ctx,
      ctx.chat.id,
      loadingId,
      `❌ Connection check failed: ${compactText(error.message, 200)}`,
      { parse_mode: false }
    );
  }
}

bot.command("status", handleStatus);
bot.command("performance", handlePerformance);
bot.command("logs", handleLogs);
bot.command("connection", handleConnection);
bot.command("wsstatus", handleConnection);

// ==================== BUTTON HANDLERS ====================

bot.hears('🧠 AI Engine', async (ctx) => {
  logger.button('AI_PROVIDER', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showAIStatus(ctx);
});

bot.hears('📊 Chart', async (ctx) => {
  logger.button('CHART', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await ctx.reply('Select a trading pair:', pairKeyboard);
});

bot.hears('🔮 Forecast', async (ctx) => {
  logger.button('FORECAST', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleForecast(ctx);
});

bot.hears('📈 RSI', async (ctx) => {
  logger.button('RSI', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleRsi(ctx);
});

bot.hears('📉 MACD', async (ctx) => {
  logger.button('MACD', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleMacd(ctx);
});

bot.hears('🤖 AI Signal', async (ctx) => {
  logger.button('AI_SIGNAL', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleSignal(ctx);
});

bot.hears('🧠 Full Analysis', async (ctx) => {
  logger.button('FULL_ANALYSIS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleAnalysis(ctx);
});

bot.hears('💰 Balance', async (ctx) => {
  logger.button('BALANCE', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showBalance(ctx);
});

bot.hears('💼 Portfolio', async (ctx) => {
  logger.button('PORTFOLIO', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showPortfolio(ctx);
});

bot.hears('📝 Orders', async (ctx) => {
  logger.button('ORDERS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showOrders(ctx);
});

bot.hears('📌 Positions', async (ctx) => {
  logger.button('POSITIONS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await showPositions(ctx);
});

bot.hears('📊 Status', async (ctx) => {
  logger.button('STATUS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleStatus(ctx);
});

bot.hears('🏆 Performance', async (ctx) => {
  logger.button('PERFORMANCE', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handlePerformance(ctx);
});

bot.hears('📋 Logs', async (ctx) => {
  logger.button('LOGS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleLogs(ctx);
});

bot.hears('📡 Connection', async (ctx) => {
  logger.button('WS_STATUS', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await handleConnection(ctx);
});

bot.hears('⏱️ Timeframe', async (ctx) => {
  logger.button('SET_TIMEFRAME', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  const current = ctx.session.timeframe || '1h';
  await ctx.reply(`⏱️ Current Timeframe: ${current}\n\nSelect new timeframe:`, {
    parse_mode: 'Markdown',
    ...timeframeKeyboard
  });
});

function startBackgroundMarketScan(ctx, trigger) {
  setImmediate(() => {
    runFullMarketScan(ctx).catch(async (error) => {
      logger.error('BACKGROUND_MARKET_SCAN', error, { trigger });
      try {
        await sendOrEdit(
          ctx,
          ctx.chat.id,
          autoTradeMsgId,
          `❌ Background scan failed: ${compactText(error.message, 180)}`,
          { parse_mode: false }
        );
      } catch (notificationError) {
        logger.error('BACKGROUND_SCAN_NOTIFICATION', notificationError);
      }
    });
  });
}

bot.hears('🚀 Start Auto-Trade', async (ctx) => {
  logger.button('ULTRA_AI_AUTO_TRADE', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  
  const mode = bybit.getMode ? bybit.getMode() : 'ro';
  if (mode === 'ro') {
    await sendOrEdit(ctx, ctx.chat.id, null, '❌ READ-ONLY MODE\n\nAuto-trading requires READ-WRITE keys.\n\nSet BYBIT_MODE=rw in .env');
    return;
  }

  if (isAutoTrading) {
    await sendOrEdit(ctx, ctx.chat.id, null, '⚠️ Auto-Trade is already active!');
    return;
  }

  const status = ultimateAI.getStatus();
  
  await sendOrEdit(ctx, ctx.chat.id, null, `
🤖 ULTRA AI AUTO-TRADE ACTIVATED

🧠 Ultra AI Trading System
• Scanning: ${AUTO_TRADE_COINS.join(', ')} (all ${AUTO_TRADE_COINS.length} coins every sweep)
• Timeframes: ${SCAN_TIMEFRAMES.join(', ')}
• Sweep interval: Every ${Math.round(AUTO_TRADE_INTERVAL / 1000)}s
• Risk: 1.2% per trade
• Max Positions: ${ultimateAI.maxPositions}
• Execution Confidence: ${ultimateAI.minimumExecutionConfidence > 0 ? `${ultimateAI.minimumExecutionConfidence}%` : 'AI decides (no manual confidence gate)'}
• Patterns: AI context only (no manual requirement)

📊 Target: $${status.balance?.toFixed(2) || '0.00'} → ${targetLabel()}
📈 Progress: ${status.progress?.toFixed(1) || 0}%

🔄 First sweep starting now...
  `);

  isAutoTrading = true;
  currentCoinIndex = 0;

  // A full Claude + DeepSeek dual-AI sweep can legitimately exceed Telegram's
  // middleware timeout. Acknowledge the button immediately and let the scan
  // continue independently; isScanning prevents overlapping sweeps.
  autoTradeInterval = setInterval(() => {
    if (!isAutoTrading) {
      clearInterval(autoTradeInterval);
      autoTradeInterval = null;
      return;
    }
    startBackgroundMarketScan(ctx, 'interval');
  }, AUTO_TRADE_INTERVAL);

  startBackgroundMarketScan(ctx, 'button');
});

bot.hears('🛑 Stop Auto-Trade', async (ctx) => {
  logger.button('STOP_AUTO_TRADE', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  isAutoTrading = false;
  if (autoTradeInterval) {
    clearInterval(autoTradeInterval);
    autoTradeInterval = null;
  }
  
  await sendOrEdit(ctx, ctx.chat.id, null, `
⏹️ AUTO-TRADE DEACTIVATED

📊 Active trades will remain open.
🔔 You will still receive notifications.

To reactivate: press "🚀 Start Auto-Trade"
  `);
});

bot.hears('🟢 Live Updates', async (ctx) => {
  logger.button('LIVE_MODE_ON', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  ctx.session.liveMode = true;
  await ctx.reply('🟢 LIVE MODE ACTIVATED\n\nAuto-updates every 30 seconds!', { parse_mode: 'Markdown' });
  startLiveUpdates(ctx);
});

bot.hears('🔴 Stop Live', async (ctx) => {
  logger.button('LIVE_MODE_OFF', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  ctx.session.liveMode = false;
  if (ctx.session.liveInterval) {
    clearInterval(ctx.session.liveInterval);
    ctx.session.liveInterval = null;
  }
  await ctx.reply('🔴 LIVE MODE DEACTIVATED', { parse_mode: 'Markdown' });
});

bot.hears('❓ Help', async (ctx) => {
  logger.button('HELP', ctx.from?.username || ctx.from?.id, { chatId: ctx.chat.id });
  await ctx.reply(`
📚 *TRADER COMMAND CENTER*
━━━━━━━━━━━━━━━━━━

📊 *Market analysis*
• /chart BTC/USDT — Candlestick chart
• /rsi BTC/USDT — RSI indicator
• /macd BTC/USDT — MACD indicator
• /signal BTC/USDT — Claude + DeepSeek signal
• /analysis BTC/USDT — Full AI analysis
• /forecast BTC/USDT — Rough statistical future chart
• /coins — Show the multi-coin scan universe

💼 *Account & trading*
• /balance — Available trading balance
• /portfolio — Account portfolio
• /orders — Order history
• /positions — Open positions
• /close BTC — Close a position
• Direct BUY/SELL buttons are disabled; AI selects only configured 1x/2x/3x/5x tiers

🧠 *System*
• /ai — AI engine status
• /performance — Trading performance
• /statistics — Daily, weekly, monthly and yearly account statistics
• /status — Bot status
• /logs — Recent activity
• /connection — Bybit and AI API status

🏠 Send /start anytime to refresh the main menu.
  `, { parse_mode: 'Markdown' });
});

// ==================== CHART COMMANDS ====================

async function handleChart(ctx) {
  const text = ctx.message?.text?.startsWith('/') ? ctx.message.text.split(/\s+/) : [];
  const pair = text[1]?.toUpperCase() || ctx.session.selectedPair || "BTC/USDT";
  const [base] = pair.split('/');
  
  ctx.session.selectedPair = pair;
  const tf = ctx.session.timeframe || '1h';
  
  const msg = await ctx.reply(`📊 *Generating ${tf} chart for ${pair}...*`, { parse_mode: 'Markdown' });
  
  try {
    const data = await getMarketData(base, tf);
    const chartPath = await chartGenerator.generateCandlestickChart(base, data);
    
    const sent = await ctx.replyWithPhoto(
      { source: chartPath },
      {
        caption: formatChartCaption(data, pair, tf),
        parse_mode: 'Markdown',
        ...actionKeyboard
      }
    );
    
    ctx.session.chartMsgId = sent.message_id;
    await ctx.deleteMessage(msg.message_id);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

async function handleRsi(ctx) {
  const text = ctx.message?.text?.startsWith('/') ? ctx.message.text.split(/\s+/) : [];
  const pair = text[1]?.toUpperCase() || ctx.session.selectedPair || "BTC/USDT";
  const [base] = pair.split('/');
  const tf = ctx.session.timeframe || '1h';
  
  const msg = await ctx.reply(`📈 *Generating RSI chart for ${pair} (${tf})...*`, { parse_mode: 'Markdown' });
  
  try {
    const data = await getMarketData(base, tf);
    const chartPath = await chartGenerator.generateRSIChart(base, data);
    
    await ctx.replyWithPhoto(
      { source: chartPath },
      {
        caption: `
📈 *${pair} - RSI (14)* - ${tf}

Current RSI: ${data.rsi.toFixed(2)}
• Overbought: > 70
• Oversold: < 30

*Signal:* ${data.rsi < 30 ? '🟢 Oversold - BUY' : data.rsi > 70 ? '🔴 Overbought - SELL' : '⚪ Neutral'}

⏰ ${new Date().toISOString()}
        `,
        parse_mode: 'Markdown'
      }
    );
    
    await ctx.deleteMessage(msg.message_id);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

async function handleMacd(ctx) {
  const text = ctx.message?.text?.startsWith('/') ? ctx.message.text.split(/\s+/) : [];
  const pair = text[1]?.toUpperCase() || ctx.session.selectedPair || "BTC/USDT";
  const [base] = pair.split('/');
  const tf = ctx.session.timeframe || '1h';
  
  const msg = await ctx.reply(`📉 *Generating MACD chart for ${pair} (${tf})...*`, { parse_mode: 'Markdown' });
  
  try {
    const data = await getMarketData(base, tf);
    const chartPath = await chartGenerator.generateMACDChart(base, data);
    
    await ctx.replyWithPhoto(
      { source: chartPath },
      {
        caption: `
📉 *${pair} - MACD* - ${tf}

MACD: ${data.macd.toFixed(4)}
Signal: ${data.macdSignal.toFixed(4)}
Histogram: ${data.macdHistogram.toFixed(4)}

*Signal:* ${data.macdHistogram > 0 ? '🟢 Bullish' : '🔴 Bearish'}

⏰ ${new Date().toISOString()}
        `,
        parse_mode: 'Markdown'
      }
    );
    
    await ctx.deleteMessage(msg.message_id);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

async function handleForecast(ctx) {
  const text = ctx.message?.text?.startsWith('/') ? ctx.message.text.split(/\s+/) : [];
  const pair = text[1]?.toUpperCase() || ctx.session.selectedPair || 'BTC/USDT';
  const [base] = pair.split('/');
  const tf = ctx.session.timeframe || '1h';
  const msg = await ctx.reply(`🔮 Building rough statistical forecast for ${pair} (${tf})...`);

  try {
    const data = await getMarketData(base, tf, 300);
    const forecast = forecastEngine.createForecast(data, tf);
    if (!forecast.available) {
      await ctx.reply(`Forecast unavailable: ${forecast.disclaimer}`);
      return;
    }

    const chartPath = await forecastChartGenerator.generate(base, data, forecast);
    const caption = `🔮 ${pair} ROUGH FORECAST (${tf})\n\n` +
      `Bias: ${forecast.direction} (${forecast.confidence}% scenario strength)\n` +
      `Horizon: ${forecast.horizonLabel}\n` +
      `Current: $${forecast.currentPrice.toFixed(4)}\n` +
      `Expected: $${forecast.expectedPrice.toFixed(4)} (${forecast.expectedReturnPct >= 0 ? '+' : ''}${forecast.expectedReturnPct.toFixed(2)}%)\n` +
      `80% scenario band: $${forecast.lowerPrice.toFixed(4)} — $${forecast.upperPrice.toFixed(4)}\n` +
      `Up/down probability: ${forecast.upProbabilityPct.toFixed(1)}% / ${forecast.downProbabilityPct.toFixed(1)}%\n\n` +
      `Approximation only. It is not a guaranteed future chart or financial advice.`;

    await ctx.replyWithDocument(
      { source: chartPath, filename: `${base}_forecast.png` },
      { caption }
    );
  } catch (error) {
    logger.error('FORECAST_COMMAND', error, { pair, timeframe: tf });
    await ctx.reply(`Forecast error: ${compactText(error.message, 300)}`);
  } finally {
    try { await ctx.deleteMessage(msg.message_id); } catch (error) {}
  }
}

async function handleSignal(ctx) {
  const text = ctx.message?.text?.startsWith('/') ? ctx.message.text.split(/\s+/) : [];
  const pair = text[1]?.toUpperCase() || ctx.session.selectedPair || "BTC/USDT";
  const [base] = pair.split('/');
  const tf = ctx.session.timeframe || '1h';
  
  const msg = await ctx.reply(`🧠 *AI Analyzing ${pair} (${tf})...*`, { parse_mode: 'Markdown' });
  
  try {
    const data = await getMarketData(base, tf);
    const patterns = await ultimateAI.detectAllPatterns(data);
    const result = await ultimateAI.analyzeAndTrade(base, ctx, data, patterns);
    const techAnalysis = ultimateAI.calculateAllIndicators(data);
    
    // Generate pattern visualization
    const patternChartPath = await patternVisualizer.generatePatternVisualization(
      base,
      data,
      patterns,
      result || { action: 'HOLD', confidence: 0 }
    );
    
    if (result && result.action !== 'HOLD') {
      const caption = `
🤖 *AI TRADING SIGNAL* - ${pair} (${tf})

*Action:* ${result.action} ${result.action === 'BUY' ? '🟢' : result.action === 'SELL' ? '🔴' : '⚪'}
*Confidence:* ${result.confidence}%
*AI Consensus:* ${aiConsensusSummary(result)}
${officialNewsContext(result)}
${executionStatusText(result)}${leverageApprovalText(result)}${moneyManagementText(result)}${forecastProjectionText(result)}

*Entry:* $${result.entryPrice.toFixed(2)}
*SL:* $${result.stopLoss.toFixed(2)}
*TP:* $${result.takeProfit.toFixed(2)}
*Risk/Reward:* ${result.riskReward?.toFixed(2) || 'N/A'}:1

*Patterns:* ${patterns.length > 0 ? patterns.map(p => p.name).join(', ') : 'None'}
*Reason:* ${result.reasoning}

📈 RSI: ${data.rsi?.toFixed(2) || 'N/A'}
📉 Trend: ${techAnalysis.marketTrend || 'NEUTRAL'}

⏰ ${new Date().toISOString()}
          `;
      await sendPatternChart(ctx, base, data, patterns, result, patternChartPath, caption);
    } else {
      const caption = `
🟡 HOLD - ${pair}

Confidence: ${result?.confidence || 0}%
AI Consensus: ${aiConsensusSummary(result)}
${officialNewsContext(result)}
AI reason: ${result?.reasoning || 'The AI found no directional edge.'}
Progress: $${ultimateAI.currentBalance?.toFixed(2) || '0.00'} / ${targetLabel()}

📊 Patterns: ${patterns.length > 0 ? patterns.map(p => p.name).join(', ') : 'None detected'}
📈 RSI: ${data.rsi?.toFixed(2) || 'N/A'}
📉 Trend: ${techAnalysis.marketTrend || 'NEUTRAL'}

⏰ ${new Date().toISOString()}
          `;
      await sendPatternChart(ctx, base, data, patterns, result || { action: 'HOLD', confidence: 0 }, patternChartPath, caption);
    }
    
    await ctx.deleteMessage(msg.message_id);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

async function handleAnalysis(ctx) {
  const text = ctx.message?.text?.startsWith('/') ? ctx.message.text.split(/\s+/) : [];
  const pair = text[1]?.toUpperCase() || ctx.session.selectedPair || "BTC/USDT";
  const [base] = pair.split('/');
  const tf = ctx.session.timeframe || '1h';
  
  const msg = await ctx.reply(`📊 *Generating full analysis for ${pair} (${tf})...*`, { parse_mode: 'Markdown' });
  
  try {
    const data = await getMarketData(base, tf);
    const patterns = await ultimateAI.detectAllPatterns(data);
    const result = await ultimateAI.analyzeAndTrade(base, ctx, data, patterns);
    const techAnalysis = ultimateAI.calculateAllIndicators(data);
    
    const patternChartPath = await patternVisualizer.generatePatternVisualization(
      base,
      data,
      patterns,
      result || { action: 'HOLD', confidence: 0 }
    );
    
    const caption = `
📊 *${pair} - Full Analysis* (${tf})

*AI Signal:* ${result?.action || 'HOLD'} (${result?.confidence || 0}%)
*AI Consensus:* ${aiConsensusSummary(result)}
${officialNewsContext(result)}
${executionStatusText(result)}${leverageApprovalText(result)}${moneyManagementText(result)}${forecastProjectionText(result)}
*Entry:* $${result?.entryPrice?.toFixed(2) || 'N/A'}
*SL:* $${result?.stopLoss?.toFixed(2) || 'N/A'}
*TP:* $${result?.takeProfit?.toFixed(2) || 'N/A'}

*Patterns:* ${patterns.length > 0 ? patterns.map(p => p.name).join(', ') : 'None'}
*Reason:* ${result?.reasoning || 'No clear signal'}

📈 RSI: ${data.rsi?.toFixed(2) || 'N/A'}
📉 Trend: ${techAnalysis.marketTrend || 'NEUTRAL'}

⏰ ${new Date().toISOString()}
        `;
    await sendPatternChart(ctx, base, data, patterns, result || { action: 'HOLD', confidence: 0 }, patternChartPath, caption);

    if (result?.forecast?.available) {
      const forecastPath = await forecastChartGenerator.generate(base, data, result.forecast, result);
      const projection = result.tradeProjection || {};
      await ctx.replyWithDocument(
        { source: forecastPath, filename: `${base}_rough_forecast.png` },
        {
          caption: `ROUGH FORECAST - ${pair} (${tf})
Bias: ${result.forecast.direction}
Horizon: ${result.forecast.horizonLabel}
Expected move: ${finiteNumber(result.forecast.expectedReturnPct).toFixed(2)}%
TP probability: ${finiteNumber(projection.tpReachProbabilityPct).toFixed(1)}%
Approx. TP time: ${projection.tpEtaLabel || 'Not estimated'}
Approximation only; not guaranteed.`
        }
      );
    }
    
    await ctx.deleteMessage(msg.message_id);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

bot.command("chart", handleChart);
bot.command("rsi", handleRsi);
bot.command("macd", handleMacd);
bot.command("forecast", handleForecast);
bot.command("signal", handleSignal);
bot.command("analysis", handleAnalysis);
bot.command("coins", async (ctx) => {
  const rows = [];
  for (let index = 0; index < AUTO_TRADE_COINS.length; index += 10) {
    rows.push(AUTO_TRADE_COINS.slice(index, index + 10).join(', '));
  }
  await ctx.reply(`V16 scan universe: ${AUTO_TRADE_COINS.length} coins\n\n${rows.join('\n')}\n\nExpensive AI analysis is limited to the top ${marketScanner.maxAIAnalyses} technical candidates per sweep.`);
});

// ==================== AUTO-TRADE FUNCTION ====================

async function runFullMarketScan(ctx) {
  if (isScanning) {
    logger.step('SCAN_SKIP', { reason: 'Previous sweep still running' });
    return;
  }

  isScanning = true;
  const sweepStart = Date.now();
  let scannedCount = 0;
  let signalsFound = 0;
  let tradesExecuted = 0;
  const candidates = [];

  logger.action('FULL_SCAN_START', {
    coins: AUTO_TRADE_COINS,
    timeframes: SCAN_TIMEFRAMES,
    aiBudget: marketScanner.maxAIAnalyses
  });

  try {
    if (ultimateAI.isTrading) {
      logger.step('AUTO_TRADE_SKIP', { reason: 'Already trading' });
      return;
    }

    await orderManager.verifyOpenPositions();
    const dailyTarget = await ultimateAI.syncDailyPnl({ force: true });
    if (dailyTarget.reached) {
      autoTradeMsgId = await sendOrEdit(
        ctx,
        ctx.chat.id,
        autoTradeMsgId,
        `DAILY TARGET REACHED\nNet realized PnL: $${dailyTarget.netPnl.toFixed(2)} / $${dailyTarget.target.toFixed(2)}\nNew entries paused until ${dailyTarget.timeZone} starts a new day.`,
        { parse_mode: false }
      );
      isAutoTrading = false;
      if (autoTradeInterval) {
        clearInterval(autoTradeInterval);
        autoTradeInterval = null;
      }
      return;
    }

    const effectiveDailyLossLimit = ultimateAI.getEffectiveDailyLossLimit();
    if (effectiveDailyLossLimit > 0 && ultimateAI.dailyLoss >= effectiveDailyLossLimit) {
      autoTradeMsgId = await sendOrEdit(
        ctx,
        ctx.chat.id,
        autoTradeMsgId,
        `STOPPED: daily loss $${ultimateAI.dailyLoss.toFixed(2)} reached the $${effectiveDailyLossLimit.toFixed(2)} limit.`,
        { parse_mode: false }
      );
      return;
    }

    const status = ultimateAI.getStatus();
    if (ultimateAI.tradingTargetEnabled && status.equity && status.equity >= ultimateAI.targetBalance) {
      autoTradeMsgId = await sendOrEdit(
        ctx,
        ctx.chat.id,
        autoTradeMsgId,
        `TARGET REACHED\nBalance: $${status.balance.toFixed(2)} / ${targetLabel()}`,
        { parse_mode: false }
      );
      isAutoTrading = false;
      if (autoTradeInterval) {
        clearInterval(autoTradeInterval);
        autoTradeInterval = null;
      }
      return;
    }

    // Phase 1: inexpensive technical pre-scan across the entire configured
    // universe. This gives broad coverage without paying for hundreds of
    // Claude/DeepSeek calls every sweep.
    coinLoop:
    for (const coin of AUTO_TRADE_COINS) {
      for (const tf of SCAN_TIMEFRAMES) {
        if (!isAutoTrading) break coinLoop;
        scannedCount++;
        logger.scanStart(coin, tf);

        try {
          const data = await getMarketData(coin, tf, 250);
          const patterns = await ultimateAI.detectAllPatterns(data);
          const techAnalysis = ultimateAI.calculateAllIndicators(data);
          const scanScore = marketScanner.score(data, patterns, techAnalysis);
          candidates.push({ coin, tf, data, patterns, techAnalysis, scanScore });
          logger.step('PRESCAN_COMPLETE', {
            coin,
            timeframe: tf,
            score: scanScore,
            patterns: patterns.length
          });
        } catch (coinError) {
          logger.error('PRESCAN_COIN', coinError, { coin, tf });
        }

        await new Promise(resolve => setTimeout(resolve, SCAN_STAGGER_MS));
      }
    }

    const selected = marketScanner.rank(candidates);
    autoTradeMsgId = await sendOrEdit(
      ctx,
      ctx.chat.id,
      autoTradeMsgId,
      `V16 MEGA SCAN\nTechnical combinations scanned: ${scannedCount}\nValid candidates: ${candidates.length}\nDeep AI finalists: ${selected.length}\nAI selects only configured leverage tiers; the risk engine may downgrade unsupported or unsafe tiers.`,
      { parse_mode: false }
    );

    // Phase 2: expensive ensemble analysis only for the strongest/most
    // unusual candidates. The AI remains the decision-maker; scanScore only
    // prioritizes which packets are reviewed first.
    for (const candidate of selected) {
      if (!isAutoTrading) break;
      const { coin, tf, data, patterns, techAnalysis, scanScore } = candidate;

      try {
        const result = await ultimateAI.analyzeAndTrade(coin, ctx, data, patterns);
        if (result?.action !== 'HOLD') signalsFound++;
        if (result?.executed) tradesExecuted++;

        logger.scanComplete(coin, patterns, techAnalysis, result || {}, Date.now() - sweepStart);

        const shouldRender = result?.action !== 'HOLD' || patterns.length > 0;
        if (shouldRender) {
          const patternChartPath = await patternVisualizer.generatePatternVisualization(
            coin,
            data,
            patterns,
            result || { action: 'HOLD', confidence: 0 }
          );

          const title = result?.executed
            ? 'POSITION OPENED'
            : result?.executionBlocked
              ? 'AI SIGNAL BLOCKED'
              : result?.action === 'HOLD'
                ? 'AI HOLD'
                : 'AI SIGNAL NOT EXECUTED';
          const patternList = patterns.slice(0, 12).map(pattern => `• ${pattern.name}`).join('\n') || '• None';
          const caption = `${title} - ${coin}/USDT (${tf})\n\n` +
            `**Pre-scan score:** ${scanScore.toFixed(2)}/100\n` +
            `**AI signal:** ${result?.action || 'HOLD'} (${result?.confidence || 0}%)\n` +
            `**AI consensus:** ${aiConsensusSummary(result)}\n` +
            `${officialNewsContext(result)}${executionStatusText(result)}${leverageApprovalText(result)}${moneyManagementText(result)}${forecastProjectionText(result)}\n` +
            `**Entry:** $${finiteNumber(result?.entryPrice).toFixed(4)}\n` +
            `**SL:** $${finiteNumber(result?.stopLoss).toFixed(4)}\n` +
            `**TP:** $${finiteNumber(result?.takeProfit).toFixed(4)}\n` +
            `**Risk/reward:** ${finiteNumber(result?.riskReward).toFixed(2)}:1\n\n` +
            `**Pattern context (${patterns.length}):**\n${patternList}\n\n` +
            `**Reason:** ${result?.reasoning || 'No directional edge.'}\n` +
            `**RSI:** ${finiteNumber(data?.rsi, 50).toFixed(2)} · Trend: ${techAnalysis?.marketTrend || 'NEUTRAL'}\n\n` +
            `${new Date().toISOString()}`;

          await sendPatternChart(
            ctx,
            coin,
            data,
            patterns,
            result || { action: 'HOLD', confidence: 0 },
            patternChartPath,
            caption
          );
        }
      } catch (aiError) {
        logger.error('AI_FINALIST', aiError, { coin, tf, scanScore });
      }

      await new Promise(resolve => setTimeout(resolve, AI_SCAN_STAGGER_MS));
    }

    const elapsedSeconds = ((Date.now() - sweepStart) / 1000).toFixed(1);
    autoTradeMsgId = await sendOrEdit(
      ctx,
      ctx.chat.id,
      autoTradeMsgId,
      `V16 SWEEP COMPLETE\nScanned: ${scannedCount} combinations across ${AUTO_TRADE_COINS.length} coins\nDeep AI reviews: ${selected.length}\nDirectional signals: ${signalsFound}\nPositions opened: ${tradesExecuted}\nElapsed: ${elapsedSeconds}s\n${new Date().toISOString()}`,
      { parse_mode: false }
    );

    logger.action('FULL_SCAN_COMPLETE', {
      scannedCount,
      candidates: candidates.length,
      aiReviews: selected.length,
      signalsFound,
      tradesExecuted,
      durationMs: Date.now() - sweepStart
    });
  } catch (error) {
    logger.error('AUTO_TRADE', error, {});
    autoTradeMsgId = await sendOrEdit(
      ctx,
      ctx.chat.id,
      autoTradeMsgId,
      `Auto-trade error: ${compactText(error.message, 500)}`,
      { parse_mode: false }
    );
  } finally {
    isScanning = false;
  }
}


// ==================== LIVE UPDATES ====================

function startLiveUpdates(ctx) {
  if (ctx.session.liveInterval) {
    clearInterval(ctx.session.liveInterval);
  }
  
  ctx.session.liveInterval = setInterval(async () => {
    if (!ctx.session.liveMode) {
      clearInterval(ctx.session.liveInterval);
      ctx.session.liveInterval = null;
      return;
    }
    
    try {
      const pair = ctx.session.selectedPair || 'BTC/USDT';
      const tf = ctx.session.timeframe || '1h';
      const [base] = pair.split('/');
      
      const data = await getMarketData(base, tf);
      const status = ultimateAI.getStatus();
      const openPositions = await orderManager.getOpenPositions();
      
      const statusMsg = `
🔄 LIVE UPDATE - ${new Date().toISOString()}

📊 ${pair} (${tf})
💰 Price: $${data.price.toFixed(2)} ${data.change24h >= 0 ? '📈' : '📉'} ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%

📈 RSI: ${data.rsi.toFixed(2)} 
📉 MACD: ${data.macd.toFixed(4)}

📊 Balance: $${status.balance?.toFixed(2) || 'N/A'}
🎯 Target: ${targetLabel()}
📈 Progress: ${status.progress?.toFixed(1) || 0}%
📊 Positions: ${openPositions.length}

⏱️ Next update in 30s...
      `;
      
      if (ctx.session.statusMsgId) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.session.statusMsgId,
            null,
            statusMsg,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          const sent = await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
          ctx.session.statusMsgId = sent.message_id;
        }
      } else {
        const sent = await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
        ctx.session.statusMsgId = sent.message_id;
      }
    } catch (error) {
      logger.error('LIVE_UPDATE', error);
    }
  }, 30000);
}

// ==================== ACTIONS ====================

TIMEFRAMES.forEach(tf => {
  bot.action(`tf_${tf}`, async (ctx) => {
    ctx.session.timeframe = tf;
    await ctx.answerCbQuery(`⏱️ Timeframe set to ${tf}`);
    await sendOrEdit(ctx, ctx.chat.id, null, `✅ Timeframe changed to ${tf}`);
  });
});

PAIRS.forEach(pair => {
  const callback = `pair_${pair.replace('/', '_')}`;
  bot.action(callback, async (ctx) => {
    const [base] = pair.split('/');
    ctx.session.selectedPair = pair;
    const tf = ctx.session.timeframe || '1h';
    await ctx.answerCbQuery(`Loading ${pair} (${tf})...`);
    
    try {
      const data = await getMarketData(base, tf);
      const patterns = await ultimateAI.detectAllPatterns(data);
      const result = await ultimateAI.analyzeAndTrade(base, ctx, data, patterns);
      const techAnalysis = ultimateAI.calculateAllIndicators(data);
      
      const patternChartPath = await patternVisualizer.generatePatternVisualization(
        base,
        data,
        patterns,
        result || { action: 'HOLD', confidence: 0 }
      );
      
      const caption = `
🤖 AI ANALYSIS - ${pair} (${tf})

Signal: ${result?.action || 'HOLD'} (${result?.confidence || 0}%)
${executionStatusText(result)}${leverageApprovalText(result)}${moneyManagementText(result)}${forecastProjectionText(result)}
Entry: $${result?.entryPrice?.toFixed(2) || 'N/A'}
SL: $${result?.stopLoss?.toFixed(2) || 'N/A'}
TP: $${result?.takeProfit?.toFixed(2) || 'N/A'}

Patterns: ${patterns.map(p => p.name).join(', ') || 'None'}
Reason: ${result?.reasoning || 'No clear signal'}

📈 RSI: ${data.rsi?.toFixed(2) || 'N/A'}
📉 Trend: ${techAnalysis.marketTrend || 'NEUTRAL'}

⏰ ${new Date().toISOString()}
          `;
      await sendPatternChart(ctx, base, data, patterns, result || { action: 'HOLD', confidence: 0 }, patternChartPath, caption, actionKeyboard);
    } catch (err) {
      logger.error('PAIR_SELECTION', err, { pair });
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });
});

bot.action('refresh_balance', async (ctx) => {
  await ctx.answerCbQuery('🔄 Refreshing...');
  await showBalance(ctx, ctx.session.balanceMsgId);
});

bot.action('view_portfolio', async (ctx) => {
  await ctx.answerCbQuery('📊 Loading...');
  await showPortfolio(ctx, ctx.session.portfolioMsgId);
});

bot.action('view_orders', async (ctx) => {
  await ctx.answerCbQuery('📝 Loading...');
  await showOrders(ctx, ctx.session.ordersMsgId);
});

bot.action('action_buy', async (ctx) => {
  await ctx.answerCbQuery('Direct manual orders are disabled in V16');
  await ctx.reply('V16 safety gate: the final AI selects only configured 1x/2x/3x/5x tiers, and the hard risk engine may downgrade them. Use “Run AI approval” or /signal.');
});

bot.action('action_sell', async (ctx) => {
  await ctx.answerCbQuery('Direct manual orders are disabled in V16');
  await ctx.reply('V16 safety gate: the final AI selects only configured 1x/2x/3x/5x tiers, and the hard risk engine may downgrade them. Use “Run AI approval” or /signal.');
});

bot.action('action_ai_approval', async (ctx) => {
  await ctx.answerCbQuery('Running final AI approval...');
  await handleSignal(ctx);
});

bot.action('action_forecast', async (ctx) => {
  await ctx.answerCbQuery('Generating rough forecast...');
  await handleForecast(ctx);
});

bot.action('update_chart', async (ctx) => {
  await ctx.answerCbQuery('🔄 Updating chart...');
  await handleChart(ctx);
});

bot.action('action_full_analysis', async (ctx) => {
  await ctx.answerCbQuery('📊 Generating full analysis...');
  await handleAnalysis(ctx);
});

// ==================== SCHEDULED TASKS ====================

cron.schedule('0 * * * *', async () => {
  logger.action('SCHEDULED_VERIFY', {});
  await orderManager.verifyOpenPositions();
});

cron.schedule('*/5 * * * *', async () => {
  try {
    await accountStatistics.sync({ backfill: false });
  } catch (error) {
    logger.error('SCHEDULED_ACCOUNT_STATISTICS', error);
  }
}, { timezone: accountStatistics.timeZone });

cron.schedule('0 0 * * *', async () => {
  logger.action('DAILY_REPORT', {});
  const stats = db.getStats();
  const balance = await bybit.getBalance();
  
  db.saveDailyPerformance({
    date: accountStatistics.dateKey(),
    balance: balance.totalUSD,
    totalPnl: stats.totalPnl,
    winRate: stats.winRate,
    trades: stats.totalTrades,
    maxDrawdown: 0
  });
  await accountStatistics.sync({ force: true, backfill: false }).catch(error => {
    logger.error('DAILY_STATISTICS_SNAPSHOT', error);
  });
}, { timezone: accountStatistics.timeZone });

// ==================== LAUNCH ====================

bot.catch(async (error, ctx) => {
  logger.error('TELEGRAM_HANDLER', error, {
    updateType: ctx?.updateType,
    chatId: ctx?.chat?.id
  });

  if (error?.name === 'TimeoutError' && ctx?.chat?.id) {
    try {
      await ctx.reply(
        '⏳ This AI task is taking longer than expected, but the bot is still running. Check Status or Logs shortly.',
        { parse_mode: undefined }
      );
    } catch (replyError) {
      logger.error('TELEGRAM_TIMEOUT_NOTICE', replyError);
    }
  }
});

async function launchBot() {
  try {
    processLock.acquire();
    await bot.telegram.setMyCommands(telegramCommands);
    await bot.launch();

    // connect() performs its authentication test asynchronously. Wait for it
    // before printing startup status so a valid account is not labeled Mock.
    if (bybit.waitForConnection) {
      await bybit.waitForConnection();
    }

    console.log('🚀 ULTRA AI TRADING BOT v16.1 STARTED');
    console.log(`🏦 Bybit: ${bybit.isConnected ? '✅ Connected' : '❌ Disconnected'}`);
    if (!bybit.isConnected && bybit.connectionError) {
      console.log(`   Error: ${bybit.connectionError}`);
    }
    console.log(`🔑 Mode: ${bybit.getMode ? bybit.getMode().toUpperCase() : 'RO'}`);
    console.log(`⏱️ Telegram timeout: ${Math.round(TELEGRAM_HANDLER_TIMEOUT / 1000)}s`);
    await ultimateAI.syncDailyPnl({ force: true });
    await accountStatistics.sync({ force: true }).catch(error => {
      logger.error('STARTUP_ACCOUNT_STATISTICS', error);
    });
    console.log(`🎯 Daily target: ${dailyTargetSummary()}`);
    console.log(`🏁 Balance target: ${targetLabel()}`);
    console.log(`Monitoring ${AUTO_TRADE_COINS.length} coins; deep AI budget ${marketScanner.maxAIAnalyses} candidates/sweep`);
  } catch (error) {
    logger.error('BOT_LAUNCH', error);
    console.error(`❌ Bot launch failed: ${error.message}`);
    processLock.release();
    process.exitCode = 1;
  }
}

launchBot();

process.once('SIGINT', () => {
  processLock.release();
  bot.stop('SIGINT');
  if (autoTradeInterval) clearInterval(autoTradeInterval);
});
process.once('SIGTERM', () => {
  processLock.release();
  bot.stop('SIGTERM');
  if (autoTradeInterval) clearInterval(autoTradeInterval);
});

process.once('exit', () => {
  try { processLock.release(); } catch (_error) {}
});

module.exports = bot;

