const PatternDetector = require('./pattern_detector');
const fs = require('fs');
const path = require('path');

class AITrader {
  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
    this.model = process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'deepseek-chat';
    this.patternDetector = new PatternDetector();
    
    this.systemPrompt = `You are a professional crypto trading analyst with 20+ years experience.
Analyze the market data and patterns provided. Return ONLY valid JSON with:
{
  "action": "BUY/SELL/HOLD",
  "confidence": 0-100,
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit": number,
  "patterns": ["pattern1", "pattern2"],
  "reasoning": "brief explanation",
  "riskReward": number
}`;
  }

  async analyze(coin, candles, indicators) {
    // 1. Detect patterns
    const patterns = this.patternDetector.detectAllPatterns(candles, indicators);
    const signal = this.patternDetector.getSignal(patterns, indicators);
    
    // 2. Prepare data for AI
    const marketData = this.prepareMarketData(coin, candles, indicators, patterns, signal);
    
    // 3. Get AI analysis
    let aiResult = null;
    try {
      aiResult = await this.getAIAnalysis(marketData);
    } catch (error) {
      console.error('AI Analysis failed, using pattern detection:', error.message);
      aiResult = this.getFallbackResult(signal, patterns, indicators);
    }
    
    // 4. Combine pattern detection + AI
    const finalResult = this.combineResults(signal, aiResult, indicators);
    
    // 5. Save to log
    this.saveResult(coin, finalResult, patterns);
    
    return finalResult;
  }

  prepareMarketData(coin, candles, indicators, patterns, signal) {
    const closes = candles.map(c => c[4]);
    const highs = candles.map(c => c[2]);
    const lows = candles.map(c => c[3]);
    const volumes = candles.map(c => c[5]);
    
    const lastPrice = closes[closes.length - 1];
    const priceChange = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100) || 0;
    
    // Get EMA values safely
    const ema50 = typeof indicators.ema === 'number' ? indicators.ema : 
                  (indicators.emaData && indicators.emaData.length > 0 ? indicators.emaData[indicators.emaData.length - 1] : lastPrice);
    const ema200 = typeof indicators.ema200 === 'number' ? indicators.ema200 :
                   (indicators.ema200Data && indicators.ema200Data.length > 0 ? indicators.ema200Data[indicators.ema200Data.length - 1] : lastPrice);
    
    // Get MACD values safely
    const macd = typeof indicators.macd === 'number' ? indicators.macd : 0;
    const macdSignal = typeof indicators.macdSignal === 'number' ? indicators.macdSignal : 0;
    const macdHist = typeof indicators.macdHistogram === 'number' ? indicators.macdHistogram : 0;
    
    // Get BB values
    const bbUpper = indicators.bb?.upper || lastPrice * 1.02;
    const bbLower = indicators.bb?.lower || lastPrice * 0.98;
    
    // Get Stoch values
    const stochK = indicators.stoch?.k || 50;
    const stochD = indicators.stoch?.d || 50;
    
    return {
      coin,
      price: lastPrice,
      priceChange24h: priceChange,
      volume: volumes[volumes.length - 1] || 0,
      avgVolume: volumes.reduce((a,b) => a+b, 0) / volumes.length || 1,
      rsi: typeof indicators.rsi === 'number' ? indicators.rsi : 50,
      ema50: ema50,
      ema200: ema200,
      macd: macd,
      macdSignal: macdSignal,
      macdHistogram: macdHist,
      bbUpper: bbUpper,
      bbLower: bbLower,
      stochK: stochK,
      stochD: stochD,
      support: indicators.support || lastPrice * 0.97,
      resistance: indicators.resistance || lastPrice * 1.03,
      patterns: patterns.map(p => ({ name: p.name, type: p.type, confidence: p.confidence })),
      signal: {
        action: signal.action,
        confidence: signal.confidence,
        reasons: signal.reasons || []
      }
    };
  }

  async getAIAnalysis(marketData) {
    if (!this.apiKey) {
      throw new Error('DEEPSEEK_API_KEY is missing');
    }

    const prompt = this.buildPrompt(marketData);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          stream: false
        })
      });

      const raw = await response.text();
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch (error) {
        throw new Error(`DeepSeek returned invalid JSON (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(payload?.error?.message || `DeepSeek HTTP ${response.status}`);
      }

      let content = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (content.includes('```json')) content = content.split('```json')[1].split('```')[0].trim();
      else if (content.includes('```')) content = content.split('```')[1].split('```')[0].trim();
      if (!content) throw new Error('DeepSeek returned empty content');
      return JSON.parse(content);
    } finally {
      clearTimeout(timeout);
    }
  }

  buildPrompt(data) {
    return `
ANALYZE ${data.coin}/USDT FOR TRADING:

Current Price: $${data.price.toFixed(2)}
24h Change: ${data.priceChange24h.toFixed(2)}%
Volume: ${data.volume.toFixed(0)} (Avg: ${data.avgVolume.toFixed(0)})

TECHNICAL INDICATORS:
• RSI(14): ${data.rsi.toFixed(2)}
• EMA50: $${data.ema50.toFixed(2)}
• EMA200: $${data.ema200.toFixed(2)}
• MACD: ${data.macd.toFixed(4)}
• MACD Signal: ${data.macdSignal.toFixed(4)}
• MACD Histogram: ${data.macdHistogram.toFixed(4)}
• Bollinger Upper: $${data.bbUpper.toFixed(2)}
• Bollinger Lower: $${data.bbLower.toFixed(2)}
• Stochastic K: ${data.stochK.toFixed(2)}
• Stochastic D: ${data.stochD.toFixed(2)}

SUPPORT/RESISTANCE:
• Support: $${data.support.toFixed(2)}
• Resistance: $${data.resistance.toFixed(2)}

DETECTED PATTERNS:
${data.patterns.length > 0 ? data.patterns.map(p => `• ${p.name} (${p.type}) - ${p.confidence}%`).join('\n') : '• No patterns detected'}

PATTERN SIGNAL:
• Action: ${data.signal.action}
• Confidence: ${data.signal.confidence}%
• Reasons: ${data.signal.reasons.join(', ') || 'No specific reasons'}

Provide trading recommendation with entry, stop loss, take profit levels.
Return JSON only.
`;
  }

  combineResults(patternSignal, aiResult, indicators) {
    const price = indicators.price || 0;
    
    // If AI failed, use pattern detection
    if (!aiResult) {
      return {
        action: patternSignal.action,
        confidence: patternSignal.confidence,
        entryPrice: price,
        stopLoss: patternSignal.action === 'BUY' ? price * 0.97 : price * 1.03,
        takeProfit: patternSignal.action === 'BUY' ? price * 1.05 : price * 0.95,
        patterns: patternSignal.patterns || [],
        reasoning: patternSignal.reasons?.join(', ') || 'Pattern-based decision',
        riskReward: 1.67,
        source: 'patterns'
      };
    }

    // Combine AI and pattern detection
    let finalAction = patternSignal.action;
    let finalConfidence = patternSignal.confidence;
    let finalReasoning = [];

    // AI override if confidence is much higher
    if (aiResult.confidence > patternSignal.confidence + 20) {
      finalAction = aiResult.action;
      finalConfidence = aiResult.confidence;
      finalReasoning.push(`AI override: ${aiResult.reasoning}`);
    } else {
      finalReasoning.push(`Pattern: ${patternSignal.reasons?.join(', ') || 'No pattern reasons'}`);
      finalReasoning.push(`AI: ${aiResult.reasoning}`);
    }

    // If both agree, boost confidence
    if (aiResult.action === patternSignal.action && patternSignal.action !== 'HOLD') {
      finalConfidence = Math.min(100, (aiResult.confidence + patternSignal.confidence) / 2 + 10);
      finalReasoning.push('✅ AI + Patterns agree!');
    }

    // If they disagree
    if (aiResult.action !== patternSignal.action && patternSignal.action !== 'HOLD') {
      finalAction = 'HOLD';
      finalConfidence = 50;
      finalReasoning.push('⚠️ AI and Patterns disagree - holding');
    }

    // Use AI levels if available
    const entryPrice = aiResult.entryPrice || price;
    const stopLoss = aiResult.stopLoss || (finalAction === 'BUY' ? price * 0.97 : price * 1.03);
    const takeProfit = aiResult.takeProfit || (finalAction === 'BUY' ? price * 1.05 : price * 0.95);

    // Collect pattern names
    const patternNames = patternSignal.patterns?.map(p => typeof p === 'string' ? p : p.name) || [];

    return {
      action: finalAction,
      confidence: Math.round(Math.min(100, finalConfidence)),
      entryPrice,
      stopLoss,
      takeProfit,
      patterns: patternNames,
      reasoning: finalReasoning.join(' | '),
      riskReward: Math.abs((takeProfit - entryPrice) / (entryPrice - stopLoss)) || 1.0,
      source: 'ai+patterns'
    };
  }

  getFallbackResult(signal, patterns, indicators) {
    const price = indicators.price || 0;
    const patternNames = patterns.map(p => p.name);
    
    return {
      action: signal.action || 'HOLD',
      confidence: signal.confidence || 30,
      entryPrice: price,
      stopLoss: signal.action === 'BUY' ? price * 0.97 : price * 1.03,
      takeProfit: signal.action === 'BUY' ? price * 1.05 : price * 0.95,
      patterns: patternNames,
      reasoning: signal.reasons?.join(', ') || 'Pattern-based decision',
      riskReward: 1.67,
      source: 'patterns'
    };
  }

  saveResult(coin, result, patterns) {
    const log = {
      coin,
      timestamp: new Date().toISOString(),
      action: result.action,
      confidence: result.confidence,
      entryPrice: result.entryPrice,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      patterns: patterns.map(p => p.name),
      reasoning: result.reasoning,
      source: result.source
    };
    
    try {
      const logDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'ai_trades.json'),
        JSON.stringify(log) + '\n'
      );
    } catch (e) {
      console.error('Failed to save log:', e.message);
    }
  }
}

module.exports = new AITrader();
