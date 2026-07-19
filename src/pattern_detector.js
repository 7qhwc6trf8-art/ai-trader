class PatternDetector {
  constructor() {
    this.patterns = {
      HAMMER: {
        name: 'Hammer',
        type: 'BULLISH',
        confidence: 70
      },

      SHOOTING_STAR: {
        name: 'Shooting Star',
        type: 'BEARISH',
        confidence: 70
      },

      DOJI: {
        name: 'Doji',
        type: 'NEUTRAL',
        confidence: 50
      },

      ENGULFING_BULLISH: {
        name: 'Bullish Engulfing',
        type: 'BULLISH',
        confidence: 80
      },

      ENGULFING_BEARISH: {
        name: 'Bearish Engulfing',
        type: 'BEARISH',
        confidence: 80
      },

      MORNING_STAR: {
        name: 'Morning Star',
        type: 'BULLISH',
        confidence: 85
      },

      EVENING_STAR: {
        name: 'Evening Star',
        type: 'BEARISH',
        confidence: 85
      },

      BULLISH_FLAG: {
        name: 'Bullish Flag',
        type: 'BULLISH',
        confidence: 75
      },

      BEARISH_FLAG: {
        name: 'Bearish Flag',
        type: 'BEARISH',
        confidence: 75
      },

      SUPPORT_BOUNCE: {
        name: 'Support Bounce',
        type: 'BULLISH',
        confidence: 75
      },

      RESISTANCE_REJECT: {
        name: 'Resistance Reject',
        type: 'BEARISH',
        confidence: 75
      },

      BREAKOUT_BULLISH: {
        name: 'Bullish Breakout',
        type: 'BULLISH',
        confidence: 85
      },

      BREAKOUT_BEARISH: {
        name: 'Bearish Breakout',
        type: 'BEARISH',
        confidence: 85
      },

      RSI_OVERSOLD: {
        name: 'RSI Oversold',
        type: 'BULLISH',
        confidence: 80
      },

      RSI_OVERBOUGHT: {
        name: 'RSI Overbought',
        type: 'BEARISH',
        confidence: 80
      },

      MACD_CROSS_BULLISH: {
        name: 'MACD Bullish Cross',
        type: 'BULLISH',
        confidence: 75
      },

      MACD_CROSS_BEARISH: {
        name: 'MACD Bearish Cross',
        type: 'BEARISH',
        confidence: 75
      },

      HEAD_AND_SHOULDERS: {
        name: 'Head and Shoulders',
        type: 'BEARISH',
        confidence: 90
      },

      INVERSE_HEAD_AND_SHOULDERS: {
        name: 'Inverse Head and Shoulders',
        type: 'BULLISH',
        confidence: 90
      }
    };
  }

  // ============================================================
  // MAIN DETECTOR
  // ============================================================

  detectAllPatterns(candles, indicators = {}) {
    const patterns = [];

    if (!candles || candles.length < 3) {
      return patterns;
    }

    const closes = candles.map(c => Number(c[4]));
    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));
    const opens = candles.map(c => Number(c[0]));

    const lastIndex = candles.length - 1;

    const last = {
      open: opens[lastIndex],
      high: highs[lastIndex],
      low: lows[lastIndex],
      close: closes[lastIndex]
    };

    const prev = {
      open: opens[lastIndex - 1],
      high: highs[lastIndex - 1],
      low: lows[lastIndex - 1],
      close: closes[lastIndex - 1]
    };

    const prev2 = {
      open: opens[lastIndex - 2],
      high: highs[lastIndex - 2],
      low: lows[lastIndex - 2],
      close: closes[lastIndex - 2]
    };

    // ============================================================
    // CANDLESTICK PATTERNS
    // ============================================================

    if (this.detectHammer(last, prev)) {
      patterns.push(
        this.createPattern(
          this.patterns.HAMMER,
          this.visualizeHammer(candles)
        )
      );
    }

    if (this.detectShootingStar(last, prev)) {
      patterns.push(
        this.createPattern(
          this.patterns.SHOOTING_STAR,
          this.visualizeShootingStar(candles)
        )
      );
    }

    if (this.detectDoji(last)) {
      patterns.push(
        this.createPattern(
          this.patterns.DOJI,
          this.visualizeDoji(candles)
        )
      );
    }

    if (this.detectBullishEngulfing(last, prev)) {
      patterns.push(
        this.createPattern(
          this.patterns.ENGULFING_BULLISH,
          this.visualizeBullishEngulfing(candles)
        )
      );
    }

    if (this.detectBearishEngulfing(last, prev)) {
      patterns.push(
        this.createPattern(
          this.patterns.ENGULFING_BEARISH,
          this.visualizeBearishEngulfing(candles)
        )
      );
    }

    if (this.detectMorningStar(last, prev, prev2)) {
      patterns.push(
        this.createPattern(
          this.patterns.MORNING_STAR,
          this.visualizeMorningStar(candles)
        )
      );
    }

    if (this.detectEveningStar(last, prev, prev2)) {
      patterns.push(
        this.createPattern(
          this.patterns.EVENING_STAR,
          this.visualizeEveningStar(candles)
        )
      );
    }

    // ============================================================
    // CONTINUATION PATTERNS
    // ============================================================

    if (this.detectBullishFlag(candles)) {
      patterns.push(
        this.createPattern(
          this.patterns.BULLISH_FLAG,
          this.visualizeBullishFlag(candles)
        )
      );
    }

    if (this.detectBearishFlag(candles)) {
      patterns.push(
        this.createPattern(
          this.patterns.BEARISH_FLAG,
          this.visualizeBearishFlag(candles)
        )
      );
    }

    // ============================================================
    // HEAD AND SHOULDERS
    // ============================================================

    const headAndShoulders =
      this.detectHeadAndShoulders(candles);

    if (headAndShoulders) {
      patterns.push(
        this.createPattern(
          this.patterns.HEAD_AND_SHOULDERS,
          headAndShoulders.visualization
        )
      );
    }

    const inverseHeadAndShoulders =
      this.detectInverseHeadAndShoulders(candles);

    if (inverseHeadAndShoulders) {
      patterns.push(
        this.createPattern(
          this.patterns.INVERSE_HEAD_AND_SHOULDERS,
          inverseHeadAndShoulders.visualization
        )
      );
    }

    // ============================================================
    // INDICATORS
    // ============================================================

    if (indicators.rsi < 30) {
      patterns.push(
        this.createPattern(
          this.patterns.RSI_OVERSOLD,
          this.visualizeRSI(candles, 'OVERSOLD')
        )
      );
    }

    if (indicators.rsi > 70) {
      patterns.push(
        this.createPattern(
          this.patterns.RSI_OVERBOUGHT,
          this.visualizeRSI(candles, 'OVERBOUGHT')
        )
      );
    }

    if (
      indicators.macdHistogram > 0 &&
      indicators.macdHistogramPrev < 0
    ) {
      patterns.push(
        this.createPattern(
          this.patterns.MACD_CROSS_BULLISH,
          this.visualizeMACD(candles, 'BULLISH')
        )
      );
    }

    if (
      indicators.macdHistogram < 0 &&
      indicators.macdHistogramPrev > 0
    ) {
      patterns.push(
        this.createPattern(
          this.patterns.MACD_CROSS_BEARISH,
          this.visualizeMACD(candles, 'BEARISH')
        )
      );
    }

    // ============================================================
    // SUPPORT / RESISTANCE
    // ============================================================

    if (
      this.detectSupportBounce(candles, indicators)
    ) {
      patterns.push(
        this.createPattern(
          this.patterns.SUPPORT_BOUNCE,
          this.visualizeSupport(candles, indicators)
        )
      );
    }

    if (
      this.detectResistanceReject(candles, indicators)
    ) {
      patterns.push(
        this.createPattern(
          this.patterns.RESISTANCE_REJECT,
          this.visualizeResistance(candles, indicators)
        )
      );
    }

    if (
      this.detectBullishBreakout(candles, indicators)
    ) {
      patterns.push(
        this.createPattern(
          this.patterns.BREAKOUT_BULLISH,
          this.visualizeBreakout(candles, indicators, 'BULLISH')
        )
      );
    }

    if (
      this.detectBearishBreakout(candles, indicators)
    ) {
      patterns.push(
        this.createPattern(
          this.patterns.BREAKOUT_BEARISH,
          this.visualizeBreakout(candles, indicators, 'BEARISH')
        )
      );
    }

    return patterns;
  }

  // ============================================================
  // PATTERN CREATOR
  // ============================================================

  createPattern(pattern, visualization) {
    return {
      ...pattern,
      visualization
    };
  }

  // ============================================================
  // CANDLE DETECTION
  // ============================================================

  detectHammer(last, prev) {
    const body = Math.abs(last.close - last.open);
    const lowerWick =
      Math.min(last.open, last.close) - last.low;

    const upperWick =
      last.high - Math.max(last.open, last.close);

    const totalRange =
      last.high - last.low;

    if (totalRange <= 0) return false;

    return (
      body < totalRange * 0.3 &&
      lowerWick > body * 2 &&
      upperWick < body &&
      last.close > prev.close
    );
  }

  detectShootingStar(last, prev) {
    const body = Math.abs(last.close - last.open);

    const upperWick =
      last.high - Math.max(last.open, last.close);

    const lowerWick =
      Math.min(last.open, last.close) - last.low;

    const totalRange =
      last.high - last.low;

    if (totalRange <= 0) return false;

    return (
      body < totalRange * 0.3 &&
      upperWick > body * 2 &&
      lowerWick < body &&
      last.close < prev.close
    );
  }

  detectDoji(last) {
    const body =
      Math.abs(last.close - last.open);

    const totalRange =
      last.high - last.low;

    if (totalRange <= 0) return false;

    return body < totalRange * 0.1;
  }

  detectBullishEngulfing(last, prev) {
    return (
      last.close > last.open &&
      prev.close < prev.open &&
      last.open <= prev.close &&
      last.close >= prev.open
    );
  }

  detectBearishEngulfing(last, prev) {
    return (
      last.close < last.open &&
      prev.close > prev.open &&
      last.open >= prev.close &&
      last.close <= prev.open
    );
  }

  detectMorningStar(last, prev, prev2) {
    return (
      prev2.close < prev2.open &&
      Math.abs(prev.close - prev.open) <
        Math.abs(prev2.close - prev2.open) * 0.3 &&
      last.close > last.open &&
      last.close >
        (prev2.open + prev2.close) / 2
    );
  }

  detectEveningStar(last, prev, prev2) {
    return (
      prev2.close > prev2.open &&
      Math.abs(prev.close - prev.open) <
        Math.abs(prev2.close - prev2.open) * 0.3 &&
      last.close < last.open &&
      last.close <
        (prev2.open + prev2.close) / 2
    );
  }

  // ============================================================
  // FLAGS
  // ============================================================

  detectBullishFlag(candles) {
    if (candles.length < 20) return false;

    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));

    const poleHigh =
      Math.max(...highs.slice(-20, -10));

    const poleLow =
      Math.min(...lows.slice(-20, -10));

    const flagHigh =
      Math.max(...highs.slice(-10));

    const flagLow =
      Math.min(...lows.slice(-10));

    const poleRange =
      poleHigh - poleLow;

    const flagRange =
      flagHigh - flagLow;

    if (poleRange <= 0) return false;

    return (
      poleHigh > flagHigh &&
      flagRange < poleRange * 0.5
    );
  }

  detectBearishFlag(candles) {
    if (candles.length < 20) return false;

    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));

    const poleHigh =
      Math.max(...highs.slice(-20, -10));

    const poleLow =
      Math.min(...lows.slice(-20, -10));

    const flagHigh =
      Math.max(...highs.slice(-10));

    const flagLow =
      Math.min(...lows.slice(-10));

    const poleRange =
      poleHigh - poleLow;

    const flagRange =
      flagHigh - flagLow;

    if (poleRange <= 0) return false;

    return (
      poleLow < flagLow &&
      flagRange < poleRange * 0.5
    );
  }

  // ============================================================
  // HEAD AND SHOULDERS
  // ============================================================

  detectHeadAndShoulders(candles) {
    if (candles.length < 30) return null;

    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));

    const start =
      candles.length - 30;

    const section =
      highs.slice(-30);

    const headIndex =
      section.indexOf(Math.max(...section));

    const headPrice =
      section[headIndex];

    const leftSection =
      section.slice(0, headIndex);

    const rightSection =
      section.slice(headIndex + 1);

    if (
      leftSection.length < 5 ||
      rightSection.length < 5
    ) {
      return null;
    }

    const leftShoulderPrice =
      Math.max(...leftSection);

    const rightShoulderPrice =
      Math.max(...rightSection);

    const leftShoulderIndex =
      section.indexOf(leftShoulderPrice);

    const rightShoulderIndex =
      section.lastIndexOf(rightShoulderPrice);

    const leftNeckline =
      Math.min(
        ...lows.slice(
          start + leftShoulderIndex,
          start + headIndex
        )
      );

    const rightNeckline =
      Math.min(
        ...lows.slice(
          start + headIndex,
          start + rightShoulderIndex
        )
      );

    const neckline =
      (leftNeckline + rightNeckline) / 2;

    const validHead =
      headPrice >
      leftShoulderPrice * 1.02 &&
      headPrice >
      rightShoulderPrice * 1.02;

    const shouldersSimilar =
      Math.abs(
        leftShoulderPrice -
        rightShoulderPrice
      ) /
        leftShoulderPrice <
      0.08;

    if (!validHead || !shouldersSimilar) {
      return null;
    }

    const leftIndex =
      start + leftShoulderIndex;

    const headIndexAbsolute =
      start + headIndex;

    const rightIndex =
      start + rightShoulderIndex;

    return {
      visualization: {
        type: 'HEAD_AND_SHOULDERS',

        color: 'red',

        points: {
          leftShoulder: {
            index: leftIndex,
            price: leftShoulderPrice
          },

          head: {
            index: headIndexAbsolute,
            price: headPrice
          },

          rightShoulder: {
            index: rightIndex,
            price: rightShoulderPrice
          }
        },

        neckline: {
          startIndex: leftIndex,
          endIndex: rightIndex,
          startPrice: leftNeckline,
          endPrice: rightNeckline
        },

        polygon: [
          {
            index: leftIndex,
            price: leftShoulderPrice
          },

          {
            index: headIndexAbsolute,
            price: headPrice
          },

          {
            index: rightIndex,
            price: rightShoulderPrice
          },

          {
            index: rightIndex,
            price: neckline
          },

          {
            index: leftIndex,
            price: neckline
          }
        ],

        label: {
          index: headIndexAbsolute,
          price: headPrice * 1.03,
          text: 'HEAD & SHOULDERS'
        }
      }
    };
  }

  // ============================================================
  // INVERSE HEAD AND SHOULDERS
  // ============================================================

  detectInverseHeadAndShoulders(candles) {
    if (candles.length < 30) return null;

    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));

    const start =
      candles.length - 30;

    const section =
      lows.slice(-30);

    const headIndex =
      section.indexOf(Math.min(...section));

    const headPrice =
      section[headIndex];

    const leftSection =
      section.slice(0, headIndex);

    const rightSection =
      section.slice(headIndex + 1);

    if (
      leftSection.length < 5 ||
      rightSection.length < 5
    ) {
      return null;
    }

    const leftShoulderPrice =
      Math.min(...leftSection);

    const rightShoulderPrice =
      Math.min(...rightSection);

    const leftShoulderIndex =
      section.indexOf(leftShoulderPrice);

    const rightShoulderIndex =
      section.lastIndexOf(rightShoulderPrice);

    const leftNeckline =
      Math.max(
        ...highs.slice(
          start + leftShoulderIndex,
          start + headIndex
        )
      );

    const rightNeckline =
      Math.max(
        ...highs.slice(
          start + headIndex,
          start + rightShoulderIndex
        )
      );

    const neckline =
      (leftNeckline + rightNeckline) / 2;

    const validHead =
      headPrice <
      leftShoulderPrice * 0.98 &&
      headPrice <
      rightShoulderPrice * 0.98;

    const shouldersSimilar =
      Math.abs(
        leftShoulderPrice -
        rightShoulderPrice
      ) /
        leftShoulderPrice <
      0.08;

    if (!validHead || !shouldersSimilar) {
      return null;
    }

    const leftIndex =
      start + leftShoulderIndex;

    const headIndexAbsolute =
      start + headIndex;

    const rightIndex =
      start + rightShoulderIndex;

    return {
      visualization: {
        type: 'INVERSE_HEAD_AND_SHOULDERS',

        color: 'green',

        points: {
          leftShoulder: {
            index: leftIndex,
            price: leftShoulderPrice
          },

          head: {
            index: headIndexAbsolute,
            price: headPrice
          },

          rightShoulder: {
            index: rightIndex,
            price: rightShoulderPrice
          }
        },

        neckline: {
          startIndex: leftIndex,
          endIndex: rightIndex,
          startPrice: leftNeckline,
          endPrice: rightNeckline
        },

        polygon: [
          {
            index: leftIndex,
            price: leftShoulderPrice
          },

          {
            index: headIndexAbsolute,
            price: headPrice
          },

          {
            index: rightIndex,
            price: rightShoulderPrice
          },

          {
            index: rightIndex,
            price: neckline
          },

          {
            index: leftIndex,
            price: neckline
          }
        ],

        label: {
          index: headIndexAbsolute,
          price: headPrice * 0.97,
          text: 'INVERSE HEAD & SHOULDERS'
        }
      }
    };
  }

  // ============================================================
  // SUPPORT / RESISTANCE
  // ============================================================

  detectSupportBounce(candles, indicators) {
    if (!candles.length) return false;

    const last =
      candles[candles.length - 1];

    const support =
      indicators.support ||
      Number(last[3]) * 0.97;

    const lastLow =
      Number(last[3]);

    const lastClose =
      Number(last[4]);

    if (!support) return false;

    return (
      Math.abs(lastLow - support) /
        support <
      0.02 &&
      lastClose > lastLow * 1.01
    );
  }

  detectResistanceReject(candles, indicators) {
    if (!candles.length) return false;

    const last =
      candles[candles.length - 1];

    const resistance =
      indicators.resistance ||
      Number(last[2]) * 1.03;

    const lastHigh =
      Number(last[2]);

    const lastClose =
      Number(last[4]);

    if (!resistance) return false;

    return (
      Math.abs(lastHigh - resistance) /
        resistance <
      0.02 &&
      lastClose < lastHigh * 0.99
    );
  }

  detectBullishBreakout(candles, indicators) {
    if (candles.length < 20) return false;

    const highs =
      candles.map(c => Number(c[2]));

    const closes =
      candles.map(c => Number(c[4]));

    const volumes =
      candles.map(c => Number(c[5]));

    const resistance =
      indicators.resistance ||
      Math.max(...highs.slice(-20));

    const avgVolume =
      volumes.reduce((a, b) => a + b, 0) /
      volumes.length;

    return (
      closes.at(-1) > resistance &&
      volumes.at(-1) > avgVolume * 1.5
    );
  }

  detectBearishBreakout(candles, indicators) {
    if (candles.length < 20) return false;

    const lows =
      candles.map(c => Number(c[3]));

    const closes =
      candles.map(c => Number(c[4]));

    const volumes =
      candles.map(c => Number(c[5]));

    const support =
      indicators.support ||
      Math.min(...lows.slice(-20));

    const avgVolume =
      volumes.reduce((a, b) => a + b, 0) /
      volumes.length;

    return (
      closes.at(-1) < support &&
      volumes.at(-1) > avgVolume * 1.5
    );
  }

  // ============================================================
  // VISUALIZATION HELPERS
  // ============================================================

  visualizeHammer(candles) {
    const index =
      candles.length - 1;

    const candle =
      candles[index];

    return {
      type: 'CANDLE',
      color: 'green',

      range: {
        startIndex: index,
        endIndex: index
      },

      label: {
        index,
        price: Number(candle[2]) * 1.01,
        text: 'HAMMER'
      }
    };
  }

  visualizeShootingStar(candles) {
    const index =
      candles.length - 1;

    const candle =
      candles[index];

    return {
      type: 'CANDLE',
      color: 'red',

      range: {
        startIndex: index,
        endIndex: index
      },

      label: {
        index,
        price: Number(candle[2]) * 1.01,
        text: 'SHOOTING STAR'
      }
    };
  }

  visualizeDoji(candles) {
    const index =
      candles.length - 1;

    const candle =
      candles[index];

    return {
      type: 'CANDLE',
      color: 'yellow',

      range: {
        startIndex: index,
        endIndex: index
      },

      label: {
        index,
        price: Number(candle[2]) * 1.01,
        text: 'DOJI'
      }
    };
  }

  visualizeBullishEngulfing(candles) {
    const end =
      candles.length - 1;

    return {
      type: 'ZONE',
      color: 'green',

      range: {
        startIndex: end - 1,
        endIndex: end
      },

      label: {
        index: end,
        price: Number(candles[end][2]) * 1.01,
        text: 'BULLISH ENGULFING'
      }
    };
  }

  visualizeBearishEngulfing(candles) {
    const end =
      candles.length - 1;

    return {
      type: 'ZONE',
      color: 'red',

      range: {
        startIndex: end - 1,
        endIndex: end
      },

      label: {
        index: end,
        price: Number(candles[end][2]) * 1.01,
        text: 'BEARISH ENGULFING'
      }
    };
  }

  visualizeMorningStar(candles) {
    const end =
      candles.length - 1;

    return {
      type: 'ZONE',
      color: 'green',

      range: {
        startIndex: end - 2,
        endIndex: end
      },

      label: {
        index: end - 1,
        price: Number(candles[end][2]) * 1.01,
        text: 'MORNING STAR'
      }
    };
  }

  visualizeEveningStar(candles) {
    const end =
      candles.length - 1;

    return {
      type: 'ZONE',
      color: 'red',

      range: {
        startIndex: end - 2,
        endIndex: end
      },

      label: {
        index: end - 1,
        price: Number(candles[end][2]) * 1.01,
        text: 'EVENING STAR'
      }
    };
  }

  visualizeBullishFlag(candles) {
    const start =
      candles.length - 20;

    const end =
      candles.length - 1;

    const highs =
      candles.map(c => Number(c[2]));

    const lows =
      candles.map(c => Number(c[3]));

    const top =
      Math.max(...highs.slice(start, end + 1));

    const bottom =
      Math.min(...lows.slice(start, end + 1));

    return {
      type: 'POLYGON',
      color: 'green',

      polygon: [
        {
          index: start,
          price: top
        },

        {
          index: start + 10,
          price: top * 0.98
        },

        {
          index: end,
          price: bottom
        },

        {
          index: end,
          price: top
        }
      ],

      label: {
        index: start + 10,
        price: top * 1.02,
        text: 'BULLISH FLAG'
      }
    };
  }

  visualizeBearishFlag(candles) {
    const start =
      candles.length - 20;

    const end =
      candles.length - 1;

    const highs =
      candles.map(c => Number(c[2]));

    const lows =
      candles.map(c => Number(c[3]));

    const top =
      Math.max(...highs.slice(start, end + 1));

    const bottom =
      Math.min(...lows.slice(start, end + 1));

    return {
      type: 'POLYGON',
      color: 'red',

      polygon: [
        {
          index: start,
          price: bottom
        },

        {
          index: start + 10,
          price: bottom * 1.02
        },

        {
          index: end,
          price: top
        },

        {
          index: end,
          price: bottom
        }
      ],

      label: {
        index: start + 10,
        price: bottom * 0.98,
        text: 'BEARISH FLAG'
      }
    };
  }

  visualizeSupport(candles, indicators) {
    const start =
      Math.max(0, candles.length - 20);

    const end =
      candles.length - 1;

    const support =
      indicators.support;

    return {
      type: 'LINE',
      color: 'green',

      line: {
        startIndex: start,
        endIndex: end,
        startPrice: support,
        endPrice: support
      },

      label: {
        index: end,
        price: support,
        text: 'SUPPORT BOUNCE'
      }
    };
  }

  visualizeResistance(candles, indicators) {
    const start =
      Math.max(0, candles.length - 20);

    const end =
      candles.length - 1;

    const resistance =
      indicators.resistance;

    return {
      type: 'LINE',
      color: 'red',

      line: {
        startIndex: start,
        endIndex: end,
        startPrice: resistance,
        endPrice: resistance
      },

      label: {
        index: end,
        price: resistance,
        text: 'RESISTANCE REJECT'
      }
    };
  }

  visualizeBreakout(candles, indicators, direction) {
    const index =
      candles.length - 1;

    const price =
      Number(candles[index][4]);

    return {
      type: 'BREAKOUT',
      color:
        direction === 'BULLISH'
          ? 'green'
          : 'red',

      line: {
        startIndex: Math.max(0, index - 10),
        endIndex: index,
        startPrice: price,
        endPrice: price
      },

      label: {
        index,
        price,
        text:
          direction === 'BULLISH'
            ? 'BULLISH BREAKOUT'
            : 'BEARISH BREAKOUT'
      }
    };
  }

  visualizeRSI(candles, type) {
    const index =
      candles.length - 1;

    const price =
      Number(candles[index][2]);

    return {
      type: 'INDICATOR',
      color:
        type === 'OVERSOLD'
          ? 'green'
          : 'red',

      label: {
        index,
        price,
        text:
          type === 'OVERSOLD'
            ? 'RSI OVERSOLD'
            : 'RSI OVERBOUGHT'
      }
    };
  }

  visualizeMACD(candles, direction) {
    const index =
      candles.length - 1;

    const price =
      Number(candles[index][4]);

    return {
      type: 'INDICATOR',
      color:
        direction === 'BULLISH'
          ? 'green'
          : 'red',

      label: {
        index,
        price,
        text:
          direction === 'BULLISH'
            ? 'MACD BULLISH CROSS'
            : 'MACD BEARISH CROSS'
      }
    };
  }

  // ============================================================
  // SIGNAL
  // ============================================================

  getSignal(patterns, indicators) {
    const bullish =
      patterns.filter(
        p => p.type === 'BULLISH'
      );

    const bearish =
      patterns.filter(
        p => p.type === 'BEARISH'
      );

    let action = 'HOLD';
    let confidence = 30;
    let reasons = [];

    if (
      bullish.length > 0 &&
      bearish.length === 0
    ) {
      const avgConfidence =
        bullish.reduce(
          (sum, p) =>
            sum + p.confidence,
          0
        ) / bullish.length;

      action = 'BUY';

      confidence =
        Math.min(
          95,
          avgConfidence +
            bullish.length * 5
        );

      reasons =
        bullish.map(p => p.name);
    }

    else if (
      bearish.length > 0 &&
      bullish.length === 0
    ) {
      const avgConfidence =
        bearish.reduce(
          (sum, p) =>
            sum + p.confidence,
          0
        ) / bearish.length;

      action = 'SELL';

      confidence =
        Math.min(
          95,
          avgConfidence +
            bearish.length * 5
        );

      reasons =
        bearish.map(p => p.name);
    }

    else if (
      bullish.length > 0 &&
      bearish.length > 0
    ) {
      const bullScore =
        bullish.reduce(
          (sum, p) =>
            sum + p.confidence,
          0
        );

      const bearScore =
        bearish.reduce(
          (sum, p) =>
            sum + p.confidence,
          0
        );

      if (
        bullScore >
        bearScore * 1.2
      ) {
        action = 'BUY';

        confidence =
          Math.min(
            90,
            bullScore /
              bullish.length +
              10
          );

        reasons =
          bullish.map(p => p.name);
      }

      else if (
        bearScore >
        bullScore * 1.2
      ) {
        action = 'SELL';

        confidence =
          Math.min(
            90,
            bearScore /
              bearish.length +
              10
          );

        reasons =
          bearish.map(p => p.name);
      }

      else {
        action = 'HOLD';
        confidence = 50;
        reasons = ['Mixed signals'];
      }
    }

    return {
      action,
      confidence,
      reasons,
      patterns
    };
  }
}

module.exports = PatternDetector;
