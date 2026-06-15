// Benzinga News — recent headlines tagged with tickers
//
// Tier note: the API key in BENZINGA_API_KEY caps news returns at ~25
// articles per call regardless of pageSize, and the `tickers=` filter only
// returns hits for very-high-volume names (the rest come back empty even
// when they're tagged in articles). So we fetch the latest unfiltered batch
// once, then index locally by ticker. One API call, no rate-limit risk.
//
// Output is shaped for crucix's prompt loop: a flat list of articles plus
// a per-ticker rollup. The rollup is what makes "alpaca says NET dropped
// 24%, benzinga says here's why" possible — caller joins on symbol.

import { safeFetch } from '../utils/fetch.mjs';

// How many articles to fetch per call. The tier caps actual returns at 25,
// so 50 is just a polite "we'd take more if you'd give it." No cost penalty.
const PAGE_SIZE = 50;

// Display modes: 'headline' (~80 char title only — cheap to inject in prompt)
// vs 'abstract' (title + teaser — better for catalyst attribution).
// abstract is the right tradeoff for crucix; the teaser is the WHY.
const DISPLAY = 'abstract';

// Cap rolled-up article count per ticker to keep prompt payload bounded.
const PER_TICKER_LIMIT = 5;

function shapeArticle(a) {
  return {
    id: a.id,
    created: a.created,
    title: a.title,
    teaser: typeof a.teaser === 'string' ? a.teaser.slice(0, 400) : '',
    url: a.url,
    tickers: Array.isArray(a.stocks) ? a.stocks.map(s => s.name).filter(Boolean) : [],
    channels: Array.isArray(a.channels) ? a.channels.map(c => c.name).filter(Boolean) : [],
  };
}

function rollupByTicker(articles) {
  // Map each ticker -> the articles mentioning it (in date desc order, capped).
  // Articles already arrive newest-first from Benzinga.
  const out = new Map();
  for (const a of articles) {
    for (const t of a.tickers) {
      if (!out.has(t)) out.set(t, []);
      const list = out.get(t);
      if (list.length < PER_TICKER_LIMIT) list.push({ id: a.id, title: a.title, teaser: a.teaser, created: a.created, url: a.url });
    }
  }
  // Convert to plain object for JSON-friendliness.
  const obj = {};
  for (const [k, v] of out.entries()) obj[k] = v;
  return obj;
}

export async function collect() {
  const key = process.env.BENZINGA_API_KEY;
  if (!key) {
    return { error: 'BENZINGA_API_KEY not set', articles: [], byTicker: {}, summary: 'no benzinga key' };
  }

  const url =
    `https://api.benzinga.com/api/v2/news` +
    `?token=${encodeURIComponent(key)}` +
    `&pageSize=${PAGE_SIZE}` +
    `&displayOutput=${DISPLAY}`;

  const data = await safeFetch(url, {
    timeout: 10_000,
    headers: { accept: 'application/json' },
  });

  // safeFetch returns { error } on failure; otherwise JSON.parse'd response.
  // Benzinga news is a top-level array on success.
  if (data?.error) {
    return { error: data.error, articles: [], byTicker: {}, summary: `benzinga fetch failed: ${data.error}` };
  }
  if (!Array.isArray(data)) {
    return { error: 'unexpected shape', articles: [], byTicker: {}, summary: 'benzinga returned non-array' };
  }

  const articles = data.map(shapeArticle);
  const byTicker = rollupByTicker(articles);

  const dates = articles.map(a => a.created).filter(Boolean).sort();
  const span =
    dates.length >= 2
      ? `${dates[0]} → ${dates[dates.length - 1]}`
      : (dates[0] || 'no dates');
  const distinctTickers = Object.keys(byTicker).length;
  const summary = `${articles.length} articles, ${distinctTickers} distinct tickers tagged (window: ${span})`;

  return {
    articles,
    byTicker,
    summary,
    asof: new Date().toISOString(),
    config: { pageSize: PAGE_SIZE, display: DISPLAY, perTickerLimit: PER_TICKER_LIMIT },
  };
}

export async function briefing() {
  return collect();
}
