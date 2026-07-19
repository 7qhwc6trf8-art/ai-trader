const { createCanvas } = require('./canvas_adapter');
const fs = require('fs');
const path = require('path');
const { calculateFibonacci } = require('./technical_tools');

class PatternVisualizer {
    constructor() {
        this.width = 1600;
        this.height = 1000;
        this.padding = { top: 60, right: 60, bottom: 60, left: 80 };
        this.chartWidth = this.width - this.padding.left - this.padding.right;
        this.chartHeight = this.height - this.padding.top - this.padding.bottom - 200;
    }

    async generatePatternVisualization(coin, data, patterns, decision) {
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

        if (candles.length === 0) {
            return this.generateEmptyChart(ctx, coin);
        }

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
        ctx.fillText(`1h - ${new Date().toISOString().split('T')[0]}`, 290, 42);

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
        const candleWidth = Math.min(10, (this.chartWidth / Math.max(candleCount, 1)) * 0.6);
        const spacing = candleCount > 0 ? (this.chartWidth - (candleWidth * candleCount)) / (candleCount + 1) : 10;

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
        ctx.strokeStyle = 'rgba(0, 188, 213, 0.7)';
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
        ctx.strokeStyle = 'rgba(239, 83, 80, 0.7)';
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

            // Wick
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(x + candleWidth / 2, yHigh);
            ctx.lineTo(x + candleWidth / 2, yLow);
            ctx.stroke();

            // Body
            const bodyTop = Math.min(yOpen, yClose);
            const bodyBottom = Math.max(yOpen, yClose);

            ctx.fillStyle = fillColor;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;

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
        }

        // === PATTERN OVERLAYS (NEW) ===
        this.drawPatternOverlays(ctx, patterns, { candleWidth, spacing, minPrice, priceRange, candleCount });

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
        const filename = `${coin}_patterns_${Date.now()}.png`;
        const chartsDir = path.join(__dirname, '../charts');
        if (!fs.existsSync(chartsDir)) {
            fs.mkdirSync(chartsDir, { recursive: true });
        }
        const filepath = path.join(chartsDir, filename);
        fs.writeFileSync(filepath, buffer);

        // === ZOOM CROPS: one high-quality close-up image per detected pattern ===
        const geo = { candleWidth, spacing, minPrice, priceRange, candleCount };
        const zooms = this.generateZoomCrops(canvas, patterns, geo, coin);

