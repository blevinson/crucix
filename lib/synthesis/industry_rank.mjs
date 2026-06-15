// Industry HOT/COLD ranker (P5) — deterministic, ranked industry shortlist that
// STEERS the LLM toward long candidates (HOT industries) and short candidates
// (COLD industries), and FEEDS the P2 grounding scorer as a confirmable signal.
//
// ─── HONEST SCOPE (read this before trusting a row) ──────────────────────────
// This is NOT a proven standalone selector. For the great majority of GICS
// industries this is just TWO short-horizon relative-strength signals:
//   1. industry mover-mean  — mean change_pct of today's movers in that industry,
//      z-scored across the day's other industries ("is +4% actually hot, or is the
//      whole tape +4%?").
//   2. parent-sector composite — the industry's GICS sector (d1+d5)/2 from
//      sectorRotation, the coarse rotation tilt.
// COT colors ONLY the handful of industries whose parent sector maps to a tracked
// future (Energy←Crude_WTI, Materials←Gold/Silver). The other ~8 GICS sectors —
// and therefore the vast majority of industries — get NO COT signal at all.
//
// Graphiti memory (qid_brant, node fcfebb36) records that an industry-momentum
// HOTNESS filter "does not add alpha" to a breakout signal in TFARM. So this is
// scoped + labeled as a STEER + CONFIRM that narrows the LLM's choice set, NOT a
// signal with demonstrated edge. Value is measured downstream via the instrumented
// hand-pick account, never asserted here.
//
// DUPLICATION DISCIPLINE: sectorRotation (sector_rank.mjs) ranks the 11 GICS SECTOR
// ETFs by ETF price. This module ranks INDUSTRIES (the free-text tm.industry field —
// "Oil & Gas Exploration & Production", "Entertainment", dozens of buckets finer
// than 11 sectors) by mover change_pct, and only BORROWS the parent-sector composite
// as a tilt input. Different unit of analysis (industry string vs ETF), different
// price source (per-name movers vs ETF closes). We never re-rank the 11 ETFs.
//
// Mirrors sector_rank.mjs / idea_score.mjs style: pure, deterministic, no async,
// no network. Returns null on no input.

// ─── Tunables ───────────────────────────────────────────────────────────────
const _envNum = (v, d) => (v == null || v === '' ? d : Number(v));

// Min movers sharing an industry before it can be RANKED from movers. An industry
// with 1 name is a single stock, not a ranking; 2 is still a coin-flip. Default 3.
const MIN_NAMES = _envNum(process.env.CRUCIX_INDUSTRY_MIN_NAMES, 3);

// Blend weights. Mover-mean leads because it is industry-granular; the sector
// composite is the broader, coarser tilt. Kept as named consts so they are tunable
// without a logic change.
const W_IND = _envNum(process.env.CRUCIX_INDUSTRY_W_IND, 0.7);
const W_SEC = _envNum(process.env.CRUCIX_INDUSTRY_W_SEC, 0.3);

// z thresholds for the HOT / COLD split (a flat industry is neither — we do not
// force a cold label onto an industry that is simply not moving).
const HOT_Z = _envNum(process.env.CRUCIX_INDUSTRY_HOT_Z, 0.5);
const COLD_Z = _envNum(process.env.CRUCIX_INDUSTRY_COLD_Z, -0.5);

// z is estimated from a tiny sample (~5-10 industries); clamp so one outlier can't
// blow up every score. This is a RANKING aid, not a calibrated statistic.
const Z_CLAMP = 3;

// COT touches only the equity sectors with a tracked future. Crude_WTI→Energy,
// Gold/Silver→Materials. The index/FX/rate/ag futures do NOT map to an equity
// industry, so the vast majority of industries get NO COT tag — this is the honest
// scope ceiling. Keyed by GICS SECTOR NAME (the .sector field the movers carry).
const COT_SECTOR = {
  Energy: ['Crude_WTI'],
  Materials: ['Gold', 'Silver'],
};

// GICS sector display NAME → sector ETF symbol. Inverse of sector_rank's
// SECTOR_NAMES; duplicated here (small, stable) so an industry's .sector string can
// look up its parent sector's composite from sectorRotation without an import cycle.
const SECTOR_NAME_TO_ETF = {
  Energy: 'XLE',
  Materials: 'XLB',
  Industrials: 'XLI',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  'Health Care': 'XLV',
  Healthcare: 'XLV',
  Financials: 'XLF',
  'Financial Services': 'XLF',
  Technology: 'XLK',
  'Information Technology': 'XLK',
  'Communication Services': 'XLC',
  Utilities: 'XLU',
  'Real Estate': 'XLRE',
};

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const clampZ = (z) => Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));

