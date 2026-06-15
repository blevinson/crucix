// Yahoo Finance — Live market quotes (no API key required)
// Provides real-time prices for stocks, ETFs, crypto, commodities
// Replaces the need for Alpaca or any paid market data provider

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Symbols to track — covers broad market, rates, commodities, crypto, volatility,
// SPDR sector ETFs (full GICS coverage), and a small large-cap universe used by
// the sector-rotation / trade-ideas pipeline.
const SYMBOLS = {
  // Indexes / ETFs
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq Composite',
  '^DJI': 'Dow Jones',
  '^RUT': 'Russell 2000',
  // Rates / Credit
  TLT: '20Y+ Treasury',
  HYG: 'High Yield Corp',
  LQD: 'IG Corporate',
  // Commodities
  'GC=F': 'Gold',
  'SI=F': 'Silver',
  'CL=F': 'WTI Crude',
  'BZ=F': 'Brent Crude',
  'NG=F': 'Natural Gas',
  // Crypto
  'BTC-USD': 'Bitcoin',
  'ETH-USD': 'Ethereum',
  // Volatility
  '^VIX': 'VIX',
  // SPDR sector ETFs — full 11-sector GICS coverage. Order matches GICS order.
  XLE: 'Energy',
  XLB: 'Materials',
  XLI: 'Industrials',
  XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples',
  XLV: 'Health Care',
  XLF: 'Financials',
  XLK: 'Technology',
  XLC: 'Communication Services',
  XLU: 'Utilities',
  XLRE: 'Real Estate',
  // Mega-cap leaders — cheap proxies for sector flow when the ETFs lag.
  // Kept short on purpose (free Yahoo endpoint, every symbol costs a request).
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  NVDA: 'Nvidia',
  GOOGL: 'Alphabet',
  AMZN: 'Amazon',
  META: 'Meta',
  TSLA: 'Tesla',
  XOM: 'ExxonMobil',
  CVX: 'Chevron',
  JPM: 'JPMorgan',
  UNH: 'UnitedHealth',
  V: 'Visa',
  WMT: 'Walmart',
};

// Sector ETF symbols, in GICS order. Used by the sector-rank synthesis module.
export const SECTOR_ETFS = [
  'XLE', 'XLB', 'XLI', 'XLY', 'XLP', 'XLV', 'XLF', 'XLK', 'XLC', 'XLU', 'XLRE',
];

// Mega-cap single names tracked in the broad sweep — cheap proxies for sector
// flow. Exported so the technicals source can build its candidate universe
// without hand-duplicating the list.
export const EQUITY_NAMES = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'XOM', 'CVX', 'JPM', 'UNH', 'V', 'WMT',
];

// Default technicals universe: sector ETFs + the mega-cap names. The technicals
// source extends this with the day's movers / sector leaders+laggards passed in
// via ctx. Kept distinct from the broad 5d quote sweep so the 1y pulls (heavier)
// are scoped to symbols we actually compute MA200 / 52w / RVOL on.
export const TECHNICALS_BASE_SYMBOLS = [...SECTOR_ETFS, ...EQUITY_NAMES];

// GICS sector membership for the equities tracked here. Hand-maintained — keep
// in sync if SYMBOLS gains tickers. Used to attribute single-name moves to
// their sector when surfacing flow context.
export const SECTOR_BY_SYMBOL = {
  AAPL: 'XLK', MSFT: 'XLK', NVDA: 'XLK',
  GOOGL: 'XLC', META: 'XLC',
  AMZN: 'XLY', TSLA: 'XLY',
  XOM: 'XLE', CVX: 'XLE',
  JPM: 'XLF', V: 'XLF',
  UNH: 'XLV',
  WMT: 'XLP',
};

