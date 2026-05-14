// ApeWisdom — aggregated retail trader mentions across WSB, stocks, investing, options
// No auth required. ~1 req/s. Returns mentions/sentiment/delta per ticker.
// Noisy on 1-letter tickers ('A' = Agilent false positives) — filtered via noise floor.

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const BASE = 'https://apewisdom.io/api/v1.0';

function getNoiseFloor() {
  return parseInt(process.env.CRUCIX_SENTIMENT_NOISE_FLOOR || '5', 10);
}

function compactEntry(entry) {
  return {
    ticker: entry.ticker,
    name: entry.name || null,
    mentions: entry.mentions ?? 0,
    mentionsPrev: entry.mentions_24h_ago ?? 0,
    upvotes: entry.upvotes ?? 0,
    rank: entry.rank ?? null,
  };
}

function applyNoiseFloor(entries, floor) {
  return entries.filter(e => e.mentions >= floor && (e.ticker || '').length > 1);
}

export async function briefing() {
  const noiseFloor = getNoiseFloor();

  const [wsbRaw, allRaw] = await Promise.all([
    safeFetch(`${BASE}/filter/wallstreetbets/page/1`),
    safeFetch(`${BASE}/filter/all/page/1`),
  ]);

  const wsbFiltered = applyNoiseFloor((wsbRaw?.results || []).map(compactEntry), noiseFloor);
  const allFiltered = applyNoiseFloor((allRaw?.results || []).map(compactEntry), noiseFloor);

  const merged = new Map();
  for (const entry of allFiltered) {
    merged.set(entry.ticker, { ...entry, sources: ['all'] });
  }
  for (const entry of wsbFiltered) {
    if (merged.has(entry.ticker)) {
      merged.get(entry.ticker).sources.push('wsb');
      merged.get(entry.ticker).wsbMentions = entry.mentions;
    } else {
      merged.set(entry.ticker, { ...entry, sources: ['wsb'], wsbMentions: entry.mentions });
    }
  }

  const tickers = Array.from(merged.values())
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 50);

  const topMovers = tickers
    .filter(t => t.mentionsPrev > 0)
    .map(t => ({
      ...t,
      delta: t.mentions - t.mentionsPrev,
      deltaPct: Math.round(((t.mentions - t.mentionsPrev) / t.mentionsPrev) * 100),
    }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);

  return {
    source: 'ApeWisdom',
    timestamp: new Date().toISOString(),
    noiseFloor,
    tickers,
    topMovers,
  };
}

if (process.argv[1]?.endsWith('apewisdom.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
