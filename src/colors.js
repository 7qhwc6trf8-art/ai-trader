const colors = {
  // Text colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Bright colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  
  // Styles
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',
  
  // Reset
  reset: '\x1b[0m'
};

// Icons (no emojis)
const icons = {
  // Trading
  BUY: '▲',
  SELL: '▼',
  HOLD: '◆',
  WAIT: '◇',
  
  // Status
  SUCCESS: '✔',
  ERROR: '✖',
  WARNING: '⚠️',
  INFO: 'ℹ',
  
  // Arrows
  UP: '↑',
  DOWN: '↓',
  RIGHT: '→',
  LEFT: '←',
  
  // Stars
  STAR: '★',
  STAR_EMPTY: '☆',
  
  // Misc
  CIRCLE: '●',
  CIRCLE_EMPTY: '○',
  SQUARE: '■',
  SQUARE_EMPTY: '□',
  DIAMOND: '◆',
  DIAMOND_EMPTY: '◇',
  
  // Lines
  LINE: '─',
  LINE_VERTICAL: '│',
  LINE_CROSS: '┼',
  LINE_TOP: '┬',
  LINE_BOTTOM: '┴',
  LINE_LEFT: '├',
  LINE_RIGHT: '┤',
  
  // Corners
  CORNER_TL: '┌',
  CORNER_TR: '┐',
  CORNER_BL: '└',
  CORNER_BR: '┘',
  
  // Bullets
  BULLET: '•',
  BULLET_HOLLOW: '◦',
  BULLET_SQUARE: '▪',
  
  // Currency
  USD: '$',
  BTC: '₿',
  ETH: '⟠',
  
  // Time
  CLOCK: '⏱️',
  CALENDAR: '📅',
  
  // Charts
  CHART_UP: '📈',
  CHART_DOWN: '📉',
  CHART: '📊',
  
  // Misc
  GEAR: '⚙',
  LOCK: '🔒',
  UNLOCK: '🔓',
  CHECK: '✅',
  CROSS: '❌',
  WARNING_SIGN: '⚠️',
  INFO_SIGN: 'ℹ️'
};

function colorize(text, color, style = '') {
  return `${style}${color}${text}${colors.reset}`;
}

function success(text) {
  return colorize(text, colors.brightGreen, colors.bold);
}

function error(text) {
  return colorize(text, colors.brightRed, colors.bold);
}

function warning(text) {
  return colorize(text, colors.brightYellow, colors.bold);
}

function info(text) {
  return colorize(text, colors.brightCyan, colors.bold);
}

function highlight(text) {
  return colorize(text, colors.brightMagenta, colors.bold);
}

function dim(text) {
  return colorize(text, colors.gray, colors.dim);
}

function box(text, color = colors.brightCyan) {
  const lines = text.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length));
  const border = '─'.repeat(maxLen + 4);
  const result = [
    `${color}${icons.CORNER_TL}${border}${icons.CORNER_TR}${colors.reset}`,
    ...lines.map(l => `${color}${icons.LINE_VERTICAL} ${l}${' '.repeat(maxLen - l.length)} ${icons.LINE_VERTICAL}${colors.reset}`),
    `${color}${icons.CORNER_BL}${border}${icons.CORNER_BR}${colors.reset}`
  ];
  return result.join('\n');
}

function table(headers, rows) {
  const colWidths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map(r => String(r[i] || '').length));
    return Math.max(h.length, maxRow);
  });
  
  const top = icons.CORNER_TL + colWidths.map(w => icons.LINE.repeat(w + 2)).join(icons.LINE_TOP) + icons.CORNER_TR;
  const headerRow = icons.LINE_VERTICAL + headers.map((h, i) => ` ${h}${' '.repeat(colWidths[i] - h.length)} `).join(icons.LINE_VERTICAL) + icons.LINE_VERTICAL;
  const divider = icons.LINE_LEFT + colWidths.map(w => icons.LINE.repeat(w + 2)).join(icons.LINE_CROSS) + icons.LINE_RIGHT;
  const dataRows = rows.map(row => 
    icons.LINE_VERTICAL + row.map((cell, i) => ` ${String(cell)}${' '.repeat(colWidths[i] - String(cell).length)} `).join(icons.LINE_VERTICAL) + icons.LINE_VERTICAL
  );
  const bottom = icons.CORNER_BL + colWidths.map(w => icons.LINE.repeat(w + 2)).join(icons.LINE_BOTTOM) + icons.CORNER_BR;
  
  return [top, headerRow, divider, ...dataRows, bottom].join('\n');
}

module.exports = {
  colors,
  icons,
  colorize,
  success,
  error,
  warning,
  info,
  highlight,
  dim,
  box,
  table
};