// Mean + (population) stdev of a numeric array; {mu, sigma}. sigma 0 when <2 pts.
function meanStd(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { mu: 0, sigma: 0, n: 0 };
  const mu = v.reduce((a, b) => a + b, 0) / v.length;
  if (v.length < 2) return { mu, sigma: 0, n: v.length };
  const variance = v.reduce((a, b) => a + (b - mu) * (b - mu), 0) / v.length;
  return { mu, sigma: Math.sqrt(variance), n: v.length };
}

/**
 * Rank industries HOT / COLD from movers + sector rotation (+ COT where mapped).
 *
 * @param {object} inputs
 * @param {object} inputs.marketMovers  - AlpacaMovers ({gainers,losers,mostActive})
 * @param {object} inputs.sectorRotation - rankSectors() output ({sectors[]})
 * @param {object} inputs.cot           - CFTC_COT ({extreme_long[],extreme_short[]})
 * @param {{topN?:number}} [opts]
 * @returns {{
 *   hot: Array<object>, cold: Array<object>, all: Array<object>,
 *   byIndustry: Object<string,object>,
 *   coverage: {industriesRanked:number, fromMovers:number, fromSectorOnly:number},
 *   degraded: boolean, note: string, basis: string, someCot: boolean, summary: string
 * } | null}
 */