        return { path: filepath, zooms };
    }

    // ============================================================
    // NEW: BOUNDING BOX FOR A SINGLE PATTERN (used to crop zoom images)
    // ============================================================
    getPatternBoundingBox(pattern, geo) {
        const viz = pattern.visualization;
        if (!viz) return null;

        const { candleWidth, spacing, minPrice, priceRange } = geo;
        const mapX = (index) =>
            this.padding.left + spacing + index * (candleWidth + spacing) + candleWidth / 2;
        const mapY = (priceVal) =>
            this.padding.top + this.chartHeight - ((priceVal - minPrice) / priceRange) * this.chartHeight;

        const points = [];
        const add = (index, priceVal) => {
            if (index === undefined || index === null || priceVal === undefined || priceVal === null) return;
            points.push({ x: mapX(index), y: mapY(priceVal) });
        };

        switch (viz.type) {
            case 'LINE':
            case 'BREAKOUT':
                add(viz.line.startIndex, viz.line.startPrice);
                add(viz.line.endIndex, viz.line.endPrice);
                break;

            case 'SWING_LINE':
                (viz.points || []).forEach(pt => add(pt.index, pt.price));
                break;

            case 'PENNANT':
                add(viz.upperLine.startIndex, viz.upperLine.startPrice);
                add(viz.upperLine.endIndex, viz.upperLine.endPrice);
                add(viz.lowerLine.startIndex, viz.lowerLine.startPrice);
                add(viz.lowerLine.endIndex, viz.lowerLine.endPrice);
                break;

            case 'POLYGON':
            case 'HEAD_AND_SHOULDERS':
                (viz.polygon || []).forEach(pt => add(pt.index, pt.price));
                if (viz.neckline) {
                    add(viz.neckline.startIndex, viz.neckline.startPrice);
                    add(viz.neckline.endIndex, viz.neckline.endPrice);
                }
                break;

            case 'ZONE':
                add(viz.range.startIndex, minPrice);
                add(viz.range.endIndex, minPrice + priceRange);
                break;

            case 'CANDLE':
                add(viz.range.startIndex, viz.label ? viz.label.price : (minPrice + priceRange / 2));
                break;

            default:
                break;
        }

        if (viz.label) add(viz.label.index, viz.label.price);

        if (points.length === 0) return null;

        let minXp = Math.min(...points.map(p => p.x));
        let maxXp = Math.max(...points.map(p => p.x));
        let minYp = Math.min(...points.map(p => p.y));
        let maxYp = Math.max(...points.map(p => p.y));

        // breathing room around the pattern so the crop has surrounding context
        const padX = Math.max(70, (maxXp - minXp) * 0.35);
        const padY = Math.max(70, (maxYp - minYp) * 0.5);

        minXp = Math.max(this.padding.left, minXp - padX);
        maxXp = Math.min(this.width - this.padding.right, maxXp + padX);
        minYp = Math.max(this.padding.top, minYp - padY);
        maxYp = Math.min(this.padding.top + this.chartHeight, maxYp + padY);

        let w = maxXp - minXp;
        let h = maxYp - minYp;

        // enforce a sane minimum crop size
        if (w < 140) {
            const cx = (minXp + maxXp) / 2;
            minXp = cx - 70;
            w = 140;
        }
        if (h < 140) {
            const cy = (minYp + maxYp) / 2;
            minYp = cy - 70;
            h = 140;
        }

        return { x: minXp, y: minYp, w, h };
    }

    // ============================================================
    // NEW: GENERATE ONE HIGH-QUALITY ZOOMED IMAGE PER PATTERN
    // ============================================================
    generateZoomCrops(sourceCanvas, patterns, geo, coin) {
        const zooms = [];
        if (!patterns || patterns.length === 0) return zooms;

        const chartsDir = path.join(__dirname, '../charts');
        if (!fs.existsSync(chartsDir)) {
            fs.mkdirSync(chartsDir, { recursive: true });
        }

        const SCALE = 3; // upscale factor -> crisp, high quality zoomed-in image
        const TITLE_H = 54;

        patterns.forEach((pattern, index) => {
            try {
                const box = this.getPatternBoundingBox(pattern, geo);
                if (!box) return;

                const outW = Math.round(box.w * SCALE);
                const outH = Math.round(box.h * SCALE);

                const zoomCanvas = createCanvas(outW, outH + TITLE_H);
                const zctx = zoomCanvas.getContext('2d');
                zctx.imageSmoothingEnabled = true;
                zctx.imageSmoothingQuality = 'high';

                zctx.fillStyle = '#0a0e17';
                zctx.fillRect(0, 0, zoomCanvas.width, zoomCanvas.height);

                // crop the region of interest from the full chart and upscale it
                zctx.drawImage(
                    sourceCanvas,
                    box.x, box.y, box.w, box.h,
                    0, TITLE_H, outW, outH
                );

                // title bar
                zctx.fillStyle = 'rgba(10, 14, 23, 0.95)';
                zctx.fillRect(0, 0, zoomCanvas.width, TITLE_H);
                zctx.strokeStyle = '#4fc3f7';
                zctx.lineWidth = 2;
                zctx.beginPath();
                zctx.moveTo(0, TITLE_H);
                zctx.lineTo(zoomCanvas.width, TITLE_H);
                zctx.stroke();

                zctx.fillStyle = '#4fc3f7';
                zctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                zctx.textAlign = 'left';
                zctx.fillText(`🔍 ${pattern.name || 'Pattern'} — ${coin}/USDT`, 18, 36);

                const buffer = zoomCanvas.toBuffer('image/png');
                const filename = `${coin}_zoom_${index}_${Date.now()}.png`;
                const filepath = path.join(chartsDir, filename);
                fs.writeFileSync(filepath, buffer);

                zooms.push({
                    index,
                    name: pattern.name || `Pattern ${index + 1}`,
                    path: filepath
                });
            } catch (err) {
                // never let a single failed crop break the whole chart response
            }
        });

        return zooms;
    }

    // ============================================================
    // NEW: DRAW EACH DETECTED PATTERN'S SHAPE ON THE CHART
    // ============================================================
    drawPatternOverlays(ctx, patterns, geo) {
        if (!patterns || patterns.length === 0) return;
        const { candleWidth, spacing, minPrice, priceRange } = geo;

        const mapX = (index) =>
            this.padding.left + spacing + index * (candleWidth + spacing) + candleWidth / 2;

        const mapY = (priceVal) =>
            this.padding.top + this.chartHeight - ((priceVal - minPrice) / priceRange) * this.chartHeight;

        const colorMap = {
            green: { stroke: '#00e396', fill: 'rgba(0, 227, 150, 0.15)' },
            red: { stroke: '#ff4560', fill: 'rgba(255, 69, 96, 0.15)' },
            yellow: { stroke: '#f5a623', fill: 'rgba(245, 166, 35, 0.15)' }
        };

        patterns.forEach((pattern) => {
            const viz = pattern.visualization;
            if (!viz) return;

            const c = colorMap[viz.color] || colorMap.yellow;
            ctx.save();

            switch (viz.type) {
                case 'LINE':
                case 'BREAKOUT': {
                    const { startIndex, endIndex, startPrice, endPrice } = viz.line;
                    ctx.strokeStyle = c.stroke;
                    ctx.lineWidth = 2;
                    if (viz.type === 'LINE') ctx.setLineDash([7, 5]);
                    ctx.beginPath();
                    ctx.moveTo(mapX(startIndex), mapY(startPrice));
                    ctx.lineTo(mapX(endIndex), mapY(endPrice));
                    ctx.stroke();
                    ctx.setLineDash([]);
                    break;
                }

                case 'SWING_LINE': {
                    ctx.strokeStyle = c.stroke;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    viz.points.forEach((pt, idx) => {
                        const x = mapX(pt.index), y = mapY(pt.price);
                        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    });
                    ctx.stroke();
                    viz.points.forEach((pt) => {
                        ctx.beginPath();
                        ctx.fillStyle = c.stroke;
                        ctx.arc(mapX(pt.index), mapY(pt.price), 4, 0, Math.PI * 2);
                        ctx.fill();
                    });
                    break;
                }

                case 'PENNANT': {
                    ctx.strokeStyle = c.stroke;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([6, 4]);
                    [viz.upperLine, viz.lowerLine].forEach((line) => {
                        ctx.beginPath();
                        ctx.moveTo(mapX(line.startIndex), mapY(line.startPrice));
                        ctx.lineTo(mapX(line.endIndex), mapY(line.endPrice));
                        ctx.stroke();
                    });
                    ctx.setLineDash([]);

                    // shaded converging wedge
                    ctx.beginPath();
                    ctx.moveTo(mapX(viz.upperLine.startIndex), mapY(viz.upperLine.startPrice));
                    ctx.lineTo(mapX(viz.upperLine.endIndex), mapY(viz.upperLine.endPrice));
                    ctx.lineTo(mapX(viz.lowerLine.endIndex), mapY(viz.lowerLine.endPrice));
                    ctx.lineTo(mapX(viz.lowerLine.startIndex), mapY(viz.lowerLine.startPrice));
                    ctx.closePath();
                    ctx.fillStyle = c.fill;
                    ctx.fill();
                    break;
                }

                case 'POLYGON':
                case 'HEAD_AND_SHOULDERS': {
                    ctx.beginPath();
                    viz.polygon.forEach((pt, idx) => {
                        const x = mapX(pt.index), y = mapY(pt.price);
                        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    });
                    ctx.closePath();
                    ctx.fillStyle = c.fill;
                    ctx.strokeStyle = c.stroke;
                    ctx.lineWidth = 2;
                    ctx.fill();
                    ctx.stroke();

                    if (viz.neckline) {
                        ctx.setLineDash([6, 4]);
                        ctx.beginPath();
                        ctx.moveTo(mapX(viz.neckline.startIndex), mapY(viz.neckline.startPrice));
                        ctx.lineTo(mapX(viz.neckline.endIndex), mapY(viz.neckline.endPrice));
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                    break;
                }

                case 'ZONE': {
                    const { startIndex, endIndex } = viz.range;
                    const x1 = mapX(startIndex) - candleWidth / 2 - spacing / 2;
                    const x2 = mapX(endIndex) + candleWidth / 2 + spacing / 2;
                    ctx.fillStyle = c.fill;
                    ctx.fillRect(x1, this.padding.top, x2 - x1, this.chartHeight);
                    ctx.strokeStyle = c.stroke;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x1, this.padding.top, x2 - x1, this.chartHeight);
                    break;
                }

                case 'CANDLE': {
                    const { startIndex } = viz.range;
                    const x = mapX(startIndex);
                    const y = mapY(viz.label ? viz.label.price : 0);
                    ctx.strokeStyle = c.stroke;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(x, y, 12, 0, Math.PI * 2);
                    ctx.stroke();
                    break;
                }

                default:
                    break;
            }

            // Label for every pattern type that has one
            if (viz.label) {
                const lx = mapX(viz.label.index);
                const ly = mapY(viz.label.price);
                ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                const text = viz.label.text;
                const textWidth = ctx.measureText(text).width;

                ctx.fillStyle = 'rgba(10, 14, 23, 0.8)';
                ctx.fillRect(lx - textWidth / 2 - 6, ly - 18, textWidth + 12, 16);

                ctx.fillStyle = c.stroke;
                ctx.textAlign = 'center';
                ctx.fillText(text, lx, ly - 6);
            }

            ctx.restore();
        });
    }

    drawRSI(ctx, coin, rsiData, price) {
        if (!rsiData || rsiData.length < 14) return;

        const rsiY = this.padding.top + this.chartHeight + 110;
        const rsiHeight = 80;
        const rsiWidth = this.chartWidth + 50;

        ctx.fillStyle = 'rgba(19, 27, 43, 0.6)';
        ctx.fillRect(this.padding.left, rsiY, rsiWidth, rsiHeight);

        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(this.padding.left, rsiY, rsiWidth, rsiHeight);

        const currentRSI = rsiData[rsiData.length - 1] || 50;
        const rsiColor = currentRSI > 70 ? '#ef5350' : currentRSI < 30 ? '#22c55e' : '#f5a623';
        ctx.fillStyle = rsiColor;
        ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`RSI (14): ${currentRSI.toFixed(2)}`, this.padding.left + 15, rsiY + 20);

        ctx.fillStyle = '#6a7a8a';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const rsiStatus = currentRSI > 70 ? 'Overbought' : currentRSI < 30 ? 'Oversold' : 'Neutral';
        ctx.fillText(rsiStatus, this.padding.left + 180, rsiY + 20);

        const minR = 0;
        const maxR = 100;
        const rRange = maxR - minR;
        const visibleRSI = rsiData.slice(-200);

        ctx.strokeStyle = '#b388ff';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let i = 0; i < visibleRSI.length; i++) {
            const x = this.padding.left + 15 + (i / (visibleRSI.length - 1)) * (rsiWidth - 30);
            const y = rsiY + 25 + (rsiHeight - 35) - ((visibleRSI[i] - minR) / rRange) * (rsiHeight - 35);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        const lastX = this.padding.left + 15 + ((visibleRSI.length - 1) / (visibleRSI.length - 1)) * (rsiWidth - 30);
        const lastY = rsiY + 25 + (rsiHeight - 35) - ((visibleRSI[visibleRSI.length - 1] - minR) / rRange) * (rsiHeight - 35);
        ctx.lineTo(lastX, rsiY + 25 + (rsiHeight - 35));
        ctx.lineTo(this.padding.left + 15, rsiY + 25 + (rsiHeight - 35));
        ctx.closePath();
        ctx.fillStyle = 'rgba(179, 136, 255, 0.1)';
        ctx.fill();

        ctx.strokeStyle = 'rgba(239, 83, 80, 0.4)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 3]);
        const obY = rsiY + 25 + (rsiHeight - 35) - ((70 - minR) / rRange) * (rsiHeight - 35);
        ctx.beginPath();
        ctx.moveTo(this.padding.left + 15, obY);
        ctx.lineTo(this.padding.left + rsiWidth - 15, obY);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(34, 197, 94, 0.35)';
        const osY = rsiY + 25 + (rsiHeight - 35) - ((30 - minR) / rRange) * (rsiHeight - 35);
        ctx.beginPath();
        ctx.moveTo(this.padding.left + 15, osY);
        ctx.lineTo(this.padding.left + rsiWidth - 15, osY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(239, 83, 80, 0.5)';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('70', this.padding.left + 10, obY + 3);
        ctx.fillStyle = 'rgba(0, 188, 213, 0.5)';
        ctx.fillText('30', this.padding.left + 10, osY + 3);
    }

    drawMACD(ctx, coin, macdData, price) {
        if (!macdData || macdData.length < 26) return;

        const macdY = this.padding.top + this.chartHeight + 200;
        const macdHeight = 80;
        const macdWidth = this.chartWidth;

        ctx.fillStyle = 'rgba(19, 27, 43, 0.6)';
        ctx.fillRect(this.padding.left, macdY, macdWidth, macdHeight);

        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(this.padding.left, macdY, macdWidth, macdHeight);

        const currentMACD = macdData[macdData.length - 1] || { macd: 0, signal: 0, histogram: 0 };

        ctx.fillStyle = '#f5a623';
        ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`MACD: ${currentMACD.macd?.toFixed(4) || 0}`, this.padding.left + 15, macdY + 20);

        ctx.fillStyle = '#ef5350';
        ctx.fillText(`Signal: ${currentMACD.signal?.toFixed(4) || 0}`, this.padding.left + 200, macdY + 20);

        const histColor = currentMACD.histogram >= 0 ? '#22c55e' : '#ef5350';
        ctx.fillStyle = histColor;
        ctx.fillText(`Hist: ${currentMACD.histogram?.toFixed(4) || 0}`, this.padding.left + 380, macdY + 20);

        const visibleMACD = macdData.slice(-200);
        const macdValues = visibleMACD.map(d => d.macd || 0);
        const signalValues = visibleMACD.map(d => d.signal || 0);
        const histValues = visibleMACD.map(d => d.histogram || 0);

        const allValues = [...macdValues, ...signalValues, ...histValues];
        const maxVal = Math.max(...allValues) * 1.2 || 1;
        const minVal = Math.min(...allValues) * 1.2 || -1;
        const range = maxVal - minVal || 1;

        const barWidth = Math.max(2, (macdWidth / histValues.length) * 0.5);
        for (let i = 0; i < histValues.length; i++) {
            const x = this.padding.left + 15 + (i / (histValues.length - 1)) * (macdWidth - 30);
            const barH = ((histValues[i] - minVal) / range) * (macdHeight - 35);
            const barY = macdY + 25 + (macdHeight - 35) - barH;
            ctx.fillStyle = histValues[i] >= 0 ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 83, 80, 0.4)';
            ctx.fillRect(x - barWidth / 2, barY, barWidth, Math.abs(barH));
        }

        ctx.strokeStyle = '#f5a623';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let i = 0; i < macdValues.length; i++) {
            const x = this.padding.left + 15 + (i / (macdValues.length - 1)) * (macdWidth - 30);
            const y = macdY + 25 + (macdHeight - 35) - ((macdValues[i] - minVal) / range) * (macdHeight - 35);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.strokeStyle = '#ef5350';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let i = 0; i < signalValues.length; i++) {
            const x = this.padding.left + 15 + (i / (signalValues.length - 1)) * (macdWidth - 30);
            const y = macdY + 25 + (macdHeight - 35) - ((signalValues[i] - minVal) / range) * (macdHeight - 35);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        const zeroY = macdY + 25 + (macdHeight - 35) - ((0 - minVal) / range) * (macdHeight - 35);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(this.padding.left + 15, zeroY);
        ctx.lineTo(this.padding.left + macdWidth - 15, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);
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

            ctx.fillStyle = color;
            ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(p.name, boxX + 20, y);

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

    generateEmptyChart(ctx, coin) {
        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, this.width, this.height);

        ctx.fillStyle = '#eaecef';
        ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`No data available for ${coin}`, this.width / 2, this.height / 2);

        ctx.fillStyle = '#6a7a8a';
        ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText('Waiting for market data...', this.width / 2, this.height / 2 + 40);

        // ctx.canvas refers back to the canvas that created this context
        // (the original code referenced a bare `canvas` variable here, which
        // doesn't exist in this method's scope and would throw a ReferenceError)
        const buffer = ctx.canvas.toBuffer('image/png');
        const filename = `${coin}_patterns_empty_${Date.now()}.png`;
        const chartsDir = path.join(__dirname, '../charts');
        if (!fs.existsSync(chartsDir)) {
            fs.mkdirSync(chartsDir, { recursive: true });
        }
        const filepath = path.join(chartsDir, filename);
        fs.writeFileSync(filepath, buffer);
        return { path: filepath, zooms: [] };
    }
}

module.exports = new PatternVisualizer();

