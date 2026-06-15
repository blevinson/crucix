// Equity Technicals — real bar-derived technicals for the candidate universe.
//
// Gives the LLM breakouts / breakdowns / bar-flow instead of just raw big-%
// movers. For each candidate symbol with >=200 daily bars {close,volume,high,low}
// we compute:
//   ma50, ma200            — simple moving averages
//   rsi14                  — Wilder's-smoothed RSI(14)
//   rvol                   — vol[-1] / mean(vol[-20:])  (relative volume)
//   pct_of_52w_high        — close / max(high[-252:]) * 100
//   pct_of_52w_low         — close / min(low[-252:])  * 100
//
// Tags:
//   breakout  = close>ma50 && close>ma200 && pct_of_52w_high>=98  && rvol>=1.5
//   breakdown = close<ma50 && close<ma200 && pct_of_52w_low <=102 && rvol>=1.5
//
// Plus a LIGHT bar-derived flow list (OBV-slope sign and $-volume surge).
// Labeled honestly: this is PRICE/VOLUME-derived flow from daily bars, NOT
// institutional positioning, dark-pool prints, or order-flow imbalance.
//
// Candidate symbols come from ctx (movers + sector leaders/laggards) merged
// with the static technicals base (sector ETFs + mega-caps). History is pulled
// 1y from Yahoo via the shared fetchHistory1y helper in yfinance.mjs.

import { fetchHistory1y, TECHNICALS_BASE_SYMBOLS } from './yfinance.mjs';