export function rankIndustries(inputs = {}, opts = {}) {
  const topN = opts.topN || 5;
  const marketMovers = inputs.marketMovers || null;
  const sectorRotation = inputs.sectorRotation || null;
  const cot = inputs.cot || null;

  // Nothing to work with at all.
  if (!marketMovers && !sectorRotation) return null;

  const basis =
    'short-horizon momentum: industry mover-mean (z) + parent-sector composite (z); ' +
    'COT only where parent sector ∈ {Energy,Materials}; STEER + CONFIRM, NOT a standalone selector';

  // ── Sector composite (the coarse tilt), z-scored across the 11 GICS sectors ──
  // sectorComposite[ETF] = (d1+d5)/2; then z across sectors so an industry in a
  // leading sector ranks hotter and one in a lagging sector colder.
  const sectorComposite = new Map(); // ETF -> composite
  for (const r of sectorRotation?.sectors || []) {
    if (!r?.symbol) continue;
    const d1 = typeof r.d1 === 'number' ? r.d1 : null;
    const d5 = typeof r.d5 === 'number' ? r.d5 : null;
    if (d1 == null && d5 == null) continue;
    sectorComposite.set(r.symbol, ((d1 ?? d5) + (d5 ?? d1)) / 2);
  }
  const secStats = meanStd([...sectorComposite.values()]);
  const zSectorFor = (etf) => {
    const c = sectorComposite.get(etf);
    if (c == null) return null;
    if (secStats.sigma === 0) return 0;
    return clampZ((c - secStats.mu) / secStats.sigma);
  };

  // ── COT extreme direction per mapped sector ──
  // Parse the "Label=NN%" extreme strings into a direction per tracked future,
  // then attach to the sector(s) that future maps to.
  const cotDir = new Map(); // future label -> 'long' | 'short'
  const parseCot = (arr, dir) => {
    for (const s of arr || []) {
      const m = String(s).match(/^([^=]+)=/);
      if (m) cotDir.set(m[1].trim(), dir);
    }
  };
  parseCot(cot?.extreme_long, 'long');
  parseCot(cot?.extreme_short, 'short');
  const cotTagForSector = (sectorName) => {
    const futures = COT_SECTOR[sectorName];
    if (!futures) return null;
    for (const fut of futures) {
      const dir = cotDir.get(fut);
      if (dir) return `${sectorName}:${fut} crowded-${dir}`;
    }
    return null;
  };

  // ── Group movers by industry ──
  const byInd = new Map(); // industry -> { industry, sector, members:[{symbol,change_pct}] }
  const pushMover = (m) => {
    if (!m || !m.industry) return;
    const ind = m.industry;
    if (!byInd.has(ind)) byInd.set(ind, { industry: ind, sector: m.sector || null, members: [] });
    byInd.get(ind).members.push({ symbol: m.symbol, change_pct: typeof m.change_pct === 'number' ? m.change_pct : null });
  };
  for (const m of marketMovers?.gainers || []) pushMover(m);
  for (const m of marketMovers?.losers || []) pushMover(m);
  for (const m of marketMovers?.mostActive || []) pushMover(m);

  // Keep only industries clearing the min-member guard; compute mover-mean.
  const moverInds = [];
  for (const v of byInd.values()) {
    if (v.members.length < MIN_NAMES) continue;
    const moves = v.members.map((x) => x.change_pct).filter((x) => x != null);
    if (!moves.length) continue;
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
    moverInds.push({
      industry: v.industry,
      sector: v.sector,
      n: v.members.length,
      moverMean: mean,
      symbols: v.members.map((x) => x.symbol),
    });
  }

  // z-score the mover-means across the industries that cleared the guard.
  const indStats = meanStd(moverInds.map((r) => r.moverMean));
  const zIndFor = (mean) => {
    // Need >=3 industries for a meaningful cross-industry z; with only 1-2 the
    // z is degenerate (always 0/±1 regardless of real separation) and would
    // force two near-tied industries into opposite HOT/COLD labels. Fall back
    // to the sector-composite leg only (return 0 = no mover-leg contribution).
    if (moverInds.length < 3 || indStats.sigma === 0) return 0;
    return clampZ((mean - indStats.mu) / indStats.sigma);
  };

  // ── Build the scored rows from movers (the industry-granular path) ──
  const rows = [];
  let someCot = false;
  for (const r of moverInds) {
    const etf = r.sector ? SECTOR_NAME_TO_ETF[r.sector] : null;
    const zSec = etf ? zSectorFor(etf) : null;
    const zInd = zIndFor(r.moverMean);
    // Missing sector leg → fall back to the mover leg alone (degraded blend), the
    // same present-leg fallback sector_rank uses for a missing d1/d5.
    const score = zSec == null ? zInd : W_IND * zInd + W_SEC * zSec;
    const cotTag = r.sector ? cotTagForSector(r.sector) : null;
    if (cotTag) someCot = true;
    rows.push({
      industry: r.industry,
      sector: r.sector,
      n: r.n,
      mean_change_pct: round2(r.moverMean),
      z_industry: round2(zInd),
      z_sector: zSec == null ? null : round2(zSec),
      score: round2(score),
      cot: cotTag,
      symbols: r.symbols.slice(0, 8),
      source: 'movers',
    });
  }

  const fromMovers = rows.length;

  // ── Sparsity back-fill ──
  // The observed-empty failure: a thin sweep (e.g. 3 movers in 3 industries) yields
  // ZERO industries clearing MIN_NAMES, so the mover path is empty. Rather than ship
  // an empty block (the bug P5 exists to fix) OR fabricate industry precision, we
  // synthesize COARSE sector-proxy rows from sectorRotation, flagged source:'sector-proxy'
  // and n:0 so the LLM + scorer KNOW they are sector-derived, not mover-confirmed.
  let fromSectorOnly = 0;
  if (fromMovers < 2 && sectorComposite.size) {
    const seenInd = new Set(rows.map((r) => r.industry));
    for (const [etf, comp] of sectorComposite.entries()) {
      const sectorName =
        Object.keys(SECTOR_NAME_TO_ETF).find((nm) => SECTOR_NAME_TO_ETF[nm] === etf) || etf;
      const industry = `${sectorName} (sector-proxy)`;
      if (seenInd.has(industry)) continue;
      const zSec = zSectorFor(etf);
      const cotTag = cotTagForSector(sectorName);
      if (cotTag) someCot = true;
      rows.push({
        industry,
        sector: sectorName,
        n: 0,
        mean_change_pct: null,
        z_industry: null,
        z_sector: zSec == null ? null : round2(zSec),
        score: zSec == null ? null : round2(zSec), // proxy score = sector z only
        cot: cotTag,
        symbols: [],
        source: 'sector-proxy',
        _comp: comp,
      });
      fromSectorOnly += 1;
    }
  }

  // ── Rank + split ──
  const ranked = rows
    .filter((r) => typeof r.score === 'number')
    .sort((a, b) => b.score - a.score)
    .map(({ _comp, ...r }) => r);

  // Too few rankable industries even after back-fill → honest degraded, not silent empty.
  if (ranked.length < 2) {
    return {
      hot: [],
      cold: [],
      all: ranked,
      byIndustry: Object.fromEntries(ranked.map((r) => [r.industry, r])),
      coverage: { industriesRanked: ranked.length, fromMovers, fromSectorOnly },
      degraded: true,
      note: 'thin snapshot — too few multi-name industries (and no sector proxies) to rank',
      basis,
      someCot,
      summary: 'INDUSTRY_RANK degraded (thin snapshot)',
    };
  }

  const hot = ranked.filter((r) => r.score >= HOT_Z).slice(0, topN);
  const cold = ranked
    .filter((r) => r.score <= COLD_Z)
    .sort((a, b) => a.score - b.score)
    .slice(0, topN);

  const byIndustry = Object.fromEntries(ranked.map((r) => [r.industry, r]));

  const fmt = (r) =>
    `${r.industry}(${r.mean_change_pct == null ? 'proxy' : (r.mean_change_pct >= 0 ? '+' : '') + r.mean_change_pct + '%'} z=${r.score})`;
  const summary =
    `HOT: ${hot.map(fmt).join(', ') || '—'}. COLD: ${cold.map(fmt).join(', ') || '—'}.` +
    (fromSectorOnly ? ` (${fromSectorOnly} sector-proxy, movers thin)` : '');

  return {
    hot,
    cold,
    all: ranked,
    byIndustry,
    coverage: { industriesRanked: ranked.length, fromMovers, fromSectorOnly },
    degraded: false,
    note: fromMovers < 2 ? 'movers thin — ranked from sector proxies' : '',
    basis,
    someCot,
    summary,
  };
}