async function fetchQuote(symbol) {
  try {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
    const data = await safeFetch(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta || {};
    const quotes = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const timestamps = result.timestamp || [];

    // Get current price and true 1-day previous close.
    // meta.chartPreviousClose is the close *before* the range window (not yesterday)
    // so we compute prevClose from the closes array directly.
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const nonNullCloses = closes.filter(c => c != null);
    // When market is open, today's bar close is null — last nonNull is yesterday.
    // When market is closed, last nonNull is today — second-to-last is yesterday.
    const isMarketOpen = meta.marketState === 'REGULAR';
    const prevClose = isMarketOpen
      ? (nonNullCloses[nonNullCloses.length - 1] ?? meta.previousClose)
      : (nonNullCloses[nonNullCloses.length - 2] ?? meta.previousClose ?? meta.chartPreviousClose);
    const change = price && prevClose ? price - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    // Build 5-day history. Entries now carry volume/high/low in addition to
    // close — additive, all existing consumers read only .close so this is safe.
    const history = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) {
        history.push({
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          close: Math.round(closes[i] * 100) / 100,
          volume: volumes[i] != null ? Number(volumes[i]) : null,
          high: highs[i] != null ? Math.round(highs[i] * 100) / 100 : null,
          low: lows[i] != null ? Math.round(lows[i] * 100) / 100 : null,
        });
      }
    }

    return {
      symbol,
      name: SYMBOLS[symbol] || meta.shortName || symbol,
      price: Math.round(price * 100) / 100,
      prevClose: Math.round((prevClose || 0) * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      marketState: meta.marketState || 'UNKNOWN',
      history,
    };
  } catch (e) {
    return { symbol, name: SYMBOLS[symbol] || symbol, error: e.message };
  }
}

// Pull a 1-year daily history for a single symbol, with the OHLCV fields the
// technicals source needs (MA50/MA200, RSI14, RVOL20, 52w hi/lo). Returns an
// array of {date, close, volume, high, low} (volume/high/low may be null on
// gappy bars — the technicals math is null-tolerant). Returns [] on failure.
//
// Kept separate from the broad 5d sweep on purpose: range=1y is ~252 bars per
// symbol, so we only run it for the technicals universe, never the whole sweep.
// Widening fetchQuote() to range=1y would also silently turn sector_rank's
// pct5d (first->last close) into a 1-YEAR return — that function assumes the
// 5d window. Don't do that; use this instead.
export async function fetchHistory1y(symbol) {
  try {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
    const data = await safeFetch(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const quotes = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const timestamps = result.timestamp || [];

    const history = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue; // skip halted/empty bars
      history.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        close: Math.round(closes[i] * 100) / 100,
        volume: volumes[i] != null ? Number(volumes[i]) : null,
        high: highs[i] != null ? Math.round(highs[i] * 100) / 100 : null,
        low: lows[i] != null ? Math.round(lows[i] * 100) / 100 : null,
      });
    }
    return history;
  } catch {
    return [];
  }
}

export async function briefing() {
  return collect();
}

export async function collect() {
  const symbols = Object.keys(SYMBOLS);
  const results = await Promise.allSettled(
    symbols.map(s => fetchQuote(s))
  );

  const quotes = {};
  let ok = 0;
  let failed = 0;

  for (const r of results) {
    const q = r.status === 'fulfilled' ? r.value : null;
    if (q && !q.error) {
      quotes[q.symbol] = q;
      ok++;
    } else {
      failed++;
      const sym = q?.symbol || 'unknown';
      quotes[sym] = q || { symbol: sym, error: 'fetch failed' };
    }
  }

  // Categorize for easy dashboard consumption
  return {
    quotes,
    summary: {
      totalSymbols: symbols.length,
      ok,
      failed,
      timestamp: new Date().toISOString(),
    },
    indexes: pickGroup(quotes, ['^GSPC', '^IXIC', '^DJI', '^RUT']),
    rates: pickGroup(quotes, ['TLT', 'HYG', 'LQD']),
    commodities: pickGroup(quotes, ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'NG=F']),
    crypto: pickGroup(quotes, ['BTC-USD', 'ETH-USD']),
    volatility: pickGroup(quotes, ['^VIX']),
    sectors: pickGroup(quotes, SECTOR_ETFS),
    equities: pickGroup(
      quotes,
      ['AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','XOM','CVX','JPM','UNH','V','WMT']
    ),
  };
}

function pickGroup(quotes, symbols) {
  return symbols.map(s => quotes[s]).filter(Boolean);
}
