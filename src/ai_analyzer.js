const { getCandles } = require("./market");
const indicators = require("./indicators");
const deepseek = require("./deepseek_api");

async function analyzeWithDeepSeek(coin) {
  const candles = await getCandles(coin);
  const data = indicators(candles);
  
  // Prepare normalized technical data for DeepSeek
  const marketData = {
    price: candles[candles.length-1][4],
    rsi: data.rsi,
    ema: data.ema,
    macd: data.macd,
    bb: data.bb,
    stoch: data.stoch,
    volumeSpike: data.volumeSpike
  };
  
  // Send the packet to DeepSeek
  const result = await deepseek.analyze(coin, marketData);
  
  return {
    coin,
    ...result,
    timestamp: new Date().toISOString()
  };
}

module.exports = { analyzeWithDeepSeek };

