// Sector rotation synthesis — ranks the 11 GICS sectors by short-term return
// and surfaces top-N / bottom-N for the trade-ideas prompt and dashboard.
//
// Inputs come from apis/sources/yfinance.collect():
//   data.sectors  — array of sector ETF quote objects (symbol, changePct, history[])
//   data.equities — array of mega-cap quote objects (symbol, changePct)
//
// We use 1-day and 5-day return as the two signals. 1-day catches today's flow,
// 5-day filters out noise. A sector is "leading" only if both signals agree —
// strong today AND strong over the week. Otherwise it gets called out as either
// a "fresh move" (1d strong, 5d weak) or "exhausted" (5d strong, 1d weak).

import { SECTOR_BY_SYMBOL } from '../../apis/sources/yfinance.mjs';

// Sector ETF → display name map. Source of truth lives in yfinance.mjs SYMBOLS,
// duplicated here only so the prompt strings can name sectors without a lookup.
const SECTOR_NAMES = {
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
};

function pct5d(quote) {
  // Yahoo's range=5d&interval=1d returns ~5 daily closes. Use the first->last
  // close ratio when we have at least 2 points; otherwise fall back to today's
  // changePct so we don't drop the row entirely.
  const h = quote?.history;
  if (!Array.isArray(h) || h.length < 2) return null;
  const first = h[0]?.close;
  const last = h[h.length - 1]?.close;
  if (first == null || last == null || first === 0) return null;
  return ((last - first) / first) * 100;
}

function classify(d1, d5) {
  if (d1 == null && d5 == null) return 'unknown';
  if (d1 == null) return d5 > 0 ? 'lagging-bullish' : 'lagging-bearish';
  if (d5 == null) return d1 > 0 ? 'fresh-up' : 'fresh-down';
  if (d1 > 0 && d5 > 0) return 'leading';
  if (d1 < 0 && d5 < 0) return 'lagging';
  if (d1 > 0 && d5 < 0) return 'reversal-up'; // up today, down week — possible turn
  return 'reversal-down';                      // down today, up week — possible exhaustion
}

/**
 * Rank sectors and surface top/bottom plus leading single-name flow.
 * @param {object} yfData - return value of yfinance.collect()
 * @param {{topN?: number}} opts
 * @returns {{
 *   sectors: Array<{symbol, name, d1, d5, classification}>,
 *   leading: Array<{symbol, name, d1, d5}>,
 *   lagging: Array<{symbol, name, d1, d5}>,
 *   leadersByName: Array<{symbol, name, sector, d1}>,
 *   laggardsByName: Array<{symbol, name, sector, d1}>,
 *   summary: string,
 * } | null}
 */
export function rankSectors(yfData, opts = {}) {
  const topN = opts.topN || 3;
  if (!yfData?.sectors?.length) return null;

  const rows = yfData.sectors
    .filter(q => q && !q.error)
    .map(q => {
      const d1 = typeof q.changePct === 'number' ? q.changePct : null;
      const d5 = pct5d(q);
      return {
        symbol: q.symbol,
        name: SECTOR_NAMES[q.symbol] || q.name || q.symbol,
        d1,
        d5,
        classification: classify(d1, d5),
      };
    })
    .filter(r => r.d1 != null || r.d5 != null);

  if (!rows.length) return null;

  // Composite score: half weight on today, half on the week. Sectors with a
  // missing leg use whatever they have. Stable sort by composite desc.
  const scored = rows.map(r => ({
    ...r,
    composite:
      ((r.d1 ?? r.d5 ?? 0) + (r.d5 ?? r.d1 ?? 0)) / 2,
  }));
  scored.sort((a, b) => b.composite - a.composite);

  const leading = scored.slice(0, topN).map(({ composite, ...rest }) => rest);
  const lagging = scored.slice(-topN).reverse().map(({ composite, ...rest }) => rest);

  // Single-name flow: rank tracked equities by 1d change, attribute each to its
  // sector. Useful for "energy rally driven by XOM and CVX, not the broader XLE".
  const equities = (yfData.equities || [])
    .filter(q => q && !q.error && typeof q.changePct === 'number')
    .map(q => ({
      symbol: q.symbol,
      name: q.name || q.symbol,
      sector: SECTOR_BY_SYMBOL[q.symbol] || null,
      d1: q.changePct,
    }));

  const leadersByName = [...equities]
    .sort((a, b) => b.d1 - a.d1)
    .slice(0, topN);
  const laggardsByName = [...equities]
    .sort((a, b) => a.d1 - b.d1)
    .slice(0, topN);

  // One-line human-readable summary for the prompt.
  const fmt = (r) =>
    `${r.symbol} ${r.d1 != null ? r.d1.toFixed(2) + '%' : 'n/a'}` +
    (r.d5 != null ? `/${r.d5.toFixed(1)}%5d` : '');
  const summary =
    `Leading: ${leading.map(fmt).join(', ')}. Lagging: ${lagging.map(fmt).join(', ')}.`;

  return {
    sectors: scored.map(({ composite, ...rest }) => rest),
    leading,
    lagging,
    leadersByName,
    laggardsByName,
    summary,
  };
}
