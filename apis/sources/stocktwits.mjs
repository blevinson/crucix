// Stocktwits — retail trader sentiment per ticker
// Public API, no auth required. ~1 req/s rate limit.
// Returns per-ticker bullish/bearish counts from user-tagged messages.

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const BASE = 'https://api.stocktwits.com/api/2/streams/symbol';

const DEFAULT_TICKERS = [
  'KTOS', 'MSTR', 'PLTR', 'SOFI', 'RKLB', 'IONQ', 'BBAI', 'SOUN', 'RGTI',
  'LUNR', 'MARA', 'RIOT', 'SMCI', 'GME', 'TSLA', 'AMD', 'NVDA',
  'BYND', 'OPEN', 'CLOV',
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseEnvTickers() {
  const raw = process.env.CRUCIX_STOCKTWITS_TICKERS;
  if (!raw) return null;
  return raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
}

function compactMessages(messages) {
  if (!messages?.length) return [];
  return messages.slice(0, 20).map(m => ({
    text: (m.body || '').slice(0, 150),
    sentiment: m.entities?.sentiment?.basic || null,
    created: m.created_at || null,
  }));
}

function aggregateSentiment(messages) {
  let bullish = 0, bearish = 0, neutral = 0;
  for (const m of messages) {
    if (m.sentiment === 'Bullish') bullish++;
    else if (m.sentiment === 'Bearish') bearish++;
    else neutral++;
  }
  const tagged = bullish + bearish;
  return {
    bullish,
    bearish,
    neutral,
    total: bullish + bearish + neutral,
    bullishPct: tagged > 0 ? Math.round((bullish / tagged) * 100) : null,
  };
}

export async function getSymbolStream(ticker) {
  return safeFetch(`${BASE}/${encodeURIComponent(ticker)}.json`, {
    headers: { 'User-Agent': 'Crucix/1.0 intelligence-engine' },
  });
}

export async function briefing() {
  const tickers = parseEnvTickers() || DEFAULT_TICKERS;

  const results = {};
  for (const ticker of tickers) {
    const data = await getSymbolStream(ticker);
    const messages = compactMessages(data?.messages || []);
    results[ticker] = {
      ticker,
      messages,
      sentiment: aggregateSentiment(messages),
      watchlistCount: data?.symbol?.watchlist_count ?? null,
    };
    await delay(1100);
  }

  const topTickers = Object.values(results)
    .sort((a, b) => b.sentiment.total - a.sentiment.total)
    .filter(t => t.sentiment.total > 0);

  return {
    source: 'Stocktwits',
    timestamp: new Date().toISOString(),
    tickersQueried: tickers.length,
    tickers: results,
    topByVolume: topTickers.slice(0, 10).map(t => ({
      ticker: t.ticker,
      total: t.sentiment.total,
      bullishPct: t.sentiment.bullishPct,
      watchlistCount: t.watchlistCount,
    })),
  };
}

if (process.argv[1]?.endsWith('stocktwits.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
