'use strict';

function normalizeId(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,20}$/.test(text) ? text : '';
}

function getAuthorizedIds(env = process.env) {
  const ids = new Set(
    String(env.AUTHORIZED_TELEGRAM_USER_IDS || '')
      .split(',')
      .map(normalizeId)
      .filter(Boolean)
  );
  // CHAT_ID is accepted as a convenience only for a positive private-chat ID.
  // Negative group IDs never authorize every group participant.
  const privateChatId = normalizeId(env.CHAT_ID);
  if (privateChatId) ids.add(privateChatId);
  return ids;
}

function isAuthorized(ctx, ids = getAuthorizedIds()) {
  const userId = normalizeId(ctx?.from?.id);
  return Boolean(userId && ids.has(userId));
}

function createAuthorizationMiddleware({ ids = getAuthorizedIds(), logger = null } = {}) {
  return async (ctx, next) => {
    if (isAuthorized(ctx, ids)) return next();
    logger?.warn?.('TELEGRAM_UNAUTHORIZED', {
      userId: ctx?.from?.id || null,
      chatId: ctx?.chat?.id || null,
      updateType: ctx?.updateType || null
    });
    try {
      if (ctx?.callbackQuery && typeof ctx.answerCbQuery === 'function') {
        await ctx.answerCbQuery('Unauthorized', { show_alert: true });
      } else if (typeof ctx?.reply === 'function') {
        await ctx.reply('⛔ Unauthorized user.');
      }
    } catch (_) {
      // Do not leak configuration details to an unauthorized requester.
    }
    return undefined;
  };
}

module.exports = { normalizeId, getAuthorizedIds, isAuthorized, createAuthorizationMiddleware };
