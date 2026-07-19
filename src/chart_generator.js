const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');
const { calculateFibonacci } = require('./technical_tools');

class ChartGenerator {
    constructor() {
        this.width = 2200;
        this.height = 1200;
        this.padding = {
            top: 40,
            right: 0,
            bottom: 40,
            left: 0
        };
        this.chartWidth =
            this.width - this.padding.left - this.padding.right;
        this.chartHeight = this.height - this.padding.top - this.padding.bottom - 200;
    }

    async generatePatternChart(coin, data, patterns, decision) {
        const canvas = createCanvas(this.width, this.height);
        const ctx = canvas.getContext('2d');

        const candles = data.candles || [];
        const closes = data.closes || candles.map(c => c[4]);
        const highs = data.highs || candles.map(c => c[2]);
        const lows = data.lows || candles.map(c => c[3]);
        const opens = data.opens || candles.map(c => c[1]);
        const volumes = data.volumes || candles.map(c => c[5]);
        const emaData = data.emaData || [];
        const ema200Data = data.ema200Data || [];
        const rsiData = data.rsiData || [];
        const macdData = data.macdData || [];

        const support = data.support || Math.min(...lows) * 0.98;
        const resistance = data.resistance || Math.max(...highs) * 1.02;
        const fibonacci = data.fibonacci || calculateFibonacci(highs, lows, closes, 120);

        // === BACKGROUND ===
        const grad = ctx.createLinearGradient(0, 0, 0, this.height);
        grad.addColorStop(0, '#0a0e17');
        grad.addColorStop(1, '#131b2b');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, this.width, this.height);

        // === HEADER ===
        ctx.fillStyle = '#eaecef';
        ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${coin}/USDT`, 30, 42);

        const change = data.change24h || 0;
        const changeColor = change >= 0 ? '#22c55e' : '#ef5350';
        ctx.fillStyle = changeColor;
        ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(`${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, 180, 42);

        ctx.fillStyle = '#6a7a8a';
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(`1h · ${new Date().toISOString().split('T')[0]}`, 290, 42);