const MIN_BARS         = 200;   // need MA200 to be meaningful
const RVOL_LOOKBACK    = 20;    // mean volume window for relative volume
const WIN_52W          = 252;   // trading days in ~1y
const RSI_PERIOD       = 14;
const OBV_SLOPE_WIN    = 20;    // bars for OBV-slope sign
const BREAKOUT_RVOL    = 1.5;
const PCT_52W_HIGH_THR = 98;    // within 2% of the 52w high
const PCT_52W_LOW_THR  = 102;   // within 2% of the 52w low
const FLOW_LIMIT       = 15;
const DOLLAR_VOL_SURGE = 2.0;   // $-vol[-1] / mean($-vol[-20:]) flagged as surge

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function mean(arr) {
  const v = arr.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function sma(values, period) {
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

// Wilder's-smoothed RSI(14). Seeds with the simple average of the first
// `period` gains/losses, then applies Wilder smoothing across the rest.
function rsiWilder(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// On-balance-volume series, then the sign of its slope over the last
// OBV_SLOPE_WIN bars (linear last-vs-first). +1 accumulation, -1 distribution.
function obvSlopeSign(closes, volumes) {
  const n = Math.min(closes.length, volumes.length);
  if (n < OBV_SLOPE_WIN + 1) return 0;
  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const v = volumes[i] != null ? volumes[i] : 0;
    if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + v;
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - v;
    else obv[i] = obv[i - 1];
  }
  const last = obv[n - 1];
  const first = obv[n - 1 - OBV_SLOPE_WIN];
  if (last > first) return 1;
  if (last < first) return -1;
  return 0;
}

// Compute the full technicals block for one symbol's 1y history. Returns null
// if the bar count / data quality is insufficient.
export function computeTechnicals(symbol, history) {
  if (!Array.isArray(history) || history.length < MIN_BARS) return null;

  const closes = history.map(b => b.close).filter(c => c != null && Number.isFinite(c));
  if (closes.length < MIN_BARS) return null;

  const volumes = history.map(b => (b.volume != null ? Number(b.volume) : null));
  const highs = history.map(b => (b.high != null ? b.high : b.close));
  const lows = history.map(b => (b.low != null ? b.low : b.close));

  const close = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const rsi = rsiWilder(closes, RSI_PERIOD);

  // Relative volume: last bar vs the mean of the prior RVOL_LOOKBACK bars.
  const lastVol = volumes[volumes.length - 1];
  const priorVols = volumes.slice(-RVOL_LOOKBACK - 1, -1);
  const meanVol = mean(priorVols);
  const rvol = (lastVol != null && meanVol && meanVol > 0) ? lastVol / meanVol : null;

  // 52-week high/low from the high/low series over the last WIN_52W bars.
  const win = WIN_52W;
  const hiSlice = highs.slice(-win).filter(x => x != null && Number.isFinite(x));
  const loSlice = lows.slice(-win).filter(x => x != null && Number.isFinite(x));
  const hi52 = hiSlice.length ? Math.max(...hiSlice) : null;
  const lo52 = loSlice.length ? Math.min(...loSlice) : null;
  const pct_of_52w_high = (hi52 && hi52 > 0) ? (close / hi52) * 100 : null;
  const pct_of_52w_low = (lo52 && lo52 > 0) ? (close / lo52) * 100 : null;

  return {
    symbol,
    price: r2(close),
    ma50: r2(ma50),
    ma200: r2(ma200),
    rsi: r2(rsi),
    rvol: r2(rvol),
    pct_of_52w_high: r2(pct_of_52w_high),
    pct_of_52w_low: r2(pct_of_52w_low),
    obvSign: obvSlopeSign(closes, volumes.map(v => (v != null ? v : 0))),
    dollarVol: (lastVol != null) ? lastVol * close : null,
    priorDollarVolMean: (meanVol && meanVol > 0) ? meanVol * close : null,
  };
}

function isBreakout(t) {
  return t.price != null && t.ma50 != null && t.ma200 != null &&
    t.pct_of_52w_high != null && t.rvol != null &&
    t.price > t.ma50 && t.price > t.ma200 &&
    t.pct_of_52w_high >= PCT_52W_HIGH_THR && t.rvol >= BREAKOUT_RVOL;
}

function isBreakdown(t) {
  return t.price != null && t.ma50 != null && t.ma200 != null &&
    t.pct_of_52w_low != null && t.rvol != null &&
    t.price < t.ma50 && t.price < t.ma200 &&
    t.pct_of_52w_low <= PCT_52W_LOW_THR && t.rvol >= BREAKOUT_RVOL;
}

// Normalize whatever ctx hands us into a deduped symbol list. Accepts arrays of
// strings or of objects with a .symbol field, plus the static base universe.
function buildUniverse(ctx = {}) {
  // skipBase: supplemental enrichment runs already covered the base universe in
  // the Tier-5 sweep — don't re-fetch all ~24 base 1y histories a second time.
  const out = new Set(ctx.skipBase ? [] : TECHNICALS_BASE_SYMBOLS);
  const add = (item) => {
    if (!item) return;
    const sym = typeof item === 'string' ? item : item.symbol;
    if (sym && typeof sym === 'string') out.add(sym.toUpperCase());
  };
  for (const list of [ctx.candidates, ctx.movers, ctx.leaders, ctx.laggards]) {
    if (Array.isArray(list)) list.forEach(add);
  }
  return [...out];
}

export async function collect(ctx = {}) {
  const universe = buildUniverse(ctx);

  // Pull 1y history per symbol in parallel. fetchHistory1y is failure-tolerant
  // (returns []), so allSettled + the >=MIN_BARS gate handles bad symbols.
  const results = await Promise.allSettled(
    universe.map(async (sym) => {
      // Prefer caller-supplied history (already-fetched extended bars) to avoid
      // a redundant Yahoo round-trip.
      const cached = ctx.historyBySymbol?.[sym];
      const hist = (Array.isArray(cached) && cached.length >= MIN_BARS)
        ? cached
        : await fetchHistory1y(sym);
      return computeTechnicals(sym, hist);
    })
  );

  const techs = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) techs.push(r.value);
  }

  const breakouts = techs
    .filter(isBreakout)
    .sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0))
    .map(t => ({
      symbol: t.symbol,
      price: t.price,
      ma50: t.ma50,
      ma200: t.ma200,
      rsi: t.rsi,
      rvol: t.rvol,
      pct_of_52w_high: t.pct_of_52w_high,
    }));

  const breakdowns = techs
    .filter(isBreakdown)
    .sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0))
    .map(t => ({
      symbol: t.symbol,
      price: t.price,
      ma50: t.ma50,
      ma200: t.ma200,
      rsi: t.rsi,
      rvol: t.rvol,
      pct_of_52w_low: t.pct_of_52w_low,
    }));

  // Light, honestly-labeled bar-derived flow: OBV-slope accumulation/distribution
  // and dollar-volume surges. NOT dark-pool / institutional / order-flow data —
  // purely derived from daily OHLCV bars.
  const flow = [];
  for (const t of techs) {
    const notes = [];
    const dvolSurge = (t.dollarVol != null && t.priorDollarVolMean && t.priorDollarVolMean > 0)
      ? t.dollarVol / t.priorDollarVolMean
      : null;
    if (dvolSurge != null && dvolSurge >= DOLLAR_VOL_SURGE) {
      notes.push(`\$vol-surge ${dvolSurge.toFixed(1)}x`);
    }
    if (t.obvSign > 0 && (t.rvol ?? 0) >= 1.2) {
      notes.push('OBV accumulation');
    } else if (t.obvSign < 0 && (t.rvol ?? 0) >= 1.2) {
      notes.push('OBV distribution');
    }
    if (notes.length) {
      flow.push({ symbol: t.symbol, note: notes.join(', '), rvol: t.rvol });
    }
  }
  flow.sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0));
  const flowOut = flow.slice(0, FLOW_LIMIT).map(({ symbol, note }) => ({ symbol, note }));

  const summary =
    `${breakouts.length} breakouts, ${breakdowns.length} breakdowns, ` +
    `${flowOut.length} flow notes over ${techs.length}/${universe.length} symbols ` +
    `(bar-derived, daily OHLCV — not institutional/dark-pool)`;

  return {
    summary,
    universeSize: universe.length,
    computed: techs.length,
    breakouts,
    breakdowns,
    flow: flowOut,
    method: 'daily-bar technicals (MA50/MA200, RSI14 Wilder, RVOL20, 52w hi/lo, OBV-slope) — NOT institutional/dark-pool flow',
  };
}

export const briefing = collect;
