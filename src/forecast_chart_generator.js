'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { calculateFibonacci } = require('./technical_tools');

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priceLabel(value) {
  const number = finite(value);
  if (number >= 1000) return `$${number.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (number >= 1) return `$${number.toFixed(2)}`;
  return `$${number.toPrecision(4)}`;
}

class ForecastChartGenerator {
  constructor() {
    this.outputDir = path.join(__dirname, 'charts');
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
  }

  async generate(coin, data, forecast, decision = null) {
    if (!forecast?.available || !Array.isArray(forecast.path) || !forecast.path.length) {
      throw new Error('Forecast data is unavailable');
    }

    const width = 1800;
    const height = 980;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const margin = { left: 105, right: 70, top: 110, bottom: 130 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const candles = Array.isArray(data?.candles) ? data.candles.slice(-60) : [];
    const opens = candles.map(c => finite(c[1]));
    const highs = candles.map(c => finite(c[2]));
    const lows = candles.map(c => finite(c[3]));
    const closes = candles.map(c => finite(c[4]));
    const projected = forecast.path.map(point => finite(point.price));
    const lower = forecast.path.map(point => finite(point.lower));
    const upper = forecast.path.map(point => finite(point.upper));
    const fibonacci = data?.fibonacci || calculateFibonacci(highs, lows, closes, 60);
    const fibPrices = Array.isArray(fibonacci?.retracements) ? fibonacci.retracements.map(level => finite(level.price)) : [];

    const all = [...highs, ...lows, ...projected, ...lower, ...upper, ...fibPrices];
    if (decision?.takeProfit) all.push(finite(decision.takeProfit));
    if (decision?.stopLoss) all.push(finite(decision.stopLoss));
    let min = Math.min(...all);
    let max = Math.max(...all);
    const padding = Math.max((max - min) * 0.12, max * 0.005);
    min -= padding;
    max += padding;

    const totalSlots = candles.length + projected.length + 3;
    const stepX = chartWidth / Math.max(1, totalSlots);
    const candleWidth = Math.max(6, Math.min(14, stepX * 0.58));
    const xAt = index => margin.left + (index * stepX) + stepX * 0.5;
    const yAt = value => margin.top + ((max - value) / Math.max(1e-12, max - min)) * chartHeight;

    // Background
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#061018');
    bg.addColorStop(0.55, '#0b1726');
    bg.addColorStop(1, '#101b31');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createLinearGradient(0, 0, width, height);
    glow.addColorStop(0, 'rgba(59, 130, 246, 0.15)');
    glow.addColorStop(1, 'rgba(236, 72, 153, 0.08)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fbff';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(`${coin}/USDT future graph`, margin.left, 50);
    ctx.fillStyle = '#9fb2ca';
    ctx.font = '19px sans-serif';
    ctx.fillText(`${forecast.timeframe} candles · ${forecast.horizonLabel} horizon · ${forecast.direction} bias`, margin.left, 80);

    // Grid
    ctx.strokeStyle = 'rgba(159, 178, 202, 0.16)';
    ctx.lineWidth = 1;
    ctx.font = '16px sans-serif';
    for (let row = 0; row <= 8; row += 1) {
      const value = max - ((max - min) * row / 8);
      const py = margin.top + chartHeight * row / 8;
      ctx.beginPath();
      ctx.moveTo(margin.left, py);
      ctx.lineTo(width - margin.right, py);
      ctx.stroke();
      ctx.fillStyle = '#8fa4bd';
      ctx.fillText(priceLabel(value), 10, py + 5);
    }

    // Fibonacci lines
    if (Array.isArray(fibonacci?.retracements)) {
      fibonacci.retracements.filter(level => [0.236, 0.382, 0.5, 0.618, 0.786].includes(Number(level.ratio))).forEach(level => {
        const py = yAt(level.price);
        const highlight = Math.abs(Number(level.ratio) - 0.618) < 1e-6;
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = highlight ? 'rgba(251, 191, 36, 0.95)' : 'rgba(148, 163, 184, 0.35)';
        ctx.lineWidth = highlight ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(margin.left, py);
        ctx.lineTo(width - margin.right, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = highlight ? '#fbbf24' : '#94a3b8';
        ctx.font = '12px sans-serif';
        ctx.fillText(`Fib ${Number(level.ratio).toFixed(3)} · ${priceLabel(level.price)}`, width - margin.right - 220, py - 8);
      });
    }

    // Historical candles
    candles.forEach((candle, index) => {
      const open = opens[index];
      const high = highs[index];
      const low = lows[index];
      const close = closes[index];
      const isUp = close >= open;
      const bodyColor = isUp ? '#22c55e' : '#ef4444';
      const fillColor = isUp ? 'rgba(34, 197, 94, 0.22)' : 'rgba(239, 68, 68, 0.22)';
      const x = xAt(index);
      const yHigh = yAt(high);
      const yLow = yAt(low);
      const yOpen = yAt(open);
      const yClose = yAt(close);

      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
      ctx.fillStyle = fillColor;
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 1.4;
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    const forecastStartIndex = candles.length - 1;

    // Confidence band
    ctx.fillStyle = 'rgba(96, 165, 250, 0.15)';
    ctx.beginPath();
    upper.forEach((value, index) => {
      const px = xAt(forecastStartIndex + index);
      const py = yAt(value);
      if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    for (let index = lower.length - 1; index >= 0; index -= 1) {
      ctx.lineTo(xAt(forecastStartIndex + index), yAt(lower[index]));
    }
    ctx.closePath();
    ctx.fill();

    // Current close bridge
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    closes.forEach((value, index) => {
      const px = xAt(index);
      const py = yAt(value);
      if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // Future line
    ctx.strokeStyle = forecast.direction === 'BULLISH' ? '#60a5fa' : forecast.direction === 'BEARISH' ? '#f97316' : '#a78bfa';
    ctx.lineWidth = 4;
    ctx.setLineDash([11, 7]);
    ctx.beginPath();
    projected.forEach((value, index) => {
      const px = xAt(forecastStartIndex + index);
      const py = yAt(value);
      if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    const drawLevel = (value, label, color) => {
      if (!Number.isFinite(value) || value <= 0) return;
      const py = yAt(value);
      ctx.setLineDash([7, 7]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(margin.left, py);
      ctx.lineTo(width - margin.right, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(`${label} ${priceLabel(value)}`, width - margin.right - 210, py - 10);
    };

    drawLevel(finite(decision?.takeProfit), 'TP', '#22c55e');
    drawLevel(finite(decision?.stopLoss), 'SL', '#ef4444');

    const dividerX = xAt(forecastStartIndex);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dividerX, margin.top);
    ctx.lineTo(dividerX, margin.top + chartHeight);
    ctx.stroke();
    ctx.fillStyle = '#d8e3f0';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('FORECAST ZONE →', dividerX + 10, margin.top + 25);

    // Legend cards
    const cards = [
      `Expected: ${priceLabel(forecast.expectedPrice)} (${forecast.expectedReturnPct >= 0 ? '+' : ''}${forecast.expectedReturnPct.toFixed(2)}%)`,
      `80% scenario band: ${priceLabel(forecast.lowerPrice)} – ${priceLabel(forecast.upperPrice)}`,
      `Probability up/down: ${forecast.upProbabilityPct.toFixed(1)}% / ${forecast.downProbabilityPct.toFixed(1)}%`
    ];
    ctx.fillStyle = 'rgba(15, 23, 42, 0.68)';
    ctx.fillRect(margin.left, height - 94, width - margin.left - margin.right, 54);
    ctx.fillStyle = '#f8fbff';
    ctx.font = '16px sans-serif';
    cards.forEach((card, idx) => ctx.fillText(card, margin.left + 18 + idx * 520, height - 60));
    ctx.fillStyle = '#71859e';
    ctx.font = '15px sans-serif';
    ctx.fillText('Approximation only. Statistical volatility path, not a guaranteed future price.', margin.left, height - 18);

    const filename = `${String(coin).replace(/[^A-Z0-9]/gi, '')}_forecast_${Date.now()}.png`;
    const outputPath = path.join(this.outputDir, filename);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    return outputPath;
  }
}

module.exports = new ForecastChartGenerator();