        const price = closes[closes.length - 1] || 0;
        ctx.fillStyle = '#eaecef';
        ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`$${price.toFixed(2)}`, this.width - 60, 42);

        // === STATUS BOX ===
        this.drawStatusBox(ctx, coin, patterns, decision);

        // === PRICE CHART ===
        const fibPrices = Array.isArray(fibonacci?.retracements) ? fibonacci.retracements.map(level => level.price) : [];
        const allPrices = [...highs, ...lows, ...emaData, ...ema200Data, support, resistance, ...fibPrices];
        const maxPrice = Math.max(...allPrices) * 1.02;
        const minPrice = Math.min(...allPrices) * 0.98;
        const priceRange = maxPrice - minPrice;

        const candleCount = candles.length || closes.length;
        const candleWidth = Math.min(
            12,
            (this.chartWidth / candleCount) * 0.6
        );
        const spacing =
            (this.chartWidth - candleWidth * candleCount) /
            (candleCount + 1);

        // Grid
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 10; i++) {
            const y = this.padding.top + (this.chartHeight / 10) * i;
            ctx.beginPath();
            ctx.moveTo(this.padding.left, y);
            ctx.lineTo(this.width - this.padding.right, y);
            ctx.stroke();

            const priceLevel = maxPrice - (priceRange / 10) * i;
            ctx.fillStyle = '#6a7a8a';
            ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(priceLevel.toFixed(2), this.padding.left - 12, y + 4);
        }

        // === SUPPORT LINE ===
        const supY = this.padding.top + this.chartHeight - ((support - minPrice) / priceRange) * this.chartHeight;
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.60)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(this.padding.left, supY);
        ctx.lineTo(this.width - this.padding.right, supY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#22c55e';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Support $${support.toFixed(2)}`, this.width - this.padding.right - 200, supY - 10);

        // === RESISTANCE LINE ===
        const resY = this.padding.top + this.chartHeight - ((resistance - minPrice) / priceRange) * this.chartHeight;
        ctx.strokeStyle = 'rgba(239, 83, 80, 0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(this.padding.left, resY);
        ctx.lineTo(this.width - this.padding.right, resY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ef5350';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Resistance $${resistance.toFixed(2)}`, this.width - this.padding.right - 200, resY - 10);

        // === FIBONACCI RETRACEMENT ===
        this.drawFibonacciLevels(ctx, fibonacci, minPrice, priceRange);

        // === CANDLESTICKS ===
        for (let i = 0; i < candleCount; i++) {
            const x = this.padding.left + spacing + i * (candleWidth + spacing);
            const high = highs[i] || 0;
            const low = lows[i] || 0;
            const open = opens[i] || 0;
            const close = closes[i] || 0;

            const yHigh = this.padding.top + this.chartHeight - ((high - minPrice) / priceRange) * this.chartHeight;
            const yLow = this.padding.top + this.chartHeight - ((low - minPrice) / priceRange) * this.chartHeight;
            const yOpen = this.padding.top + this.chartHeight - ((open - minPrice) / priceRange) * this.chartHeight;
            const yClose = this.padding.top + this.chartHeight - ((close - minPrice) / priceRange) * this.chartHeight;

            const isGreen = close >= open;
            const color = isGreen ? '#22c55e' : '#ef5350';
            const fillColor = isGreen ? 'rgba(34, 197, 94, 0.20)' : 'rgba(239, 83, 80, 0.2)';

            // Check if pattern
            const isPattern = (i >= candleCount - 3 && patterns.length > 0);
            const patternColor = isPattern ? '#4fc3f7' : color;
            const patternFill = isPattern ? 'rgba(79, 195, 247, 0.3)' : fillColor;

            // Wick
            ctx.strokeStyle = isPattern ? patternColor : color;
            ctx.lineWidth = isPattern ? 2 : 1.2;
            ctx.beginPath();
            ctx.moveTo(x + candleWidth / 2, yHigh);
            ctx.lineTo(x + candleWidth / 2, yLow);
            ctx.stroke();

            // Body
            const bodyTop = Math.min(yOpen, yClose);
            const bodyBottom = Math.max(yOpen, yClose);
            const bodyHeight = Math.max(2, bodyBottom - bodyTop);

            ctx.fillStyle = isPattern ? patternFill : fillColor;
            ctx.strokeStyle = isPattern ? patternColor : color;
            ctx.lineWidth = isPattern ? 2 : 1.5;

            const radius = Math.min(2, candleWidth / 4);
            ctx.beginPath();
            ctx.moveTo(x + radius, bodyTop);
            ctx.lineTo(x + candleWidth - radius, bodyTop);
            ctx.quadraticCurveTo(x + candleWidth, bodyTop, x + candleWidth, bodyTop + radius);
            ctx.lineTo(x + candleWidth, bodyBottom - radius);
            ctx.quadraticCurveTo(x + candleWidth, bodyBottom, x + candleWidth - radius, bodyBottom);
            ctx.lineTo(x + radius, bodyBottom);
            ctx.quadraticCurveTo(x, bodyBottom, x, bodyBottom - radius);
            ctx.lineTo(x, bodyTop + radius);
            ctx.quadraticCurveTo(x, bodyTop, x + radius, bodyTop);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Pattern label
            if (isPattern && i === candleCount - 1) {
                const labelY = this.padding.top + this.chartHeight - ((high * 1.03 - minPrice) / priceRange) * this.chartHeight;
                ctx.fillStyle = '#4fc3f7';
                ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.textAlign = 'center';
                const names = patterns.slice(0, 3).map(p => p.name).join(' + ');
                ctx.fillText(`⚡ ${names}`, x + candleWidth / 2, labelY - 15);
                ctx.fillStyle = '#4fc3f7';
                ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.fillText('▼', x + candleWidth / 2, labelY + 5);
            }
        }

        // === EMA LINES ===
        const drawLine = (dataArr, color, label, width = 2.5) => {
            if (!dataArr || dataArr.length < 2) return;

            const offset = candleCount - dataArr.length;

            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.beginPath();

            let started = false;

            for (let i = 0; i < dataArr.length; i++) {
                const value = dataArr[i];
                if (value == null || Number.isNaN(value)) continue;

                const candleIndex = i + offset;

                const x =
                    this.padding.left +
                    spacing +
                    candleIndex * (candleWidth + spacing) +
                    candleWidth / 2;

                const y =
                    this.padding.top +
                    this.chartHeight -
                    ((value - minPrice) / priceRange) * this.chartHeight;

                if (!started) {
                    ctx.moveTo(x, y);
                    started = true;
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.stroke();

            const lastValue = dataArr[dataArr.length - 1];
            const lastX =
                this.padding.left +
                spacing +
                (candleCount - 1) * (candleWidth + spacing) +
                candleWidth / 2;

            const lastY =
                this.padding.top +
                this.chartHeight -
                ((lastValue - minPrice) / priceRange) * this.chartHeight;

            ctx.fillStyle = color;
            ctx.font = 'bold 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(label, lastX + 10, lastY - 5);
        };

        if (emaData.length > 0) drawLine(emaData, '#f5a623', 'EMA 50');
        if (ema200Data.length > 0) drawLine(ema200Data, '#b388ff', 'EMA 200', 2);

        // === CURRENT PRICE LINE ===
        if (price > 0) {
            const currentY = this.padding.top + this.chartHeight - ((price - minPrice) / priceRange) * this.chartHeight;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(this.padding.left, currentY);
            ctx.lineTo(this.width - this.padding.right, currentY);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#eaecef';
            ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`$${price.toFixed(2)}`, this.width - this.padding.right, currentY - 10);
        }

        // === VOLUME BARS ===
        if (volumes.length > 0) {
            const volPadding = { top: 25, bottom: 10 };
            const volHeight = 70;
            const volY = this.padding.top + this.chartHeight + volPadding.top;

            ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            ctx.lineWidth = 0.5;
            for (let i = 0; i <= 2; i++) {
                const y = volY + (volHeight / 2) * i;
                ctx.beginPath();
                ctx.moveTo(this.padding.left, y);
                ctx.lineTo(this.width - this.padding.right, y);
                ctx.stroke();
            }

            const maxVolume = Math.max(...volumes) * 1.1;
            for (let i = 0; i < volumes.length; i++) {
                const x = this.padding.left + spacing + i * (candleWidth + spacing);
                const barHeight = (volumes[i] / maxVolume) * volHeight;
                const isGreen = closes[i] >= opens[i];
                ctx.fillStyle = isGreen ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 83, 80, 0.4)';
                ctx.fillRect(x, volY + volHeight - barHeight, candleWidth, barHeight);
            }

            ctx.fillStyle = '#6a7a8a';
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('Volume', this.padding.left, volY + volHeight + 18);
        }

        // === RSI INDICATOR ===
        this.drawRSI(ctx, coin, rsiData, price);

        // === MACD INDICATOR ===
        this.drawMACD(ctx, coin, macdData, price);

        // === PATTERN SUMMARY ===
        this.drawPatternSummary(ctx, patterns, decision);

        // === LEGEND ===
        const legendItems = [
            { label: 'EMA 50', color: '#f5a623' },
            { label: 'EMA 200', color: '#b388ff' },
            { label: 'Support', color: '#22c55e' },
            { label: 'Resistance', color: '#ef5350' },
            { label: 'Fib 0.618', color: '#fbbf24' },
            { label: 'Pattern', color: '#4fc3f7' }
        ];

        let lx = this.padding.left;
        const ly = this.height - 18;
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        legendItems.forEach(item => {
            ctx.fillStyle = item.color;
            ctx.fillRect(lx, ly - 6, 18, 3);
            ctx.fillStyle = '#6a7a8a';
            ctx.textAlign = 'left';
            ctx.fillText(item.label, lx + 22, ly + 2);
            lx += 110;
        });

        const buffer = canvas.toBuffer('image/png');
        const filename = `${coin}_pattern_${Date.now()}.png`;
        const filepath = path.join(__dirname, '../charts', filename);
        fs.writeFileSync(filepath, buffer);
        return filepath;
    }

    drawRSI(ctx, coin, rsiData, price) {
        if (!rsiData || rsiData.length < 14) return;

        const rsiY = this.padding.top + this.chartHeight + 110;
        const rsiHeight = 80;
        const rsiWidth = this.chartWidth + 50;

        // Background
        ctx.fillStyle = 'rgba(19, 27, 43, 0.5)';
        ctx.fillRect(this.padding.left, rsiY, rsiWidth, rsiHeight);

        // Title
        ctx.fillStyle = '#6a7a8a';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        const currentRSI = rsiData[rsiData.length - 1] || 50;
        const rsiColor = currentRSI > 70 ? '#ef5350' : currentRSI < 30 ? '#22c55e' : '#f5a623';
        ctx.fillStyle = rsiColor;
        ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(`RSI: ${currentRSI.toFixed(2)}`, this.padding.left, rsiY + 16);

        ctx.fillStyle = '#6a7a8a';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const rsiStatus = currentRSI > 70 ? 'Overbought' : currentRSI < 30 ? 'Oversold' : 'Neutral';
        ctx.fillText(rsiStatus, this.padding.left + 120, rsiY + 16);

        // RSI line
        const minR = 0;
        const maxR = 100;
        const rRange = maxR - minR;
        const visibleRSI = rsiData.slice(-200);

        ctx.strokeStyle = '#b388ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < visibleRSI.length; i++) {

            const x =
                this.padding.left +
                (i / Math.max(visibleRSI.length - 1, 1)) *
                this.chartWidth;

            const y =
                rsiY +
                20 +
                (rsiHeight - 30) -
                ((visibleRSI[i] - minR) / rRange) *
                (rsiHeight - 30);

            if (i === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }

        ctx.stroke();

        // Overbought/Oversold lines
        ctx.strokeStyle = 'rgba(239, 83, 80, 0.3)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 2]);
        const obY = rsiY + 20 + (rsiHeight - 30) - ((70 - minR) / rRange) * (rsiHeight - 30);
        ctx.beginPath();
        ctx.moveTo(this.padding.left, obY);
        ctx.lineTo(this.padding.left + rsiWidth, obY);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(34, 197, 94, 0.30)';
        const osY = rsiY + 20 + (rsiHeight - 30) - ((30 - minR) / rRange) * (rsiHeight - 30);
        ctx.beginPath();
        ctx.moveTo(this.padding.left, osY);
        ctx.lineTo(this.padding.left + rsiWidth, osY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    drawMACD(ctx, coin, macdData, price) {
        if (!macdData || macdData.length < 26) return;

        const macdY = this.padding.top + this.chartHeight + 200;
        const macdHeight = 80;
        const macdWidth = this.chartWidth;

        // Background
        ctx.fillStyle = 'rgba(19, 27, 43, 0.5)';
        ctx.fillRect(this.padding.left, macdY, macdWidth, macdHeight);

        // Title
        const currentMACD = macdData[macdData.length - 1] || { macd: 0, signal: 0, histogram: 0 };
        ctx.fillStyle = '#f5a623';
        ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`MACD: ${currentMACD.macd?.toFixed(4) || 0}`, this.padding.left, macdY + 16);

        ctx.fillStyle = '#ef5350';
        ctx.fillText(`Signal: ${currentMACD.signal?.toFixed(4) || 0}`, this.padding.left + 200, macdY + 16);

        ctx.fillStyle = '#6a7a8a';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const histColor = currentMACD.histogram >= 0 ? '#22c55e' : '#ef5350';
        ctx.fillStyle = histColor;
        ctx.fillText(`Hist: ${currentMACD.histogram?.toFixed(4) || 0}`, this.padding.left + 380, macdY + 16);

        // MACD line
        const visibleMACD = macdData.slice(-200);
        const macdValues = visibleMACD.map(d => d.macd || 0);
        const signalValues = visibleMACD.map(d => d.signal || 0);
        const histValues = visibleMACD.map(d => d.histogram || 0);

        const allValues = [...macdValues, ...signalValues, ...histValues];
        const maxVal = Math.max(...allValues) * 1.2 || 1;
        const minVal = Math.min(...allValues) * 1.2 || -1;
        const range = maxVal - minVal || 1;

        // Histogram bars
        const barWidth = Math.max(1, (macdWidth / histValues.length) * 0.5);
        for (let i = 0; i < histValues.length; i++) {
            const x = this.padding.left + (i / (histValues.length - 1)) * macdWidth;
            const barH = ((histValues[i] - minVal) / range) * (macdHeight - 30);
            const barY = macdY + 20 + (macdHeight - 30) - barH;
            ctx.fillStyle = histValues[i] >= 0 ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 83, 80, 0.4)';
            ctx.fillRect(x - barWidth / 2, barY, barWidth, Math.abs(barH));
        }

        // MACD line
        ctx.strokeStyle = '#f5a623';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < macdValues.length; i++) {
            const x = this.padding.left + (i / (macdValues.length - 1)) * macdWidth;
            const y = macdY + 20 + (macdHeight - 30) - ((macdValues[i] - minVal) / range) * (macdHeight - 30);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Signal line
        ctx.strokeStyle = '#ef5350';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < signalValues.length; i++) {
            const x = this.padding.left + (i / (signalValues.length - 1)) * macdWidth;
            const y = macdY + 20 + (macdHeight - 30) - ((signalValues[i] - minVal) / range) * (macdHeight - 30);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Zero line
        const zeroY = macdY + 20 + (macdHeight - 30) - ((0 - minVal) / range) * (macdHeight - 30);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(this.padding.left, zeroY);
        ctx.lineTo(this.padding.left + macdWidth, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);
    }


    drawFibonacciLevels(ctx, fibonacci, minPrice, priceRange) {
        if (!fibonacci || !Array.isArray(fibonacci.retracements) || fibonacci.retracements.length === 0) {
            return;
        }

        const highlightRatios = new Set([0.236, 0.382, 0.5, 0.618, 0.786]);
        fibonacci.retracements.forEach(level => {
            if (!highlightRatios.has(Number(level.ratio))) return;
            const py = this.padding.top + this.chartHeight - ((level.price - minPrice) / priceRange) * this.chartHeight;
            const color = Math.abs(level.ratio - 0.618) < 1e-6
                ? 'rgba(251, 191, 36, 0.90)'
                : 'rgba(148, 163, 184, 0.45)';
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.abs(level.ratio - 0.618) < 1e-6 ? 2.1 : 1;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.moveTo(this.padding.left, py);
            ctx.lineTo(this.width - this.padding.right, py);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = color;
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`Fib ${level.ratio.toFixed(3)} · $${Number(level.price).toFixed(4)}`, this.padding.left + 8, py - 6);
        });
    }

    drawStatusBox(ctx, coin, patterns, decision) {
        const boxX = 30;
        const boxY = 70;
        const boxWidth = 340;
        const boxHeight = 110;

        ctx.fillStyle = 'rgba(19, 27, 43, 0.92)';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 20;
        this.roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 10);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        this.roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 10);
        ctx.stroke();

        const action = decision?.action || 'HOLD';
        const confidence = decision?.confidence || 0;
        const actionColor = action === 'BUY' ? '#22c55e' : action === 'SELL' ? '#ef5350' : '#f5a623';

        ctx.fillStyle = actionColor;
        ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(action, boxX + 20, boxY + 42);

        ctx.fillStyle = '#6a7a8a';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(`Confidence: ${confidence}%`, boxX + 150, boxY + 42);

        const required = decision?.requiredPatterns || 3;
        ctx.fillStyle = '#b388ff';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(`${patterns.length}/${required} patterns`, boxX + 20, boxY + 78);

        if (patterns.length > 0) {
            ctx.fillStyle = '#6a7a8a';
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const names = patterns.slice(0, 3).map(p => p.name).join(', ');
            ctx.fillText(names, boxX + 170, boxY + 78);
        }
    }

    drawPatternSummary(ctx, patterns, decision) {
        const boxX = this.width - 380;
        const boxY = 70;
        const boxWidth = 350;
        const boxHeight = Math.max(110, 70 + patterns.length * 32 + 20);

        ctx.fillStyle = 'rgba(19, 27, 43, 0.92)';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 20;
        this.roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 10);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        this.roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 10);
        ctx.stroke();

        ctx.fillStyle = '#6a7a8a';
        ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('DETECTED PATTERNS', boxX + 20, boxY + 30);

        if (patterns.length === 0) {
            ctx.fillStyle = '#6a7a8a';
            ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText('No patterns detected', boxX + 20, boxY + 60);
            return;
        }

        let y = boxY + 55;
        patterns.slice(0, 6).forEach((p) => {
            const color = p.type === 'BULLISH' ? '#22c55e' : p.type === 'BEARISH' ? '#ef5350' : '#f5a623';
            const emoji = p.type === 'BULLISH' ? '🟢' : p.type === 'BEARISH' ? '🔴' : '🟡';

            ctx.fillStyle = color;
            ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(`${emoji} ${p.name}`, boxX + 20, y);

            // Strength bar
            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            ctx.fillRect(boxX + 190, y - 10, 90, 6);
            ctx.fillStyle = color;
            ctx.fillRect(boxX + 190, y - 10, (p.strength / 100) * 90, 6);

            ctx.fillStyle = '#6a7a8a';
            ctx.textAlign = 'right';
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(`${p.strength}%`, boxX + boxWidth - 20, y + 4);
            ctx.textAlign = 'left';

            y += 30;
        });
    }

    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

module.exports = new ChartGenerator();

