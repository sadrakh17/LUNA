// market.js
// Fetches real-time market data from free APIs
// CoinGecko for crypto, Yahoo Finance proxy for stocks/forex/commodities
// Results are cached for 3 minutes to avoid rate limits

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const cache = new Map();

function cached(key, fetchFn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fetchFn().then(data => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

// ─── CoinGecko — top crypto prices ───────────────────────────────────────
async function fetchCryptoPrices() {
  return cached('crypto', async () => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,dogecoin&vs_currencies=usd&include_24hr_change=true';
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
    const data = await res.json();

    return {
      BTC:  { price: data.bitcoin?.usd,        change: data.bitcoin?.usd_24h_change },
      ETH:  { price: data.ethereum?.usd,        change: data.ethereum?.usd_24h_change },
      SOL:  { price: data.solana?.usd,          change: data.solana?.usd_24h_change },
      BNB:  { price: data.binancecoin?.usd,     change: data.binancecoin?.usd_24h_change },
      XRP:  { price: data.ripple?.usd,          change: data.ripple?.usd_24h_change },
      DOGE: { price: data.dogecoin?.usd,        change: data.dogecoin?.usd_24h_change },
    };
  });
}

// ─── Yahoo Finance — XAU, DXY, major indices ─────────────────────────────
async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Yahoo error: ${res.status}`);
  const data = await res.json();
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return {
    price: meta.regularMarketPrice,
    change: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
  };
}

async function fetchTraditionalMarkets() {
  return cached('traditional', async () => {
    const [xau, dxy, spx, nas] = await Promise.allSettled([
      fetchYahooQuote('GC=F'),    // Gold/XAU futures
      fetchYahooQuote('DX-Y.NYB'), // DXY Dollar Index
      fetchYahooQuote('^GSPC'),   // S&P 500
      fetchYahooQuote('^IXIC'),   // Nasdaq
    ]);

    return {
      XAU: xau.status === 'fulfilled' ? xau.value : null,
      DXY: dxy.status === 'fulfilled' ? dxy.value : null,
      SPX: spx.status === 'fulfilled' ? spx.value : null,
      NAS: nas.status === 'fulfilled' ? nas.value : null,
    };
  });
}

// ─── Format helpers ───────────────────────────────────────────────────────
function fmt(price, decimals = 2) {
  if (!price) return 'N/A';
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: decimals });
  if (price >= 1) return price.toFixed(decimals);
  return price.toFixed(4);
}

function fmtChange(change) {
  if (change == null) return '';
  const sign = change >= 0 ? '+' : '';
  return ` (${sign}${change.toFixed(2)}%)`;
}

// ─── Detect what markets are relevant to the message ─────────────────────
function detectRelevantMarkets(text) {
  const t = text.toLowerCase();
  const relevant = {
    crypto: false,
    xau: false,
    forex: false,
    indices: false,
  };

  if (/btc|bitcoin|eth|ethereum|sol|solana|bnb|xrp|doge|crypto|altcoin|defi/.test(t)) relevant.crypto = true;
  if (/xau|gold|emas|perak|silver/.test(t)) relevant.xau = true;
  if (/dxy|dollar|dolar|forex|usd|eur|jpy|gbp/.test(t)) relevant.forex = true;
  if (/sp500|s&p|nasdaq|nas|indeks|index|saham|stocks/.test(t)) relevant.indices = true;

  // Geopolitical events affect gold and forex
  if (/iran|war|perang|geopolitik|konflik|opec|fed|inflasi|rate/.test(t)) {
    relevant.xau = true;
    relevant.forex = true;
  }

  return relevant;
}

// ─── Main function: build market context string for Luna's prompt ──────────
export async function getMarketContext(messageText) {
  const relevant = detectRelevantMarkets(messageText);
  const hasAny = Object.values(relevant).some(Boolean);

  if (!hasAny) return ''; // No market keywords — skip fetching

  const lines = [];

  try {
    if (relevant.crypto) {
      const crypto = await fetchCryptoPrices();
      lines.push('=== HARGA CRYPTO SEKARANG (real-time) ===');
      if (crypto.BTC?.price)  lines.push(`BTC: $${fmt(crypto.BTC.price)}${fmtChange(crypto.BTC.change)}`);
      if (crypto.ETH?.price)  lines.push(`ETH: $${fmt(crypto.ETH.price)}${fmtChange(crypto.ETH.change)}`);
      if (crypto.SOL?.price)  lines.push(`SOL: $${fmt(crypto.SOL.price)}${fmtChange(crypto.SOL.change)}`);
      if (crypto.BNB?.price)  lines.push(`BNB: $${fmt(crypto.BNB.price)}${fmtChange(crypto.BNB.change)}`);
      if (crypto.XRP?.price)  lines.push(`XRP: $${fmt(crypto.XRP.price)}${fmtChange(crypto.XRP.change)}`);
      if (crypto.DOGE?.price) lines.push(`DOGE: $${fmt(crypto.DOGE.price, 4)}${fmtChange(crypto.DOGE.change)}`);
    }

    if (relevant.xau || relevant.forex || relevant.indices) {
      const trad = await fetchTraditionalMarkets();
      if ((relevant.xau) && trad.XAU?.price)       lines.push(`XAU/USD: $${fmt(trad.XAU.price)}${fmtChange(trad.XAU.change)}`);
      if ((relevant.forex) && trad.DXY?.price)      lines.push(`DXY: ${fmt(trad.DXY.price)}${fmtChange(trad.DXY.change)}`);
      if ((relevant.indices) && trad.SPX?.price)    lines.push(`S&P 500: ${fmt(trad.SPX.price)}${fmtChange(trad.SPX.change)}`);
      if ((relevant.indices) && trad.NAS?.price)    lines.push(`Nasdaq: ${fmt(trad.NAS.price)}${fmtChange(trad.NAS.change)}`);
    }
  } catch (err) {
    console.error('[Market] Fetch error (non-fatal):', err.message);
    return ''; // Silently fail — Luna will just not have price data
  }

  if (lines.length === 0) return '';

  return '\n' + lines.join('\n') + '\nGunakan data ini kalau relevan dengan percakapan. Jangan sebutkan sumbernya.\n';
}
