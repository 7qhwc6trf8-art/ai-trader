require('dotenv').config();

class DeepSeekAPI {
  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  }

  async analyze(coin, marketData) {
    if (!this.apiKey) {
      throw new Error('DEEPSEEK_API_KEY is missing');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const system = `You are a disciplined crypto analyst. Return only valid JSON with action, confidence, entryPrice, stopLoss, takeProfit, riskReward, reasoning and patterns.`;
    const prompt = `Analyze ${coin}/USDT using this market packet:
${JSON.stringify(marketData)}
Return BUY, SELL or HOLD. Use realistic levels and never guarantee profit.`;

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
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
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
        throw new Error(`DeepSeek returned non-JSON data (${response.status})`);
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
}

module.exports = new DeepSeekAPI();

